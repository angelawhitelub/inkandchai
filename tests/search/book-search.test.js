const {test}=require('node:test');
const assert=require('node:assert/strict');
const search=require('../../public/js/book-search');
const books=[
 {title:"Can’t Hurt Me",author:'David Goggins'},
 {title:'Never Finished',author:'David Goggins'},
 {title:'Atomic Habits',author:'James Clear'},
 {title:'The Psychology of Money',author:'Morgan Housel'},
 {title:'The Housemaid',author:'Freida McFadden'},
 {title:'One Piece, Vol. 12',author:'Eiichiro Oda'},
];
function ranked(q){return books.map(b=>({...b,score:search.score(b,q)})).filter(b=>b.score>0).sort((a,b)=>b.score-a.score);}
test('punctuation, spacing, reordered and partial titles',()=>{
 for(const q of ['cant hurt me',"can't hurt me",'CAN’T HURT ME','cannot hurt me','canthurtme','hurt me','hurt cant','cant hurt me book'])assert.equal(ranked(q)[0]?.title,'Can’t Hurt Me',q);
});
test('misspellings, transpositions, prefixes and authors',()=>{
 for(const [q,title] of [['atmoic habbits','Atomic Habits'],['atomic habtis','Atomic Habits'],['atom hab','Atomic Habits'],['psychlogy money','The Psychology of Money'],['frieda mcfaden','The Housemaid']])assert.equal(ranked(q)[0]?.title,title,q);
});
test('misspelled author finds their books',()=>{assert.equal(ranked('david gogins').length,2);assert(ranked('david gogins').every(b=>b.author==='David Goggins'));});
test('related title beats unrelated books but exact edition remains first',()=>{
 assert(search.score({title:'Can’t Hurt Me — Hindi Edition'},'cant hurt me')>0);
 assert(search.score(books[0],'cant hurt me')>search.score({title:'Cant Hurt Me and Atomic Habits Combo'},'cant hurt me'));
 assert.equal(ranked('zzqzxw impossible')[0],undefined);
 assert.equal(search.score({title:'Remember Me'},'cant hurt me'),0);
 assert.equal(search.score({title:'I Want to Die but I Want to Eat Tteokbokki',author:'Baek Sehee and Anton Hur'},'cant hurt me'),0);
 assert.equal(search.score({title:'One Piece Vol 13'},'one piece 12'),0);
});
test('accented and Hindi text; exact ISBN; metadata updates invalidate cache',()=>{
 assert(search.score({title:'कर्म योग'},'कर्म')>0);
 assert(search.score({title:'Café on the Corner'},'cafe corner')>0);
 assert.equal(search.score({title:'Example',isbn:'978-1234567890'},'9781234567890'),2000);
 const b={title:'Old Title'};assert(search.score(b,'old title')>0);b.title='New Title';assert.equal(search.score(b,'old title'),0);
});
