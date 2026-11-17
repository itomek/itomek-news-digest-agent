import {fetchCapturedEvidence} from './source-verification.mjs';
import {isApprovedPrimarySourceUrl} from './primary-source-policy.mjs';
const fail=()=>{throw Error('GitHub release evidence rejected');};
export const GITHUB_RELEASE_CAPTURE_KIND='github-release-v1';
// PostgreSQL decodes JSON escapes when casting the raw API capture to jsonb.
// Check decoded keys and values as well as the unchanged raw body.
function validateDecodedJson(value,depth=0){
 if(depth>40)fail();
 if(typeof value==='string'){if(/\u0000|[\uD800-\uDFFF]/u.test(value))fail();return;}
 if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){validateDecodedJson(key,depth+1);validateDecodedJson(child,depth+1);}
}

export function githubReleaseIdentity(url){
 if(!isApprovedPrimarySourceUrl(url))fail();
 const match=/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/([A-Za-z0-9._+~-]+)$/.exec(url);
 if(!match)fail();
 return {url,captureKind:GITHUB_RELEASE_CAPTURE_KIND,fetchedUrl:'https://api.github.com/repos/'+match[1]+'/releases/tags/'+match[2],tag:match[2]};
}
export function validateGithubReleaseCapture(source,evidence,now=new Date().toISOString()){
 const identity=githubReleaseIdentity(source?.url);
 if(typeof evidence?.sourceType!=='string'||evidence.sourceType==='bluesky'||evidence?.visibility!=='public'||source.evidenceId!==evidence.id||![evidence.url,...(evidence.sourceLinks??[])].includes(identity.url)||source.captureKind!==identity.captureKind||source.fetchedUrl!==identity.fetchedUrl||typeof source.body!=='string'||new TextEncoder().encode(source.body).length>100000)fail();
 let data;try{data=JSON.parse(source.body);}catch{fail();}
 validateDecodedJson(data);
 if(!data||typeof data!=='object'||Array.isArray(data)||data.html_url!==identity.url||data.tag_name!==identity.tag||data.draft!==false||typeof data.prerelease!=='boolean'||typeof data.body!=='string'||typeof data.published_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(data.published_at))fail();
 const date=Date.parse(data.published_at),time=Date.parse(now);
 if(!Number.isFinite(date)||!Number.isFinite(time)||date>time+300000||date<time-7*86400000||new Date(date).toISOString().slice(0,10)!==data.published_at.slice(0,10))fail();
 return {publicationDate:new Date(date).toISOString().slice(0,10),prerelease:data.prerelease};
}
export async function fetchGithubReleaseEvidence({url,evidence,fetcher,maxBytes=100000,timeoutMs=10000,now=()=>new Date().toISOString()}={}){
 const {tag,...identity}=githubReleaseIdentity(url);
 if(evidence?.visibility!=='public'||typeof evidence.sourceType!=='string'||evidence.sourceType==='bluesky'||typeof evidence.id!=='string'||![evidence.url,...(evidence.sourceLinks??[])].includes(url))fail();
 const fetched=await fetchCapturedEvidence({url:identity.fetchedUrl,evidence:{id:evidence?.id,url:identity.fetchedUrl,sourceType:'github-public-release-lookup',visibility:'public',sourceLinks:[]},config:{enabled:true,allowedHosts:['api.github.com'],maxBytes,timeoutMs:Math.min(timeoutMs,10000)},fetcher});
 if(fetched.contentType!=='application/json')fail();
 const source={evidenceId:evidence?.id,...identity,contentSha256:fetched.contentSha256,fetchedAt:fetched.fetchedAt,body:fetched.body};
 validateGithubReleaseCapture(source,evidence,now());return Object.freeze(source);
}
