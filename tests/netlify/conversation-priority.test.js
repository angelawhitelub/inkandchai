const test=require('node:test'),assert=require('node:assert/strict');
const {category,canAutoClose,contextFor,categorizeConversations,isClosureCandidate}=require('../../netlify/functions/utils/conversation-priority');
const msg=(message,role='user')=>({role,message,created_at:new Date().toISOString()});
const history=(question,reply='Here is your tracking information.',ack='Thanks')=>[msg(question),msg(reply,'bot'),msg(ack)];
const original={razorpay_order_id:'IC-1',status:'delivered',cart_items:[{title:'Book A',_missing:true}]};
const replacement=(status,extra={})=>({source:'replacement',status,cart_items:[{title:'Book A',_replacement:{original_order_id:'IC-1',reason:'missing_item',...extra}}]});
test('missing books, cancellations and outstanding refunds have top priority',()=>{
 for(const q of ['One book is missing','my order got cancelled','I did not get refund for missing book','track my order with missing books'])assert.equal(category({},[msg(q)]).category,'top');
 for(const order of [original,replacement('cancelled'),replacement('replacement_pending'),{status:'refund_failed'},{status:'cancelled'}])assert.equal(category({},[],[order]).category,'top');
});
test('tracking and pickup queries are low; human and unanswered chats need attention',()=>{
 for(const q of ['Where is my order','why order is not picked up','want to track order'])assert.equal(category({},[msg(q)]).category,'low');
 assert.equal(category({human_takeover:true},[msg('track order')]).category,'attention');
 assert.equal(category({},[{...msg('track order'),created_at:'2020-01-01'}]).category,'attention');
 assert.equal(category({},[msg('Please call me')]).category,'attention');
 assert.equal(category({status:'resolved'},[msg('missing book')]).category,'closed');
});
test('only clear confirmation after a bot reply closes a conversation',()=>{
 assert.equal(canAutoClose({},history('Where is my order')),true);
 assert.equal(canAutoClose({},history('missing book','Please check again','My issue is resolved. Thanks')),true);
 for(const ack of ['still not resolved','refund received but another book is missing','My issue is resolved?','Where is my order now?'])assert.equal(canAutoClose({},history('missing book','Checking',ack)),false,ack);
 assert.equal(canAutoClose({},[msg('My issue is resolved')]),false);
 assert.equal(canAutoClose({},[msg('track order'),msg('It arrived','admin'),msg('thanks')]),false);
 assert.equal(canAutoClose({human_takeover:true},history('track order')),false);
});
test('thanks never settles a refund promise or unresolved missing books',()=>{
 assert.equal(canAutoClose({},history('missing book refund','We will refund soon')),false);
 assert.equal(canAutoClose({},history('track order'),[original]),false);
 assert.equal(canAutoClose({},history('missing book','Checking','My issue is resolved'),[replacement('cancelled')]),false);
 assert.equal(canAutoClose({},history('missing book','Checking','My refund received'),[original,replacement('cancelled',{refund_paid_at:'2026-10-03'})]),true);
 assert.equal(canAutoClose({},history('missing book','Checking','My issue is resolved'),[original,replacement('delivered')]),true);
});
test('incomplete or failed context cannot authorize auto closure',async()=>{
 const db={from:()=>{const q={select:()=>q,in:()=>q,order:()=>q,limit:async()=>({data:Array(100).fill(msg('test'))})};return q;}};
 assert.equal((await contextFor(db,'919876543210')).complete,false);
 const broken={from:()=>{const q={select:()=>q,in:()=>q,order:()=>q,gte:()=>q,range:async()=>({error:Error('unavailable')}),limit:async()=>({error:Error('unavailable')})};return q;}};
 await assert.rejects(contextFor(broken,'919876543210'));
 const categorized=await categorizeConversations(broken,[{customer_phone:'919876543210'}]);assert.equal(categorized[0].category,'attention');
});
test('persisted conversations close on confirmation, stay closed on bot follow-up, reopen on new questions',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const src=fs.readFileSync('netlify/functions/whatsapp-bot.js','utf8');
 let conv={status:'active',human_takeover:false,unread_count:1},messages=[msg('Where is my order'),msg('Here is the tracking link','bot')];
 const db={from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{...conv}}),insert:async m=>{messages.push(m);return {}},upsert:async c=>{conv={...conv,...c};return {}}};return q;}};
 const scope={createClient:()=>db,process:{env:{}},console,isClosureCandidate,ACK:require('../../netlify/functions/utils/conversation-priority').ACK,canAutoClose,contextFor:async()=>({messages,orders:[],complete:true})};
 vm.runInNewContext(src.slice(src.indexOf('async function persistMessage('),src.indexOf('// ── Check if this conversation')),scope);
 await scope.persistMessage('919876543210','user','Thanks');assert.equal(conv.status,'resolved');assert.equal(conv.unread_count,0);
 await scope.persistMessage('919876543210','bot','Happy to help!');assert.equal(conv.status,'resolved');
 await scope.persistMessage('919876543210','user','A book is missing');assert.equal(conv.status,'active');assert.equal(conv.unread_count,1);
 conv.human_takeover=true;await scope.persistMessage('919876543210','bot','Checking');await scope.persistMessage('919876543210','user','My issue is resolved');assert.equal(conv.status,'active');
});
