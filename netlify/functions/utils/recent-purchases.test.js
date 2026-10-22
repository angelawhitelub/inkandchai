const {test} = require('node:test');
const assert = require('node:assert/strict');
const {project,eligible,firstName,slugOf,MAX_AGE_MS} = require('./recent-purchases');
const now = Date.parse('2026-10-06T10:00:00Z');
const order = overrides => ({id:'internal-order-1',customer_name:'Sahil PrivateSurname',created_at:new Date(now-720000).toISOString(),status:'paid',source:null,amount_paise:49900,cart_items:[{slug:'cant-hurt-me-hardcover',title:'untrusted title',img:'bad'}],...overrides});
const products = new Map([['cant-hurt-me-hardcover',{title:"Can't Hurt Me (HARDCOVER)",img:'/images/hardcover.jpg'}],['cant-hurt-me-paperback',{title:"Can't Hurt Me (Paperback)",img:'/images/paperback.jpg'}]]);
const output = rows => project(rows,products,new Set(),now,'test-secret');
test('projects real timestamp and exact edition without leaking order details',()=>{
 const p=output([order({customer_phone:'secret',customer_email:'secret',address:'secret'})])[0];
 assert.equal(p.title,"Can't Hurt Me (HARDCOVER)"); assert.equal(p.img,'/images/hardcover.jpg');
 assert.equal(p.ordered_at,new Date(now-720000).toISOString());assert.equal(p.first_name,'Sahil');
 assert.deepEqual(Object.keys(p).sort(),['event_id','first_name','ordered_at','title','img','url'].sort());
 assert.match(p.event_id,/^[a-f0-9]{24}$/);assert.ok(!JSON.stringify(p).includes('internal-order'));assert.ok(!JSON.stringify(p).includes('PrivateSurname'));
});
test('rejects cancelled, failed, refunded and incomplete payments',()=>{
 for(const status of ['cancelled','failed','refunded','refund_pending','pending','pending_phonepe','pending_partial_phonepe'])assert.equal(output([order({status})]).length,0,status);
 for(const status of ['cod_pending','partial_cod_pending','paid','shipped','confirmed'])assert.equal(output([order({status})]).length,1,status);
});
test('rejects other store, reshipments, zero amount and replacement metadata',()=>{
 for(const patch of [{source:'paperbound'},{source:'replacement'},{id:'IC-R-123'},{amount_paise:0},{cart_items:[{slug:'cant-hurt-me-hardcover',_replacement:{original_order_id:'x'}}]}]) assert.equal(output([order(patch)]).length,0);
});
test('rejects stale, future and invalid timestamps',()=>{
 for(const t of [now-MAX_AGE_MS-1,now+1,'bad'])assert.equal(output([order({created_at:typeof t==='number'?new Date(t).toISOString():t})]).length,0);
});
test('does not replace unknown titles with a similar book',()=>{
 assert.equal(output([order({cart_items:[{slug:'unknown',title:"Can't Hurt Me"}]})]).length,0);
 assert.equal(project([order()],products,new Set(['cant-hurt-me-hardcover']),now,'key').length,0);
});
test('deduplicates purchases, sorts newest first, and caps feed',()=>{
 const rows=Array.from({length:30},(_,i)=>order({id:`order-${i}`,created_at:new Date(now-i*60000).toISOString()}));
 const p=output([...rows.reverse(),rows[0]]);assert.equal(p.length,20);assert.equal(p[0].ordered_at,new Date(now).toISOString());assert.equal(new Set(p.map(x=>x.event_id)).size,20);
 assert.equal(output([order(),order()]).length,1);
});
test('validates slugs and handles missing customer names',()=>{
 assert.equal(slugOf({id:'/product/a-hardcover/'}),'a-hardcover');assert.equal(slugOf({slug:'a,b'}),'');
 assert.equal(firstName('Dr. Neha Surname'),'Neha');assert.equal(firstName('someone@example.com'),'A reader');assert.equal(firstName(''),'A reader');assert.equal(firstName('आदित्य कुमार'),'आदित्य');
});
test('requires signing secret, supports empty and malformed carts',()=>{
 assert.deepEqual(project([order()],products,new Set(),now,''),[]);assert.deepEqual(output([]),[]);assert.equal(eligible(order({cart_items:null}),now),false);
});
