import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVerificationRequest,validateVerificationResult} from './verification-contract.mjs';
const sha='a'.repeat(64),now='2026-11-16T20:00:00.000Z';
const body='Released 2026-11-16. A new local inference engine supports offline execution.';
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
async function fixture(){
 const source={evidenceId:'e1',url:'https://example.com/release',contentSha256:await digest(body),fetchedAt:now,body};
 const editorial={political:false,summary:'A local inference engine was released.',whyItMatters:'It supports offline execution.',change:'New engine release.',evidenceIds:['e1']};
 const claims=[editorial.summary,editorial.whyItMatters,editorial.change,'2026-11-16'].map(claim=>({claim,evidenceId:'e1',url:source.url,contentSha256:source.contentSha256,quote:body}));
 return {input:{storyKey:sha,evidenceHash:sha,evidence:[{id:'e1',visibility:'public',sourceType:'rss',url:source.url}],sources:[source],history:{snapshotHash:sha,items:[],complete:true},now},result:{action:'approve',editorial,claims,publicationDate:'2026-11-16',scopeReason:'Relevant inference engine.',changeReason:'New engine release.',dedupReason:'No matching event in supplied history.'}};
}
test('verification request contains full untrusted sources/history and no tools or credentials',async()=>{
 const {input}=await fixture();const request=buildVerificationRequest(input,{model:'openai/gpt-oss-120b',maxOutputTokens:4096});
 assert.equal(request.model,'openai/gpt-oss-120b');assert.equal(request.provider.zdr,true);assert.equal(request.tools,undefined);
 assert.match(request.messages[0].content,/untrusted/i);assert.ok(request.messages[1].content.includes(body));
 assert.throws(()=>buildVerificationRequest({...input,history:{...input.history,complete:false}},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,apiKey:'must never forward'},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,evidence:[...input.evidence,{id:'private',visibility:'private',body:'private secret'}]},{model:request.model,maxOutputTokens:4096}));
 assert.throws(()=>buildVerificationRequest({...input,evidence:[{...input.evidence[0],sourceLinks:[{apiKey:'secret'}]}]},{model:request.model,maxOutputTokens:4096}));
});
test('approval validates exact captured source hashes/Unicode quote spans and original editorial claims',async()=>{
 const {input,result}=await fixture();const approved=await validateVerificationResult(result,input);
 assert.equal(approved.action,'approve');assert.equal(approved.judgment.method,'model-supported-primary-evidence');assert.equal(approved.judgment.historyHash,sha);
 assert.equal(approved.judgment.claims[0].quoteStart,0);assert.equal(approved.judgment.claims[0].quoteEnd,Array.from(body).length);
 for(const mutate of [r=>r.claims[0].quote='invented',r=>r.claims[0].contentSha256=sha,r=>r.claims[0].url='https://evil.example/x',r=>r.claims[0].quoteEnd=1,r=>r.claims.pop(),r=>r.editorial.political=true,r=>r.extra=true]){
  const copy=structuredClone(result);mutate(copy);await assert.rejects(validateVerificationResult(copy,input));
 }
});
test('incomplete/private/stale/future evidence and model defer cannot issue approval',async()=>{
 const {input,result}=await fixture();
 for(const mutate of [x=>x.sources[0].fetchedAt='2026-11-15T00:00:00Z',x=>x.sources[0].body+='changed',x=>x.evidence[0].visibility='private',x=>x.evidence[0].sourceType='bluesky',x=>x.history.complete=false]){
  const copy=structuredClone(input);mutate(copy);await assert.rejects(validateVerificationResult(result,copy));
 }
 assert.deepEqual(await validateVerificationResult({action:'defer',reason:'Insufficient primary evidence.'},input),{action:'defer',reason:'Insufficient primary evidence.'});
 const old=structuredClone(result);old.publicationDate='2026-10-01';await assert.rejects(validateVerificationResult(old,input));
});

test('native original approves only exact native repost with actual post date and record quotes',async()=>{
 const did='did:plc:abcdefghijklmnopqrstuvwx',uri=`at://${did}/app.bsky.feed.post/3m3e4a2b22222`,cid='bafyre'+'a'.repeat(53),url=`https://bsky.app/profile/${did}/post/3m3e4a2b22222`,now=new Date().toISOString(),date=now.slice(0,10);
 const original={posts:[{uri,cid,author:{did,description:'Profile metadata is not original post evidence.'},record:{$type:'app.bsky.feed.post',text:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',createdAt:now},labels:[]}]},body=JSON.stringify(original);
 const contentSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),b=>b.toString(16).padStart(2,'0')).join('');
 const evidence={id:'native:1',url,nativeUrl:url,nativeUri:uri,nativeCid:cid,nativeAuthorDid:did,text:'Discovery only.',sourceType:'bluesky',visibility:'public',sourceLinks:[url]};
 const input={storyKey:'a'.repeat(64),evidenceHash:'b'.repeat(64),evidence:[evidence],sources:[{evidenceId:evidence.id,url,contentSha256,fetchedAt:now,body,fetchedUrl:'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris='+encodeURIComponent(uri),nativeUri:uri,nativeCid:cid,nativeAuthorDid:did}],history:{snapshotHash:'c'.repeat(64),items:[],complete:true},now};
 const result={action:'approve',editorial:{mode:'repost',political:false,change:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',evidenceIds:[evidence.id]},publicationDate:date,scopeReason:'Direct work relevance.',changeReason:'A new capability.',dedupReason:'No previous event match.',claims:[{claim:'🦀 Official "quoted" release\nPath C:\\models\\new is available.',quote:original.posts[0].record.text},{claim:date,quote:date}].map(c=>({...c,evidenceId:evidence.id,url,contentSha256}))};
 const out=await validateVerificationResult(result,input);assert.equal(out.editorial.mode,'repost');assert.equal(out.editorial.summary,undefined);assert.ok(out.judgment.claims.every(c=>Number.isInteger(c.quoteStart)));assert.equal(out.judgment.claims[0].originalQuote,original.posts[0].record.text);assert.equal(out.judgment.claims[0].quote,JSON.stringify(original.posts[0].record.text).slice(1,-1));assert.equal(Array.from(body).slice(out.judgment.claims[0].quoteStart,out.judgment.claims[0].quoteEnd).join(''),out.judgment.claims[0].quote);
 const nativeFormat=buildVerificationRequest(input,{model:'openai/gpt-oss-120b',maxOutputTokens:4096}).response_format;
 const branch=nativeFormat.json_schema.schema.properties.result.anyOf.find(b=>b.properties.action.enum[0]==='approve');assert.deepEqual(branch.properties.supports.required,['change','publicationDate']);assert.deepEqual(branch.properties.editorial.properties.mode.enum,['repost']);
 const wire={...result,supports:{change:{evidenceId:evidence.id,quote:original.posts[0].record.text},publicationDate:{evidenceId:evidence.id,quote:date}}};delete wire.claims;assert.deepEqual((await validateVerificationResult(wire,input)).judgment.claims,out.judgment.claims);
 const v3payload=JSON.parse(buildVerificationRequest(input,{model:'openai/gpt-oss-120b',maxOutputTokens:4096}).messages[1].content),refs=v3payload.sources[0].quoteReferences;
 const v3wire={...result,supports:{change:refs[0].id,publicationDate:refs[1].id}};delete v3wire.claims;const v3validated=await validateVerificationResult(v3wire,input);assert.deepEqual(v3validated.judgment.claims[0],out.judgment.claims[0]);assert.equal(v3validated.judgment.claims[1].originalQuote,original.posts[0].record.createdAt);assert.equal(v3validated.judgment.publicationDate,date);
 for(const [field,reference] of [['change',v3payload.sources[0].bodyChunks[0].id],['publicationDate',refs[0].id]]){const bad=structuredClone(v3wire);bad.supports[field]=reference;await assert.rejects(validateVerificationResult(bad,input));}

 for(const mutate of [x=>x.editorial.summary='Invented commentary',x=>{delete x.editorial.mode;x.editorial.summary='A summary';x.editorial.whyItMatters='A reason';},x=>x.claims[0].quote=original.posts[0].author.description,x=>x.publicationDate='2000-01-01']){
  const bad=structuredClone(result);mutate(bad);await assert.rejects(()=>validateVerificationResult(bad,input));
 }
});
test('private result archival is bounded, structurally strict and omits credentials while preserving semantic failures',async()=>{
 const {boundedVerificationAuditResult}=await import('./verification-contract.mjs');assert.equal(typeof boundedVerificationAuditResult,'function');
 const {result}=await fixture();assert.deepEqual(boundedVerificationAuditResult(result),result);assert.deepEqual(boundedVerificationAuditResult({action:'defer',reason:'Model reasoning.'}),{action:'defer',reason:'Model reasoning.'});
 for(const bad of [{...result,extra:'unknown'}, {...result,claims:[{...result.claims[0],quote:'x'.repeat(3001)}]}, {action:'defer',reason:'x'.repeat(1001)},{action:'defer',reason:'secret credential'}])assert.equal(boundedVerificationAuditResult(bad,'secret'),undefined);
 const semantic=structuredClone(result);semantic.editorial.political=true;semantic.publicationDate='not a date';semantic.claims=[];assert.deepEqual(boundedVerificationAuditResult(semantic),semantic);
});
test('result archive aggregate byte ceiling and typed semantic reasons are independent',async()=>{
 const {boundedVerificationAuditResult,VerificationValidationError}=await import('./verification-contract.mjs');
 const {input,result}=await fixture();const large=structuredClone(result);large.claims=Array.from({length:20},()=>({...large.claims[0],claim:'x'.repeat(3000),quote:'x'.repeat(3000)}));assert.equal(boundedVerificationAuditResult(large),undefined);
 for(const [mutate,code] of [[r=>r.publicationDate='not-date','verification_date_invalid'],[r=>r.claims[0].quote='not captured','verification_quote_missing'],[r=>r.claims[0].claim='different supported assertion','verification_claim_coverage_missing']]){const bad=structuredClone(result);mutate(bad);await assert.rejects(validateVerificationResult(bad,input),e=>e instanceof VerificationValidationError&&e.code===code&&!e.message.includes('not captured'));}
});
test('private audit omits PostgreSQL-invalid strings while preserving newlines and astral emoji',async()=>{
 const {boundedVerificationAuditResult}=await import('./verification-contract.mjs');const {result}=await fixture();
 for(const invalid of ['nul\u0000text','lone\ud800high','lone\udffflow']){
 assert.equal(boundedVerificationAuditResult({action:'defer',reason:invalid}),undefined);
 for(const mutate of [r=>r.editorial.summary=invalid,r=>r.editorial.evidenceIds=[invalid],r=>r.claims[0].url=invalid,r=>r.claims[0].quote=invalid,r=>r.scopeReason=invalid]){const bad=structuredClone(result);mutate(bad);assert.equal(boundedVerificationAuditResult(bad),undefined);}
 }
 const good={action:'defer',reason:'Normal newline\nAstral emoji 🦀 preserved.'};assert.deepEqual(boundedVerificationAuditResult(good),good);
});
test('V2 source-aware wire requires named date support and cannot repost RSS or use ISO timestamps',async()=>{
 const {buildVerificationResponseFormat,normalizeVerificationResult}=await import('./verification-contract.mjs');assert.equal(typeof buildVerificationResponseFormat,'function');
 const {input,result}=await fixture(),format=buildVerificationResponseFormat(input,{version:'2026-11-17.verify.2'}),branches=format.json_schema.schema.properties.result.anyOf;
 const approve=branches.find(b=>b.properties.action.enum[0]==='approve');assert.equal(approve.properties.editorial.properties.mode,undefined);assert.deepEqual(approve.properties.supports.required,['summary','whyItMatters','change','publicationDate']);assert.equal(approve.properties.publicationDate.pattern,'^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
 const wire={...result,supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map((field,i)=>[field,{evidenceId:'e1',quote:result.claims[i].quote}]))};delete wire.claims;
 const normalized=normalizeVerificationResult(wire,input);assert.deepEqual(normalized,result);assert.equal((await validateVerificationResult(wire,input)).action,'approve');
 for(const mutate of [r=>delete r.supports.publicationDate,r=>r.supports.summary.evidenceId='unknown',r=>r.claims=[],r=>r.publicationDate+='T00:00:00Z']){const bad=structuredClone(wire);mutate(bad);await assert.rejects(validateVerificationResult(bad,input));}
});
test('V3 lossless source chunks use trusted quote references rather than copied model text',async()=>{
 const {projectVerificationInput,reconstructVerificationInput,normalizeVerificationResult}=await import('./verification-contract.mjs');assert.equal(typeof projectVerificationInput,'function');
 const {input,result}=await fixture();input.evidence[0].url='https://ir.amd.com/fixture-release';input.sources[0].url=input.evidence[0].url;
 input.sources[0].body='x'.repeat(2499)+'🦀\n'+body;input.sources[0].contentSha256=await digest(input.sources[0].body);
 const projected=projectVerificationInput(input),source=projected.sources[0];assert.equal(source.body,undefined);assert.equal(source.bodyChunks.map(c=>c.text).join(''),input.sources[0].body);assert.ok(source.bodyChunks.every(c=>c.text.length<=2500&&!/[\uD800-\uDFFF]/u.test(c.text)));assert.deepEqual(reconstructVerificationInput(projected),input);
 const reference=source.bodyChunks.at(-1).id,wire={...result,supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,reference]))};delete wire.claims;
 const normalized=normalizeVerificationResult(wire,input);assert.equal(normalized.editorial.summary,'AMD reports: '+result.editorial.summary);assert.equal(normalized.claims[0].quote,source.bodyChunks.at(-1).text);assert.equal((await validateVerificationResult(wire,input)).action,'approve');
 for(const id of ['invented quote','source-2-chunk-0001']){const bad=structuredClone(wire);bad.supports.summary=id;await assert.rejects(validateVerificationResult(bad,input));}
 const forged=structuredClone(projected);forged.sources[0].bodyChunks[0].id='forged';assert.throws(()=>reconstructVerificationInput(forged));
});
test('V3 quote IDs preserve real narrow spaces and slash dates without model quote reconstruction',async()=>{
 const {projectVerificationInput}=await import('./verification-contract.mjs');const {input,result}=await fixture();input.evidence[0].url='https://rocm.blogs.amd.com/artificial-intelligence/fixture/README.html';input.sources[0].url=input.evidence[0].url;input.sources[0].body='<time>2026/11/11</time> AMD reports 7.16\u202f× for this specific cached workload.\nExact raw HTML remains.';input.sources[0].contentSha256=await digest(input.sources[0].body);
 const reference=projectVerificationInput(input).sources[0].bodyChunks[0].id,wire={...result,publicationDate:'2026-11-11',supports:Object.fromEntries(['summary','whyItMatters','change','publicationDate'].map(k=>[k,reference]))};delete wire.claims;
 const validated=await validateVerificationResult(wire,input);assert.equal(validated.judgment.claims[0].quote,input.sources[0].body);assert.equal(validated.judgment.claims[0].quoteEnd,Array.from(input.sources[0].body).length);assert.equal(validated.editorial.summary.startsWith('AMD reports: '),true);
 wire.supports.summary=input.sources[0].body.replace('\u202f',' ').replace('2026/11/11','2026-11-11');await assert.rejects(validateVerificationResult(wire,input));
});
test('V3 raw NUL/lone-surrogate sources are rejected before a request can be built',async()=>{
 const {input}=await fixture();for(const bad of ['bad\u0000body','bad\ud800body']){const raw=structuredClone(input);raw.sources[0].body=bad;assert.throws(()=>buildVerificationRequest(raw,{model:'openai/gpt-oss-120b',maxOutputTokens:4096}));}
});
test('V3 prompt has one reference-only support protocol while V2 copied-quote wording remains historical',async()=>{
 const {input}=await fixture();input.evidence[0].url='https://ir.amd.com/fixture-release';input.sources[0].url=input.evidence[0].url;
 const options={model:'openai/gpt-oss-120b',maxOutputTokens:4096};const fresh=buildVerificationRequest(input,options),old=buildVerificationRequest(input,{...options,version:'2026-11-17.verify.2'});
 assert.equal(fresh.messages[0].content.includes('Each support is exactly {evidenceId,quote}'),false);assert.equal(old.messages[0].content.includes('Each support is exactly {evidenceId,quote}'),true);assert.match(fresh.messages[0].content,/never copied or normalized quote text/);assert.match(fresh.messages[0].content,/cache\/prefix or concurrency qualifications/);assert.equal(JSON.parse(fresh.messages[1].content).sources[0].body,undefined);assert.equal(JSON.parse(old.messages[1].content).sources[0].body,input.sources[0].body);
});
test('semantic approval text remains valid for normal newlines and astral emoji',async()=>{
 const {input,result}=await fixture();result.scopeReason='Direct engineering relevance.\n🦀 Local inference.';result.changeReason='A supported capability.\n🧪';const approved=await validateVerificationResult(result,input);assert.equal(approved.action,'approve');assert.equal(approved.judgment.scopeReason,result.scopeReason);assert.equal(approved.judgment.changeReason,result.changeReason);
});
test('V4 provider grammar rejects the concrete V3 oversized/unsupported schema without loosening local proof',async()=>{
 const {assertCerebrasSchemaCompatibility,cerebrasSchemaMetrics,buildVerificationResponseFormat}=await import('./verification-contract.mjs');assert.equal(typeof assertCerebrasSchemaCompatibility,'function');
 const {input}=await fixture();input.evidence[0].url='https://github.com/lemonade-sdk/lemonade/releases/tag/candidate-v2026.46.2';input.sources[0].url=input.evidence[0].url;const id='urn:warpcore:rss:lemonade_releases:tag%3Agithub.com%2C2008%3ARepository%2F984341155%2Fcandidate-v2026.46.2';input.evidence[0].id=id;input.sources[0].evidenceId=id;input.sources[0].body='x'.repeat(200000);
 const failed=buildVerificationResponseFormat(input,{version:'2026-11-17.verify.3'}).json_schema.schema;assert.ok(cerebrasSchemaMetrics(failed).countedText>5000);assert.throws(()=>assertCerebrasSchemaCompatibility(failed));
 const current=buildVerificationResponseFormat(input).json_schema.schema,metrics=assertCerebrasSchemaCompatibility(current);assert.ok(metrics.countedText<=5000);assert.ok(metrics.totalEnumValues<=500);assert.ok(metrics.totalProperties<=500);assert.ok(metrics.maxDepth<=10);assert.deepEqual(metrics.unsupportedKeywords,[]);
 for(const patch of [{pattern:'x'},{minItems:1},{maxItems:1},{minLength:1},{maxLength:1}])assert.throws(()=>assertCerebrasSchemaCompatibility({type:'object',properties:{value:{type:'string',...patch}},required:['value'],additionalProperties:false}));
});
test('V4 prompt exposes numeric trusted editorial caps without changing explicit V3 history',async()=>{
 const {input}=await fixture();input.evidence[0].url='https://ir.amd.com/fixture-release';input.sources[0].url=input.evidence[0].url;const options={model:'openai/gpt-oss-120b',maxOutputTokens:4096};const current=buildVerificationRequest(input,options),old=buildVerificationRequest(input,{...options,version:'2026-11-17.verify.3'});
 assert.match(current.messages[0].content,/V4 TRUSTED EDITORIAL LIMITS:/);assert.equal(old.messages[0].content.includes('V4 TRUSTED EDITORIAL LIMITS:'),false);assert.match(current.messages[0].content,/"summaryMaxLength":[0-9]+/);assert.match(current.messages[0].content,/"whyItMattersMaxLength":[0-9]+/);assert.match(current.messages[0].content,/"evidenceIdsExactly":\["e1"\]/);
});
test('GitHub API provenance reconstructs exact raw JSON and binds approval date to published_at',async()=>{
 const {projectVerificationInput,reconstructVerificationInput}=await import('./verification-contract.mjs');
 const {input,result}=await fixture(),url='https://github.com/lemonade-sdk/lemonade/releases/tag/v2026.47.1';
 input.evidence[0].url=url;const raw=JSON.stringify({html_url:url,tag_name:'v2026.47.1',draft:false,prerelease:true,published_at:'2026-11-16T12:00:00Z',body:'Actual release notes. 🦀'});
 Object.assign(input.sources[0],{url,body:raw,contentSha256:await digest(raw),captureKind:'github-release-v1',fetchedUrl:'https://api.github.com/repos/lemonade-sdk/lemonade/releases/tags/v2026.47.1'});
 for(const c of result.claims)Object.assign(c,{url,contentSha256:input.sources[0].contentSha256,quote:raw});
 assert.deepEqual(reconstructVerificationInput(projectVerificationInput(input)),input);assert.equal((await validateVerificationResult(result,input)).judgment.publicationDate,'2026-11-16');
 const wrongDate=structuredClone(result);wrongDate.publicationDate='2026-11-15';wrongDate.claims.at(-1).claim=wrongDate.publicationDate;await assert.rejects(validateVerificationResult(wrongDate,input),error=>error.code==='verification_date_invalid');
 for(const patch of [{fetchedUrl:input.sources[0].fetchedUrl+'/other'},{captureKind:'github-release-v2'}]){const bad=structuredClone(input);Object.assign(bad.sources[0],patch);assert.throws(()=>projectVerificationInput(bad));}
 const projected=projectVerificationInput(input);projected.sources[0].bodyChunks[0].id='source-9-chunk-0001';assert.throws(()=>reconstructVerificationInput(projected));
});
