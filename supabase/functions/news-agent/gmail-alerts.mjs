// Optional failure notifications only. Queue processing never depends on SMTP.
const reasonLabels={
 invalid_configuration:'Worker configuration could not be validated.',
 claim_unavailable:'The database could not assign the next item.',
 invalid_claim:'The assigned item could not be validated.',
 handoff_deferred:'The verified item could not move to publishing yet.',
 handoff_unconfirmed:'The publishing handoff could not be confirmed.',
 invalid_handoff_claim:'The publishing handoff could not be validated.',
 finish_unconfirmed:'The item completion could not be confirmed.',
 evidence_or_history_unavailable:'Source evidence or publication history was unavailable.',
 reservation_unconfirmed:'The spending reservation could not be confirmed.',
 dispatch_unconfirmed:'The provider request dispatch could not be confirmed.',
 settlement_unconfirmed:'The provider cost could not be confirmed.',
 billed_invalid_completion:'The provider response did not pass validation.',
 paid_outcome_unknown:'The provider result or cost could not be confirmed.',
 receipt_unconfirmed:'The verification receipt could not be confirmed.',
 verification_quote_missing:'The response lacked a matching source quotation.',
 verification_source_hash_mismatch:'The source content did not match the verification.',
 verification_date_invalid:'The source date could not be verified.',
 verification_claim_coverage_missing:'The response did not support every claim.',
 verification_post_unpublishable:'The generated post did not pass publication checks.',
};
const reasons=new Set(Object.keys(reasonLabels));
const errors=new Set(['agent_run_failed','hosted_agent_unavailable']);
const modes=new Set(['shadow','verification']);
const statuses=new Set(['deferred','uncertain']);
function failureSummary(input){
 const status=Number.isInteger(input?.httpStatus)&&input.httpStatus>=500&&input.httpStatus<=599?input.httpStatus:null;
 const lines=[];
 for(const step of Array.isArray(input?.steps)?input.steps.slice(0,12):[]){
  if(!step||typeof step!=='object')continue;
  // Editorial skips are normal outcomes, not infrastructure failures.
  if(['model_deferred','unsupported_verification','unapproved_primary_source'].includes(step.reason))continue;
  const reason=reasons.has(step.reason)?step.reason:null,error=errors.has(step.error)?step.error:null;
  if(!reason&&!error&&step.status!=='uncertain')continue;
  const parts=[modes.has(step.mode)?(step.mode==='shadow'?'Discovery':'Verification'):null,statuses.has(step.status)?(step.status==='uncertain'?'Outcome unconfirmed':'Item deferred'):null,reason?reasonLabels[reason]+' ('+reason+')':null,error?'The processing step failed. ('+error+')':null].filter(Boolean);
  if(parts.length)lines.push(parts.join(': '));
 }
 // Source IDs and diagnostic codes come from the configured collector, never
 // from SMTP headers, source content, or an arbitrary destination.
 for(const source of Array.isArray(input?.sourceFailures)?input.sourceFailures.slice(0,64):[]){
  if(!/^[a-z0-9_-]{1,64}$/.test(source?.id??''))continue;
  const code=source.error;let message;
  if(/^source_http_[1-5][0-9]{2}$/.test(code??''))message='The source returned HTTP '+code.slice(-3)+'.';
  else message=({source_timeout:'The source request timed out.',source_network:'The source could not be reached.',source_content_type:'The source returned an unexpected format.',source_body_limit:'The source response exceeded its supported size.',source_parse_failed:'The source content could not be parsed.',source_or_persistence_failed:'Collection or saving the source result failed.',malformed_source_dates:'Some source dates could not be read; coverage is uncertain.',source_head_stale:'The current source listing has not been refreshed for over an hour while an older list is being paged; recent stories may be delayed.'})[code];
  if(message)lines.push('Source '+source.id+': '+message);
 }
 if(status!==null)lines.unshift('HTTP '+status);
 return lines.length?[...new Set(lines)].join('\n'):null;
}
/** @param {{createTransport?: (options: any) => any, password?: string, account?: string, timeoutMs?: number}} options */
export function createGmailFailureNotifier({createTransport,password,account,timeoutMs=10000}={}){
 // Gmail displays app passwords in spaced groups. Only this server-owned secret
 // enters SMTP authentication; request fields never control addresses or headers.
 const secret=typeof password==='string'?password.replace(/ /g,''):'';
 const configured=typeof createTransport==='function'&&typeof account==='string'&&/^[A-Za-z0-9._%+-]+@gmail\.com$/.test(account)&&/^[A-Za-z0-9]{16}$/.test(secret);
 const deadline=Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=10000?timeoutMs:10000;
 return async input=>{
  if(!configured)return {status:'unconfigured'};
  const summary=failureSummary(input);if(summary===null)return {status:'suppressed'};
  let transport,timer;
  try{
   transport=createTransport({host:'smtp.gmail.com',port:465,secure:true,
    auth:{user:account,pass:secret},pool:false,logger:false,debug:false,
    connectionTimeout:5000,greetingTimeout:5000,socketTimeout:8000,dnsTimeout:5000,
    tls:{servername:'smtp.gmail.com',minVersion:'TLSv1.2',rejectUnauthorized:true},
    disableFileAccess:true,disableUrlAccess:true});
   const operation=Promise.resolve().then(()=>transport.sendMail({
    from:account,to:account,subject:'Warp Core processing failure',
    text:'Warp Core encountered a processing failure.\nTime: '+new Date().toISOString()+'\n\n'+summary+'\n\nThe affected item is retained; unrelated queued items continue on subsequent worker turns.',
    disableFileAccess:true,disableUrlAccess:true,
   })).then(result=>Array.isArray(result?.accepted)&&result.accepted.includes(account)?'sent':'failed',()=> 'failed');
   return {status:await Promise.race([operation,new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),deadline);})])};
  }catch{return {status:'failed'};}
  finally{clearTimeout(timer);try{transport?.close();}catch{}}
 };
}
