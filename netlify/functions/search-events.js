const { record } = require('./utils/search-events');
const headers={'Cache-Control':'no-store','Content-Type':'application/json'};
exports.handler=async event=>{
  if(event.httpMethod!=='POST')return {statusCode:405,headers,body:'{}'};
  const origin=event.headers?.origin||'';
  if(!['https://inkandchai.in','https://www.inkandchai.in'].includes(origin))return {statusCode:403,headers,body:'{}'};
  if(event.headers?.dnt==='1'||event.headers?.['sec-gpc']==='1')return {statusCode:204,headers,body:''};
  if((event.body||'').length>2048)return {statusCode:413,headers,body:'{}'};
  let body;try{body=JSON.parse(event.body||'{}');}catch{return {statusCode:400,headers,body:'{}'};}
  if(!body||typeof body!=='object'||Array.isArray(body))return {statusCode:400,headers,body:'{}'};
  try {const result=await record(event,body);return {...result,headers,body:result.statusCode===204?'':'{}'};}
  catch{return {statusCode:503,headers,body:'{}'};}
};
