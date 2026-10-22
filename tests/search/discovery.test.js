const {test}=require('node:test');const assert=require('node:assert/strict');
const {choose,preferences}=require('../../netlify/functions/utils/search-discovery');
const events=require('../../netlify/functions/utils/search-events');
const bindings=require('../../worker/shims/runtime-bindings');
const eventAPI=require('../../netlify/functions/search-events');
const reportAPI=require('../../netlify/functions/search-insights');
function book(slug,title,author,category){return {slug,url:`/product/${slug}/`,title,author,category,price:299};}
const romance=book('romance','The Love Story','Author A','Romance'),romance2=book('romance-two','A New Romance','Author A','Romance'),habit=book('atomic','Atomic Habits','James Clear','Self Help'),money=book('money','The Psychology of Money','Morgan Housel','Finance');
test('browsing and search interests find relevant books without duplicating bestsellers',()=>{
 const picks=choose([romance,romance2,habit,money],[habit,money],{viewed:['romance'],interests:[]});assert.equal(picks.for_you[0].slug,'romance-two');assert(!picks.for_you.some(b=>b.slug==='romance'));assert.equal(picks.bestsellers[0].slug,'atomic');
 const searched=choose([romance,romance2,habit,money],[habit,money],{viewed:[],interests:['money']});assert.equal(searched.for_you[0].slug,'money');assert(!searched.bestsellers.some(b=>b.slug==='money'));
 const gone=choose([romance,romance2,habit,money],[habit,money],{viewed:[],interests:[]},new Set(['atomic']));assert(!Object.values(gone).flat().some(b=>b.slug==='atomic'));
});
test('unavailable sales data is labelled featured rather than invented bestsellers',()=>{const picks=choose([habit,money],[],{viewed:[],interests:[]});assert.equal(picks.bestsellers.length,0);assert.equal(picks.featured.length,2);});
test('preferences are bounded and malformed preference input is harmless',()=>{assert.deepEqual(preferences({interests:'{}',viewed:'invalid?slug,atomic'}),{viewed:['atomic'],interests:[]});assert.equal(preferences({interests:JSON.stringify(['a long query','second','third']),viewed:'a,b,c,d'}).interests.length,2);});
test('search recording rejects contact/order data but accepts titles and valid ISBNs',()=>{
 for(const q of ['sam@example.test','call 9876543210','+91 98765 43210','IC-20261001-ABCDE','https://example.com'])assert.equal(events.safeQuery(q),'');
 assert.equal(events.safeQuery(" Can't Hurt Me "),"can't hurt me");assert.equal(events.safeQuery('978-0-13-235088-4'),'978-0-13-235088-4');
 assert.equal(events.normalise({q:'hello',kind:'click',id:'0123456789ab',product:'javascript:alert(1)'}),null);
});
test('records use expiring anonymous metadata, rate limits and private admin reports',async()=>{
 const saved=[];let allow=true;bindings.bindEnv({ORDER_FALLBACK:{put:async(...args)=>saved.push(args),list:async()=>({keys:saved.map(s=>({metadata:s[2].metadata})),list_complete:true})},INK_AI_LIMIT:{idFromName:key=>{assert(!key.includes('192.0.2'));return key;},get:()=>({fetch:async()=>({json:async()=>({allowed:allow})})})}});
 const input={httpMethod:'POST',headers:{origin:'https://inkandchai.in','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({id:'test-search-000001',kind:'search',q:'Missing novel',result_count:0,source:'home',email:'ignore@example.com'})};
 assert.equal((await eventAPI.handler(input)).statusCode,204);assert.equal(saved.length,1);assert.equal(saved[0][2].expirationTtl,30*86400);assert.deepEqual(Object.keys(saved[0][2].metadata).sort(),['at','kind','product','q','result_count','source']);
 const stats=events.aggregate(saved.map(s=>s[2].metadata));assert.equal(stats.searches,1);assert.equal(stats.unmatched,1);
 allow=false;assert.equal((await eventAPI.handler(input)).statusCode,429);assert.equal(saved.length,1);
 assert.equal((await eventAPI.handler({...input,headers:{origin:'https://attacker.test'}})).statusCode,403);
 assert.equal((await eventAPI.handler({...input,headers:{...input.headers,dnt:'1'}})).statusCode,204);assert.equal(saved.length,1);
 const old=process.env.ADMIN_SECRET;process.env.ADMIN_SECRET='test-admin';try{assert.equal((await reportAPI.handler({httpMethod:'GET',headers:{}})).statusCode,401);}finally{if(old===undefined)delete process.env.ADMIN_SECRET;else process.env.ADMIN_SECRET=old;bindings.bindEnv(null);}
});
test('unknown result counts are not misreported as no-match searches',()=>{const stats=events.aggregate([{q:'atomic',kind:'search',result_count:null,at:'2026-10-05'},{q:'atomic',kind:'click',at:'2026-10-05'}]);assert.equal(stats.searches,1);assert.equal(stats.clicks,1);assert.equal(stats.unmatched,0);});
