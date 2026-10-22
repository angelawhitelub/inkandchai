/* One relevance model for the browser results, suggestions and remote catalogue. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IACBookSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const aliases = {atmoic:'atomic',atomik:'atomic',habbit:'habit',habbits:'habits',ikigia:'ikigai',ikigayi:'ikigai',physcology:'psychology',phychology:'psychology',pyschology:'psychology',psycology:'psychology',frieda:'freida',mcfaden:'mcfadden',macfadden:'mcfadden',colen:'colleen',collen:'colleen',coleen:'colleen',hover:'hoover',gogins:'goggins',kiyosak:'kiyosaki',kiosaki:'kiyosaki',milionaire:'millionaire',millionare:'millionaire',sapians:'sapiens',hindhi:'hindi',hindii:'hindi',kombo:'combo',boxset:'box set',boxsets:'box set'};
  const noise = new Set(['a','an','the','by','book','books','please','buy']);
  function normalize(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase().replace(/[`’‘´'ʼ]/g,'').replace(/&/g,' and ')
      .replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\b(?:can not|cannot)\b/g,'cant').trim();
  }
  function canonical(value) { return normalize(value).split(' ').map(w=>aliases[w]||w).join(' '); }
  function tokens(value) {
    const all = canonical(value).split(' ').filter(Boolean);
    const meaningful = all.filter(w=>!noise.has(w));
    return [...new Set(meaningful.length ? meaningful : all)].slice(0,12);
  }
  // Bounded Damerau-Levenshtein: also recognises swapped letters ("hba its").
  function near(a,b) {
    if(a.length<4 || /\d/.test(a+b)) return false;
    const max = a.length>=8 ? 2 : 1;
    if(Math.abs(a.length-b.length)>max) return false;
    let prev=Array.from({length:b.length+1},(_,i)=>i),older;
    for(let i=1;i<=a.length;i++) {
      const row=[i];let lowest=i;
      for(let j=1;j<=b.length;j++) {
        row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
        if(older&&i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])row[j]=Math.min(row[j],older[j-2]+1);
        lowest=Math.min(lowest,row[j]);
      }
      if(lowest>max)return false;
      older=prev;prev=row;
    }
    return prev[b.length]<=max;
  }
  const cache=new WeakMap();
  function documentFor(book) {
    const raw=[book.title||book.t,book.author||book.a,book.category||book.cat,book.isbn,book.publisher||book.pub];
    const key=raw.join('\n'), cached=cache.get(book);
    if(cached?.key===key)return cached;
    const [title,author,category,isbn,publisher]=raw.map(normalize);
    const doc={key,title,author,category,isbn,publisher,titleWords:title.split(' '),authorWords:author.split(' ')};
    cache.set(book,doc);return doc;
  }
  let lastRaw,lastQuery;
  function queryFor(raw) {
    if(raw===lastRaw)return lastQuery;
    lastRaw=raw;return lastQuery={q:canonical(String(raw||'').slice(0,120)),words:tokens(String(raw||'').slice(0,120))};
  }
  function matchScore(book, raw) {
    const {q,words}=queryFor(raw);if(!q||!words.length)return 0;
    const d=documentFor(book),compact=q.replace(/ /g,'');
    if(d.isbn && d.isbn.replace(/ /g,'')===compact)return 2000;
    // A volume/edition number is a constraint, never a fuzzy fallback.
    if(words.some(w=>/^\d+$/.test(w)&&!d.titleWords.includes(w)))return 0;
    if(d.title===q)return 1800;
    if(d.title.replace(/ /g,'')===compact)return 1750;
    let base=d.title.startsWith(q)?1000:d.title.includes(q)?850:0;
    if(!base&&compact.length>=5&&d.title.replace(/ /g,'').includes(compact))base=800;
    if(d.author===q)base=Math.max(base,750);
    let matched=0,points=0,strong=0,precise=0;
    for(const word of words) {
      let hit=0;
      if(d.titleWords.includes(word))hit=100;
      else if(word.length>=3&&d.titleWords.some(w=>w.startsWith(word)))hit=85;
      else if(d.authorWords.includes(word))hit=80;
      else if(word.length>=3&&d.authorWords.some(w=>w.startsWith(word)))hit=65;
      else if(d.titleWords.some(w=>near(word,w)))hit=45;
      else if(d.authorWords.some(w=>near(word,w)))hit=35;
      if(hit){matched++;points+=hit;if(word.length>=3)strong++;if(hit>=65&&word.length>=3)precise++;}
    }
    if(base)return base+points;
    const required=words.length<=2?words.length:Math.max(2,Math.ceil(words.length*.66));
    if(matched>=required&&(matched===words.length||precise>=2)&&(strong||words.every(w=>d.titleWords.includes(w))))
      return (matched===words.length?350:100)+points;
    if(d.category===q||d.publisher===q)return 150;
    return 0;
  }
  function score(book, raw) {
    const value=matchScore(book,raw);if(!value||value===2000)return value;
    const d=documentFor(book),{q,words}=queryFor(raw);
    let adjustment=Math.max(0,80-Math.max(0,d.titleWords.length-words.length)*5);
    if(/\b(combo|bundle|set of|box set)\b/.test(d.title)&&!/\b(combo|bundle|set)\b/.test(q))adjustment-=120;
    for(const language of ['hindi','tamil','telugu','marathi','malayalam','bengali','kannada','gujarati'])
      if(d.titleWords.includes(language)&&!q.includes(language))adjustment-=90;
    return Math.max(1,value+adjustment);
  }
  return {normalize,canonical,tokens,score,near};
});
