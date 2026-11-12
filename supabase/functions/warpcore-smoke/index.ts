// Permanently inert validation endpoint. No imports, secrets, database, source or publishing access.
Deno.serve((req:Request)=>req.method==='POST'?Response.json({mode:'disabled',publishing_enabled:false,sources_enabled:false,validation:'warpcore-smoke-v1'}):new Response('POST required',{status:405}));
