// No public-config or publish action. Platform JWT verification must also be enabled.
export async function handleOperator(req,config,services){
 if(req.method!=='POST')return new Response('POST required',{status:405});
 if(!Array.isArray(config.operatorIds)||!config.operatorIds.length)return Response.json({error:'operator_access_not_configured'},{status:403});
 const auth=req.headers.get('authorization')??'';
 if(!auth.startsWith('Bearer '))return new Response('Unauthorized',{status:401});
 try{
  const user=await services.identify(auth.slice(7));
  if(!user?.id||!config.operatorIds.includes(user.id))return new Response('Forbidden',{status:403});
  const reader=req.body?.getReader();if(!reader)return new Response('Body required',{status:400});
  const chunks=[];let length=0;try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16000)return new Response('Body too large',{status:413});chunks.push(value);}}finally{await reader.cancel();}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return new Response('Invalid JSON',{status:400});}
  if(body?.action==='list')return Response.json(await services.list());
  if(body?.action==='preview')return Response.json(await services.preview(body));
  if(body?.action==='approve')return Response.json(await services.approve(body,user.id));
  if(body?.action==='reject')return Response.json(await services.reject(body,user.id));
  return new Response('Unsupported action',{status:400});
 }catch{return Response.json({error:'operator_request_failed'},{status:400});}
}
