/* Shared storefront search: matches, browsing-based picks, sales-based bestsellers. */
(function () {
  'use strict';
  const KEY='iac_search_discovery_v1', PRIVATE='iac_private_search', TTL=30*86400000;
  const controllers=new Map(),cache=new Map(),sent=new Map();
  let profile={searches:[],viewed:[]},privateMode=false,serial=0;
  const restricted=()=>navigator.doNotTrack==='1'||navigator.globalPrivacyControl===true;
  const allowed=()=>!privateMode&&!restricted();
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const validUrl=u=>/^\/product\/[a-z0-9-]{1,200}\/$/.test(u||'');
  function prune(){const since=Date.now()-TTL;for(const k of ['searches','viewed'])profile[k]=(Array.isArray(profile[k])?profile[k]:[]).filter(x=>x&&typeof x.value==='string'&&x.at>since).slice(0,k==='searches'?8:12);}
  function save(){prune();try{localStorage.setItem(KEY,JSON.stringify(profile));localStorage.setItem('iac_searches',JSON.stringify(profile.searches.map(x=>x.value).reverse()));}catch{}}
  try{privateMode=localStorage.getItem(PRIVATE)==='1';const p=JSON.parse(localStorage.getItem(KEY)||'null');if(p&&typeof p==='object')profile=p;}catch{}
  prune();
  function remember(key,value){if(!allowed()||!value)return;profile[key]=[{value,at:Date.now()},...profile[key].filter(x=>x.value.toLowerCase()!==value.toLowerCase())];save();}
  function safeTerm(q){q=String(q||'').trim().slice(0,120);return q.length>=2&&!/@|https?:|www\.|\bIC[-\s]?\d{6,}|(?:\d[\s()+-]*){7,}/i.test(q)?q:'';}
  function rememberQuery(q){const safe=safeTerm(q);if(safe)remember('searches',safe);}
  const viewed=location.pathname.match(/^\/product\/([a-z0-9-]+)\/?$/);
  if(viewed)remember('viewed',viewed[1]);
  function prefs(){prune();if(!allowed())return {};
    return {interests:profile.searches.slice(0,2).map(x=>x.value),viewed:profile.viewed.map(x=>x.value).filter(x=>/^[a-z0-9-]{1,200}$/.test(x||'')).slice(0,3)};
  }
  function event(kind,q,count,source,product){
    if(!allowed()||!q||q.trim().length<2)return;
    q=q.trim().slice(0,120);
    const key=JSON.stringify([kind,q.toLowerCase(),product||'']);
    if(sent.has(key)&&Date.now()-sent.get(key)<1800000)return;
    try{const old=Number(sessionStorage.getItem('iac_search_event:'+key));if(old&&Date.now()-old<1800000)return;sessionStorage.setItem('iac_search_event:'+key,String(Date.now()));}catch{}
    sent.set(key,Date.now());
    if(sent.size>100)sent.delete(sent.keys().next().value);
    const id=crypto.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
    fetch('/.netlify/functions/search-events',{method:'POST',credentials:'omit',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({id,kind,q,result_count:count,source,product})}).catch(()=>{});
  }
  const css=`
  .sugg-box{position:absolute;top:calc(100% + 8px);left:0;right:0;z-index:10000;display:none;background:#fffdf8;color:#252b2b;border:1px solid #d9d3c6;border-radius:16px;box-shadow:0 16px 40px #241b1824;max-height:min(70dvh,620px);overflow:auto;overscroll-behavior:contain;text-align:left;font-family:var(--font-sans,system-ui)}
  #srchResults.sugg-box{position:static;max-height:58dvh;margin-top:12px;width:100%;box-shadow:none}
  .sugg-heading{font-size:12px;font-weight:750;letter-spacing:.02em;padding:13px 14px 7px;color:#53604f;text-transform:none}
  .sugg-row{display:flex;align-items:center;gap:12px;padding:9px 14px;text-decoration:none;color:#252b2b;border:0;border-bottom:1px solid #ede9e0;min-height:64px}
  .sugg-row:hover,.sugg-row.sugg-active{background:#f1eee5;color:#252b2b}
  .sugg-row img{width:34px;height:49px;object-fit:cover;border-radius:3px;flex:0 0 auto;background:#e9e5dc}
  .sugg-main{flex:1;min-width:0}.sugg-t{font-size:14px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:600}
  .sugg-a{display:block;font-size:12px;color:#616861;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sugg-p{font-size:14px;color:#6d4a16;font-weight:700;white-space:nowrap}
  .sugg-foot{display:block;padding:12px 14px;color:#63461d;font-size:13px;text-decoration:none;font-weight:600}.sugg-info{padding:12px 14px;font-size:13px;line-height:1.5;color:#5b635c}
  .sugg-chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 14px 8px}.sugg-box button.sugg-chip{font:inherit;font-size:12px;padding:7px 10px;min-height:32px;border:1px solid #d5d1c6;border-radius:20px;background:#f8f5ed;color:#394536;letter-spacing:0;cursor:pointer;text-transform:none}
  .sugg-settings{display:flex;gap:10px;flex-wrap:wrap;align-items:center;border-top:1px solid #e5e0d5;padding:10px 14px;background:#f8f6f0}.sugg-box .sugg-settings button,.sugg-settings a{font:inherit;font-size:11px;line-height:1.4;color:#596451;border:0;background:none;padding:4px 0;min-height:24px;letter-spacing:0;text-transform:none;text-decoration:underline;cursor:pointer}
  @media(max-width:600px){.sugg-t,.sugg-p{font-size:14px}.sugg-row{padding:9px 11px;gap:9px}.sugg-box{max-height:65dvh;border-radius:12px}.sugg-settings{gap:12px}}
  `;
  const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);
  function init(input){
    if(controllers.has(input))return controllers.get(input);
    const overlay=input.id==='srchInput',form=input.closest('form'),host=overlay?document.getElementById('srchResults'):document.createElement('div');
    if(!host)return;
    if(!overlay){host.className='sugg-box';input.parentElement.style.position='relative';input.parentElement.appendChild(host);}else host.classList.add('sugg-box');
    const source=overlay?'overlay':input.id==='q'?'books':viewed?'product':'home';
    const id='search-suggestions-'+(++serial);host.id=overlay?'srchResults':id;
    host.setAttribute('role','region');host.setAttribute('aria-label','Book suggestions');
    input.setAttribute('autocomplete','off');input.setAttribute('aria-controls',host.id);input.setAttribute('aria-expanded','false');input.setAttribute('aria-autocomplete','list');
    let timer,recordTimer,abort,version=0,selection=-1,lastQuery='',lastCount=null;
    function close(){version++;clearTimeout(timer);clearTimeout(recordTimer);abort?.abort();host.style.display='none';input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');selection=-1;}
    function commit(q=input.value.trim()){rememberQuery(q);event('search',q,q===lastQuery?lastCount:null,source);}
    function settings(){return '<div class="sugg-settings"><button type="button" data-clear>Clear history</button><button type="button" data-private aria-pressed="'+(!allowed())+'">Private search: '+(allowed()?'off':'on')+'</button><a href="/privacy-policy/#search-privacy">Search privacy</a></div>';}
    function draw(data,q){
      lastQuery=q;lastCount=Number.isInteger(data.matched_count)?data.matched_count:null;selection=-1;
      const seen=new Set(),titles=new Set();
      function section(title,rows,limit){const books=(rows||[]).filter(r=>{if(!validUrl(r.url)||!r.title||seen.has(r.url)||titles.has(r.title.toLowerCase()))return false;seen.add(r.url);titles.add(r.title.toLowerCase());return true;}).slice(0,limit);
        return books.length?'<div class="sugg-heading">'+esc(title)+'</div>'+books.map(r=>'<a class="sugg-row" href="'+esc(r.url)+'"><img loading="lazy" src="'+esc(/^(https?:\/\/|\/)/.test(r.img||'')?r.img:'/images/cover-coming-soon.webp')+'" alt=""/><span class="sugg-main"><span class="sugg-t">'+esc(r.title)+'</span>'+(r.author?'<span class="sugg-a">'+esc(r.author)+'</span>':'')+'</span><span class="sugg-p">₹'+esc(Number(r.price).toLocaleString('en-IN'))+'</span></a>').join(''):'';}
      let html='';
      if(q.length<2){
        const recent=allowed()?profile.searches.slice(0,4):[];
        if(recent.length)html+='<div class="sugg-heading">Recent searches</div><div class="sugg-chips">'+recent.map(x=>'<button type="button" class="sugg-chip" data-query="'+esc(x.value)+'">'+esc(x.value)+'</button>').join('')+'</div>';
        html+=section('Inspired by your browsing',data.for_you,4)+section('Bestsellers this month',data.bestsellers,6)+section('Explore books',data.featured,4);
        if(!html)html='<div class="sugg-info">Search for a book, author or topic to find your next read.</div>';
      }else{
        html+=section('Matching books',data.results,6);
        if(!data.results?.length)html+='<div class="sugg-info">'+(data.warning||data.partial?'Some search results could not load. Try again or browse the catalogue.':'No close match for “'+esc(q)+'” yet. Try an author or fewer words, or explore these books.')+'</div>';
        if((data.results||[]).length<4)html+=section('You may also like',data.for_you,3)+section('Bestsellers this month',data.bestsellers,4)+section('Explore books',data.featured,3);
        html+='<a class="sugg-foot" href="/?q='+encodeURIComponent(q)+'" data-all>See all results for “'+esc(q)+'” →</a>';
      }
      host.innerHTML=html+settings();host.style.display='block';input.setAttribute('aria-expanded','true');
      host.querySelectorAll('.sugg-row').forEach((r,i)=>r.id=id+'-'+i);
      clearTimeout(recordTimer);
      if(q.length>=2&&!data.warning)recordTimer=setTimeout(()=>{if(input.value.trim()===q&&document.activeElement===input)commit(q);},1200);
    }
    function show(raw=input.value){
      for(const [other,ctl] of controllers)if(other!==input)ctl.close();
      const q=String(raw||'').trim().slice(0,120),p=prefs(),key=JSON.stringify([q,p]);
      clearTimeout(timer);clearTimeout(recordTimer);abort?.abort();const v=++version;
      host.innerHTML='<div class="sugg-info" role="status">Finding your next read…</div>';host.style.display='block';input.setAttribute('aria-expanded','true');
      const existing=cache.get(key);if(existing&&Date.now()-existing.at<120000){draw(existing.data,q);return;}
      timer=setTimeout(async()=>{
        abort=new AbortController();
        const params=new URLSearchParams({v:'20261005-discovery',q});
        if(p.interests?.length)params.set('interests',JSON.stringify(p.interests));if(p.viewed?.length)params.set('viewed',p.viewed.join(','));
        try{
          const res=await fetch('/.netlify/functions/search-suggest?'+params,{signal:abort.signal,credentials:'omit'});if(!res.ok)throw Error('unavailable');const data=await res.json();
          if(v!==version||input.value.trim().slice(0,120)!==q)return;
          if(!data.warning){if(cache.size>30)cache.delete(cache.keys().next().value);cache.set(key,{data,at:Date.now()});}draw(data,q);
        }catch(e){if(v===version&&e.name!=='AbortError')draw({results:[],warning:true},q);}
      },q?200:0);
    }
    input.addEventListener('input',()=>show());input.addEventListener('focus',()=>show());
    input.addEventListener('keydown',e=>{
      if(e.key==='Escape'){close();return;}
      const rows=[...host.querySelectorAll('.sugg-row')];
      if(host.style.display!=='none'&&['ArrowDown','ArrowUp'].includes(e.key)){
        e.preventDefault();e.stopImmediatePropagation();selection=Math.max(-1,Math.min(rows.length-1,selection+(e.key==='ArrowDown'?1:-1)));
        rows.forEach((r,i)=>r.classList.toggle('sugg-active',i===selection));if(selection>=0){rows[selection].scrollIntoView({block:'nearest'});input.setAttribute('aria-activedescendant',rows[selection].id);}else input.removeAttribute('aria-activedescendant');return;
      }
      if(e.key==='Enter'){
        commit();if(host.style.display!=='none'&&selection>=0&&rows[selection]){e.preventDefault();e.stopImmediatePropagation();event('click',input.value.trim(),lastCount,source,rows[selection].getAttribute('href'));location.href=rows[selection].href;}
        else if(!form){e.preventDefault();e.stopImmediatePropagation();close();if(overlay&&window.srchShowAll)window.srchShowAll();}
      }
    },true);
    form?.addEventListener('submit',()=>{commit();close();},true);
    host.addEventListener('click',e=>{
      const target=e.target.closest('a,button');if(!target)return;
      if(target.hasAttribute('data-clear')){profile={searches:[],viewed:[]};try{localStorage.removeItem('iac_searches');localStorage.removeItem('iac_viewed');}catch{}save();cache.clear();input.focus();show();return;}
      if(target.hasAttribute('data-private')){privateMode=!privateMode;try{localStorage.setItem(PRIVATE,privateMode?'1':'0');}catch{}cache.clear();input.focus();show();return;}
      if(target.hasAttribute('data-query')){input.value=target.dataset.query;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();return;}
      if(target.classList.contains('sugg-row')){commit();event('click',input.value.trim(),lastCount,source,target.getAttribute('href'));}
      if(target.hasAttribute('data-all')){commit();if(overlay&&window.srchShowAll){e.preventDefault();close();window.srchShowAll();}}
    });
    document.addEventListener('pointerdown',e=>{if(e.target!==input&&!host.contains(e.target))close();});
    input.addEventListener('blur',()=>setTimeout(()=>{if(!host.contains(document.activeElement)&&document.activeElement!==input)close();},150));
    const ctl={show,close,commit};controllers.set(input,ctl);return ctl;
  }
  window.InkSearch={showOverlay(q){const input=document.getElementById('srchInput');if(input)init(input)?.show(q);},record(q,count,source='home'){rememberQuery(q);event('search',q,count,source);}};
  function boot(){document.querySelectorAll('form.nav-search input[name="q"],form.pdp-search input[name="q"],#searchInput,#srchInput,#searchForm #q').forEach(init);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
