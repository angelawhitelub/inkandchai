const PAGE = 200;
function digits(value) { return String(value || '').replace(/\D/g,''); }
function key(value) { const d=digits(value);return d.length===12&&d.startsWith('91')?d.slice(2):d; }
function variants(value) { const d=digits(value),k=key(value);return [...new Set([value,d,k,...(k.length===10?['91'+k,'+91'+k]:[])])]; }
async function threadPage(db, phone, params={}) {
  const snapshot = params.snapshot || new Date().toISOString();
  if(!Number.isFinite(Date.parse(snapshot)))throw new Error('Invalid history snapshot');
  const offset = Math.max(0,parseInt(params.offset,10)||0);
  const {data,error}=await db.from('bot_messages').select('*').in('customer_phone',variants(phone))
    .lte('created_at',snapshot).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+PAGE);
  if(error)throw error;
  const rows=data||[];
  return {messages:rows.slice(0,PAGE).reverse(),snapshot,next_offset:rows.length>PAGE?offset+PAGE:null};
}
async function customerDetails(db,phone) {
  const k=key(phone);let orders=[];
  for(let offset=0;;offset+=PAGE){
    const {data,error}=await db.from('orders')
      .select('razorpay_order_id,customer_name,customer_phone,customer_email,customer_address,created_at,status,amount_paise,cart_items,tracking_id,courier_name,source')
      .ilike('customer_phone','%'+k.split('').join('%')+'%').order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+PAGE-1);
    if(error)throw error;
    orders.push(...(data||[]).filter(o=>key(o.customer_phone)===k));
    if((data||[]).length<PAGE)break;
  }
  const memory=await db.from('bot_customers').select('customer_name,address').eq('customer_phone',k).maybeSingle();
  const latest=orders[0]||{};
  return {name:latest.customer_name||memory.data?.customer_name||'',phone,
    email:latest.customer_email||'',address:latest.customer_address||memory.data?.address||'',
    orders:orders.map(o=>({id:o.razorpay_order_id,status:o.status,date:o.created_at,total:Number(o.amount_paise||0)/100,
      tracking:o.tracking_id||'',courier:o.courier_name||'',source:o.source||'',
      items:(Array.isArray(o.cart_items)?o.cart_items:[]).filter(i=>i.title||i.name).map(i=>({title:i.title||i.name,qty:i.qty||i.quantity||1}))}))};
}
async function enrichNames(db,rows){
  const phones=[...new Set(rows.map(r=>key(r.customer_phone)).filter(Boolean))];
  if(!phones.length)return rows;
  const {data}=await db.from('bot_customers').select('customer_phone,customer_name').in('customer_phone',phones);
  const names=new Map((data||[]).filter(r=>r.customer_name).map(r=>[key(r.customer_phone),r.customer_name]));
  const orders=await db.from('orders').select('customer_phone,customer_name,created_at').in('customer_phone',phones.flatMap(variants)).order('created_at',{ascending:false}).limit(1000);
  for(const o of orders.data||[])if(o.customer_name&&!names.has(key(o.customer_phone)))names.set(key(o.customer_phone),o.customer_name);
  return rows.map(r=>({...r,customer_name:r.customer_name||names.get(key(r.customer_phone))||''}));
}
module.exports={threadPage,customerDetails,enrichNames,key,variants};
