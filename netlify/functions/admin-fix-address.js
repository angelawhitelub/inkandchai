const {createClient}=require('@supabase/supabase-js');
const {requireAdmin}=require('./utils/admin-auth');
const {fixOrderAddress,saveAddress}=require('./utils/address-fixer');
const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
exports.handler=async event=>{
  if(event.httpMethod!=='POST')return {statusCode:405,headers,body:'{"error":"POST only"}'};
  const blocked=requireAdmin(event,headers);if(blocked)return blocked;
  const reply=(statusCode,data)=>({statusCode,headers,body:JSON.stringify(data)});
  try{
    let body;try{body=JSON.parse(event.body||'{}')}catch{return reply(400,{error:'Invalid JSON'})}
    if(!body.id||typeof body.id!=='string'||body.id.length>100)return reply(400,{error:'Choose an order.'});
    if(!['fix','undo'].includes(body.action||'fix'))return reply(400,{error:'Unknown action'});
    const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
    const {data:order,error}=await db.from('orders').select('*').eq('id',body.id).maybeSingle();
    if(error)throw new Error('Order lookup failed');
    if(!order)return reply(404,{error:'Order not found'});
    if(body.action==='undo'){
      const auditId=String(body.audit_id||'');
      if(!auditId.startsWith(`${order.id}/`)||auditId.length>160)return reply(400,{error:'Invalid address history reference'});
      const record=await require('@netlify/blobs').getStore('address-fixes').get(auditId,{type:'json'});
      if(!record||record.order_id!==order.id||record.corrected!==order.customer_address)return reply(409,{error:'The address has changed since this fix. Refresh and review it manually.'});
      await saveAddress(db,order,record.original);
      return reply(200,{status:'undone',corrected:record.original,reason:'Original address restored. Review the PIN before shipping.'});
    }
    return reply(200,await fixOrderAddress(db,order,{force:true}));
  }catch(error){return reply(error.statusCode||503,{error:error.statusCode?error.message:'Address check unavailable. Refresh and try again.'});}
};
