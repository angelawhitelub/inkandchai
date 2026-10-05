const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const helper=require('../../netlify/functions/utils/inbox-summary');
const phone='919876543210';
function database(tables){return {from(name){let rows=[...(tables[name]||[])],sorts=[];const q={select(){return q},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},ilike(){return q},lte(k,v){rows=rows.filter(r=>r[k]<=v);return q},order(k,opt){sorts.push([k,opt.ascending]);return q},range(a,b){rows.sort((x,y)=>{for(const [k,asc]of sorts){if(x[k]!==y[k])return (x[k]>y[k]?1:-1)*(asc?1:-1);}return 0});return Promise.resolve({data:rows.slice(a,b+1)})},maybeSingle:async()=>({data:rows[0]||null})};return q;}};}
const messages=(n=3)=>Array.from({length:n},(_,i)=>({id:String(i).padStart(4,'0'),customer_phone:i%2?phone:'9876543210',role:['user','bot','admin'][i%3],created_at:new Date(1700000000000+i*1000).toISOString(),message:'Message '+i}));
const order={id:'o1',customer_phone:phone,razorpay_order_id:'IC-EXAMPLE',status:'shipped',created_at:'2026-01-01',customer_name:'Example Reader',customer_email:'private@example.test',customer_address:'Private address',amount_paise:29900,cart_items:[{title:'Book',qty:1,_private:'secret'}]};
const report={issue:'Customer reports a missed pickup.',requested_outcome:'Wants a delivery update.',current_status:'Pickup not verified.',history:['Customer reported a delay.'],next_steps:['Check courier pickup.'],verify:['Bot gave conflicting explanations.'],order_ids:['IC-EXAMPLE','INVENTED-ORDER']};
const response=()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(report)}}]})});

test('context includes all chat roles, pages history and isolates the selected phone',async()=>{
 const rows=messages(451),db=database({bot_messages:[...rows,{...rows[0],customer_phone:'911234567890',message:'Another customer secret'}],orders:[order]});
 const context=await helper.readContext(db,phone);assert.equal(context.messages.length,451);assert.equal(context.messages[0].text,'Message 0');assert.equal(context.messages.at(-1).text,'Message 450');assert.deepEqual(context.messages.slice(0,3).map(m=>m.role),['customer','bot','employee']);assert.equal(context.history_limited,false);
 const body=JSON.stringify(context);for(const hidden of ['Another customer secret','private@example.test','Private address','_private'])assert(!body.includes(hidden));assert.equal(context.orders[0].id,'IC-EXAMPLE');
});
test('long history is bounded, preserves newest context and reports exclusions',async()=>{
 const rows=messages(1100),context=await helper.readContext(database({bot_messages:rows}),phone);assert.equal(context.messages.length,1000);assert.equal(context.messages[0].text,'Message 100');assert.equal(context.messages.at(-1).text,'Message 1099');assert.equal(context.history_limited,true);
 const long=messages(20).map(m=>({...m,message:'x'.repeat(7000)}));const clipped=await helper.readContext(database({bot_messages:long}),phone);assert.equal(clipped.history_limited,true);assert(clipped.messages.reduce((n,m)=>n+m.text.length,0)<=60000);
});
test('empty history makes no AI request',async()=>{process.env.OPENAI_API_KEY='fixture-key';await assert.rejects(helper.summariseConversation(database({}),phone),e=>e.statusCode===422);});
test('validates phone before reading private data',async()=>{let touched=false;await assert.rejects(helper.summariseConversation({from(){touched=true}},'invalid'),e=>e.statusCode===400);assert.equal(touched,false);});
test('uses existing OpenAI config without tools, caches identical records, invalidates new messages',async()=>{
 process.env.OPENAI_API_KEY='fixture-key';process.env.OPENAI_INSIGHTS_MODEL='gpt-4.1';let calls=0,payload;const originalFetch=global.fetch;global.fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/chat/completions');payload=JSON.parse(options.body);return response()};
 try{const tables={bot_messages:messages(),orders:[order]},db=database(tables);
 const [a,b]=await Promise.all([helper.summariseConversation(db,phone),helper.summariseConversation(db,phone)]);assert.equal(calls,1);assert.deepEqual(a.summary,b.summary);assert.deepEqual(a.summary.order_ids,['IC-EXAMPLE']);assert.equal(payload.model,'gpt-4.1');assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.equal(payload.response_format.json_schema.strict,true);assert.match(payload.messages[0].content,/untrusted evidence/);
 assert.equal((await helper.summariseConversation(db,phone)).cached,true);assert.equal(calls,1);
 tables.bot_messages.push({...messages(4)[3],message:'New unresolved refund issue'});await helper.summariseConversation(database(tables),phone);assert.equal(calls,2);
 }finally{global.fetch=originalFetch;delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_INSIGHTS_MODEL;}
});
test('refusal, incomplete output, malformed JSON and provider errors cannot look like summaries',async()=>{
 for(const choice of [{finish_reason:'length',message:{content:'{}'}},{finish_reason:'stop',message:{refusal:'No'}},{finish_reason:'stop',message:{content:'no JSON'}},{finish_reason:'stop',message:{content:'{}'}}])assert.throws(()=>helper.parseSummary({choices:[choice]}));
 process.env.OPENAI_API_KEY='fixture-key';const originalFetch=global.fetch;global.fetch=async()=>({ok:false,status:429});
 try{await assert.rejects(helper.summariseConversation(database({bot_messages:messages(2)}),phone),e=>e.statusCode===429&&!e.message.includes('fixture-key'));}finally{global.fetch=originalFetch;delete process.env.OPENAI_API_KEY;}
});
test('admin auth runs before summary data access; GET cannot generate a summary',async()=>{
 let touched=false;const sandbox={exports:{},process:{env:{}},console,require(name){if(name==='@supabase/supabase-js')return {createClient(){touched=true;throw Error('not allowed')}};if(name==='./utils/admin-auth')return {requireAdmin:()=>({statusCode:401})};return {};}};
 vm.runInNewContext(fs.readFileSync('netlify/functions/bot-inbox.js','utf8'),sandbox);assert.equal((await sandbox.exports.handler({httpMethod:'POST',body:JSON.stringify({action:'summarise',phone})})).statusCode,401);assert.equal(touched,false);
 let aiCalls=0;sandbox.require=name=>name==='@supabase/supabase-js'?{createClient:()=>({})}:name==='./utils/admin-auth'?{requireAdmin:()=>null}:name==='./utils/inbox-summary'?{summariseConversation:async()=>{aiCalls++;return {summary:report}}}:{};
 vm.runInNewContext(fs.readFileSync('netlify/functions/bot-inbox.js','utf8'),{...sandbox,exports:sandbox.exports={}});
 assert.equal((await sandbox.exports.handler({httpMethod:'GET',queryStringParameters:{action:'summarise',phone}})).statusCode,400);assert.equal(aiCalls,0);
 assert.equal((await sandbox.exports.handler({httpMethod:'POST',body:JSON.stringify({action:'summarise',phone})})).statusCode,200);assert.equal(aiCalls,1);
});
test('support employees can summarise with their existing inbox permission',async()=>{
 const auth=require('../../netlify/functions/utils/admin-auth');
 const oldSecret=process.env.ADMIN_TOKEN_SECRET;process.env.ADMIN_TOKEN_SECRET='summary-test-signing-secret';
 try {
  let aiCalls=0;
  const sandbox={exports:{},process:{env:{}},console,require(name){
   if(name==='@supabase/supabase-js')return {createClient:()=>({})};
   if(name==='./utils/admin-auth')return auth;
   if(name==='./utils/inbox-summary')return {summariseConversation:async()=>{aiCalls++;return {summary:report}}};
   return {};
  }};
  vm.runInNewContext(fs.readFileSync('netlify/functions/bot-inbox.js','utf8'),sandbox);
  const request={path:'/.netlify/functions/bot-inbox',httpMethod:'POST',body:JSON.stringify({action:'summarise',phone}),headers:{'x-admin-token':auth.signAdminToken({sub:'staff:test',role:'support'})}};
  assert.equal((await sandbox.exports.handler(request)).statusCode,200);assert.equal(aiCalls,1);
  request.headers['x-admin-token']=auth.signAdminToken({sub:'staff:test',role:'unauthorised'});
  assert.equal((await sandbox.exports.handler(request)).statusCode,403);assert.equal(aiCalls,1);
 } finally {if(oldSecret===undefined)delete process.env.ADMIN_TOKEN_SECRET;else process.env.ADMIN_TOKEN_SECRET=oldSecret;}
});
