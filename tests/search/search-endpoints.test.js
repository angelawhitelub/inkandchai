const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const original=Module._load;
const calls=[];
const rows=[
 {slug:'custom-cant',title:'Can’t Hurt Me',author:'David Goggins',price_inr:299,tags:'crossword-catalog'},
 {slug:'custom-atomic',title:'Atomic Habits',author:'James Clear',price_inr:399,tags:'crossword-catalog'},
 {slug:'removed-cant',title:'Cant Hurt Me',author:'David Goggins',price_inr:299},
 {slug:'unrelated',title:'Remember Me',author:'Someone',price_inr:199},
];
const client={from(table){const query={};for(const method of ['select','eq','or','order'])query[method]=(...args)=>{calls.push([method,...args]);return query;};query.limit=async()=>({data:rows});query.range=async()=>({data:rows,count:4});return query;}};
Module._load=function(name,parent,...rest){
 if(name==='./utils/search-discovery'){const real=original.call(this,name,parent,...rest);return {...real,discover:async()=>({for_you:[],bestsellers:[{slug:'custom-atomic',url:'/product/custom-atomic/',title:'Atomic Habits',author:'James Clear',price:399}],featured:[]})};}
 if(name==='@supabase/supabase-js')return {createClient:()=>client};
 if(name==='./utils/deleted-products')return {deletedSlugSet:async()=>new Set(['removed-cant'])};
 return original.call(this,name,parent,...rest);
};
const suggest=require('../../netlify/functions/search-suggest');
const catalog=require('../../netlify/functions/catalog-search');
Module._load=original;
process.env.SUPABASE_URL='https://example.test';process.env.SUPABASE_SERVICE_KEY='test-only';
test('suggestions find the title across static/custom catalogues and exclude unrelated/deleted products',async()=>{
 const r=await suggest.handler({httpMethod:'GET',queryStringParameters:{q:'cant hurt me'}});
 const list=JSON.parse(r.body).results;assert(list.length>0);assert.equal(list[0].title,'Can’t Hurt Me');
 assert(list.some(b=>b.url==='/product/custom-cant/'));assert(!list.some(b=>/removed-cant|unrelated/.test(b.url)));
 assert(calls.some(c=>c[0]==='eq'&&c[1]==='is_active'&&c[2]===true));
 assert(calls.some(c=>c[0]==='or'&&c[1].includes('can%t')));
});
test('remote catalogue uses relevance and paginates after ranking',async()=>{
 const r=await catalog.handler({httpMethod:'GET',queryStringParameters:{q:'cant hurt me',per_page:'1'}});
 const d=JSON.parse(r.body);assert.equal(d.books[0].slug,'custom-cant');assert.equal(d.total,1);assert.equal(d.pages,1);
});
test('typos return ranked catalogue books and gibberish does not return random results',async()=>{
 const r=await catalog.handler({httpMethod:'GET',queryStringParameters:{q:'atomc habtis'}});
 assert.equal(JSON.parse(r.body).books[0].title,'Atomic Habits');
 const empty=await suggest.handler({httpMethod:'GET',queryStringParameters:{q:'qxzzyyqq zzzq'}});
 assert.deepEqual(JSON.parse(empty.body).results,[]);
});

test('empty search offers bestsellers and personalised responses are never shared-cacheable',async()=>{
 const plain=await suggest.handler({httpMethod:'GET',queryStringParameters:{}});const data=JSON.parse(plain.body);
 assert.equal(data.bestsellers[0].title,'Atomic Habits');assert.equal(data.matched_count,null);assert.deepEqual(data.results,[]);
 const personal=await suggest.handler({httpMethod:'GET',queryStringParameters:{interests:'["romance"]'}});
 assert.match(personal.headers['Cache-Control'],/private, no-store/);assert.match(personal.headers['Netlify-CDN-Cache-Control'],/private, no-store/);
 const empty=JSON.parse((await suggest.handler({httpMethod:'GET',queryStringParameters:{q:'qxzzyyqq zzzq'}})).body);
 assert.equal(empty.matched_count,0);assert.equal(empty.bestsellers.length,1);assert.equal(empty.results.length,0);
});
