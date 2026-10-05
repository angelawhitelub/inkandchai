const { requireAdmin } = require('./utils/admin-auth');
const { report } = require('./utils/search-events');
const headers={'Cache-Control':'private, no-store','Content-Type':'application/json'};
exports.handler=async event=>{
  const block=requireAdmin(event,headers);if(block)return block;
  if(event.httpMethod!=='GET')return {statusCode:405,headers,body:'{}'};
  const days=Number(event.queryStringParameters?.days)===7?7:30;
  try{return {statusCode:200,headers,body:JSON.stringify(await report(days))};}
  catch{return {statusCode:503,headers,body:JSON.stringify({error:'Search insights could not be loaded. Please retry.'})};}
};
