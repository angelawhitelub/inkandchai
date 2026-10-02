const test=require('node:test');const assert=require('node:assert/strict');
const {threadPage,customerDetails}=require('../../netlify/functions/utils/inbox-history');
function database(tables){return {from(name){let rows=[...(tables[name]||[])],sorts=[];const q={select(){return q},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},ilike(){return q},lte(k,v){rows=rows.filter(r=>r[k]<=v);return q},order(k,opt){sorts.push([k,opt.ascending]);return q},range(a,b){rows.sort((x,y)=>{for(const [k,asc]of sorts){if(x[k]!==y[k])return (x[k]>y[k]?1:-1)*(asc?1:-1);}return 0});return Promise.resolve({data:rows.slice(a,b+1)})},maybeSingle:async()=>({data:rows[0]||null})};return q;}};}
test('full history crosses 200-message boundary with all roles and phone formats',async()=>{
 const messages=Array.from({length:451},(_,i)=>({id:String(i).padStart(4,'0'),customer_phone:i%2?'919876543210':'9876543210',role:['user','bot','admin'][i%3],created_at:new Date(1700000000000+i*1000).toISOString(),message:'Message '+i}));
 const db=database({bot_messages:[...messages,{id:'other',customer_phone:'911234567890',created_at:messages[0].created_at}]});let offset=0,snapshot,all=[];
 do{const page=await threadPage(db,'919876543210',{offset,snapshot});all.unshift(...page.messages);offset=page.next_offset;snapshot=page.snapshot;}while(offset!==null);
 assert.deepEqual(all,messages);assert.equal(new Set(all.map(m=>m.id)).size,451);
});
test('snapshot excludes new arrivals while paging older messages',async()=>{
 const data=[{id:'1',customer_phone:'9876543210',created_at:'2026-01-01T00:00:00.000Z'},{id:'2',customer_phone:'9876543210',created_at:'2026-01-03T00:00:00.000Z'}];
 const page=await threadPage(database({bot_messages:data}),'9876543210',{snapshot:'2026-01-02T00:00:00.000Z'});assert.deepEqual(page.messages,[data[0]]);
});
test('customer panel filters unrelated numbers and returns only display fields',async()=>{
 const order={id:'1',razorpay_order_id:'IC-ONE',customer_phone:'+91 98765 43210',customer_name:'Example Reader',customer_email:'reader@example.test',customer_address:'Sample address',created_at:'2026-01-01',amount_paise:29900,status:'delivered',cart_items:[{title:'Book',qty:2,_payment:{private:'not for inbox'}}],secret:'hidden'};
 const d=await customerDetails(database({orders:[order,{...order,id:'2',customer_phone:'1234567890'}]}),'919876543210');assert.equal(d.name,'Example Reader');assert.equal(d.orders.length,1);assert.equal(d.orders[0].total,299);assert.deepEqual(d.orders[0].items,[{title:'Book',qty:2}]);assert(!JSON.stringify(d).includes('private'));
});
test('admin authorization precedes customer data queries',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');let queried=false;const sandbox={exports:{},process:{env:{}},console,require(name){if(name==='@supabase/supabase-js')return {createClient(){queried=true;throw Error('must not run')}};if(name==='./utils/admin-auth')return {requireAdmin:()=>({statusCode:401})};return {};}};
 vm.runInNewContext(fs.readFileSync('netlify/functions/bot-inbox.js','utf8'),sandbox);
 assert.equal((await sandbox.exports.handler({httpMethod:'GET',queryStringParameters:{action:'customer',phone:'919876543210'}})).statusCode,401);assert.equal(queried,false);
});
