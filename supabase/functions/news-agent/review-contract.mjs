import {RANKING_RUBRIC_VERSION} from './ranking-rubric.mjs';
// Trusted discovery request controls. No model, price or provider default is selected.
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const DISCOVERY_RESPONSE_FORMAT=freeze({type:'json_schema',json_schema:{name:'discovery_review',strict:true,schema:{type:'object',properties:{decisions:{type:'array',items:{type:'object',properties:{id:{type:'string'},action:{type:'string',enum:['skip','verify']},reason:{type:'string'}},required:['id','action','reason'],additionalProperties:false}}},required:['decisions'],additionalProperties:false}}});
const rankedFormat=structuredClone(DISCOVERY_RESPONSE_FORMAT);
rankedFormat.json_schema.name='discovery_ranked_review';
Object.assign(rankedFormat.json_schema.schema.properties.decisions.items.properties,{importance:{type:'integer',minimum:0,maximum:4},relevance:{type:'integer',minimum:0,maximum:4}});
rankedFormat.json_schema.schema.properties.decisions.items.required.push('importance','relevance');
export const DISCOVERY_RANKED_RESPONSE_FORMAT=freeze(rankedFormat);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
function matchesExact(value,expected){
 if(Array.isArray(expected))return Array.isArray(value)&&value.length===expected.length&&expected.every((v,i)=>matchesExact(value[i],v));
 if(object(expected))return exactKeys(value,Object.keys(expected))&&Object.keys(expected).every(k=>matchesExact(value[k],expected[k]));
 return value===expected;
}
export const isRankedDiscoveryFormat=value=>matchesExact(value,DISCOVERY_RANKED_RESPONSE_FORMAT);
export const matchesDiscoveryFormat=(value,ids)=>matchesExact(value,DISCOVERY_RESPONSE_FORMAT)||isRankedDiscoveryFormat(value)||isKeyedRankedDiscoveryFormat(value,ids);
// Required object properties make full candidate coverage part of decoding,
// rather than relying on an unconstrained decision-array length.
export function buildKeyedRankedDiscoveryFormat(ids){
 if(!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id.length>256||/\p{Cc}/u.test(id)))throw Error('Invalid keyed discovery candidate IDs');
 const value=structuredClone(DISCOVERY_RANKED_RESPONSE_FORMAT.json_schema.schema.properties.decisions.items);
 delete value.properties.id;value.required=value.required.filter(k=>k!=='id');
 return freeze({type:'json_schema',json_schema:{name:'discovery_keyed_ranked_review',strict:true,schema:{type:'object',properties:{decisions:{type:'object',properties:Object.fromEntries(ids.map(id=>[id,structuredClone(value)])),required:[...ids],additionalProperties:false}},required:['decisions'],additionalProperties:false}}});
}
export function isKeyedRankedDiscoveryFormat(value,ids){
 try{return matchesExact(value,buildKeyedRankedDiscoveryFormat(ids));}catch{return false;}
}
export function validateProviderPolicy(provider){
 const hasZdr=object(provider)&&Object.hasOwn(provider,'zdr');
 if(!exactKeys(provider,hasZdr?['only','order','allow_fallbacks','require_parameters','max_price','zdr']:['only','order','allow_fallbacks','require_parameters','max_price'])||(hasZdr&&provider.zdr!==true)||!Array.isArray(provider.only)||provider.only.length!==1||typeof provider.only[0]!=='string'||provider.only[0].length>128||!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(provider.only[0])||!Array.isArray(provider.order)||provider.order.length!==1||provider.order[0]!==provider.only[0]||provider.allow_fallbacks!==false||provider.require_parameters!==true||!exactKeys(provider.max_price,['prompt','completion','request'])||!Number.isFinite(provider.max_price.prompt)||provider.max_price.prompt<=0||!Number.isFinite(provider.max_price.completion)||provider.max_price.completion<=0||provider.max_price.request!==0)throw Error('Invalid discovery provider policy');
 return structuredClone(provider);
}
export function validateReasoningControl(reasoning){
 if(!exactKeys(reasoning,['effort'])||!['none','low'].includes(reasoning.effort))throw Error('Invalid discovery reasoning control');
 return {effort:reasoning.effort};
}
export function validateRequestProfile(profile){
 const hasReasoning=object(profile)&&Object.hasOwn(profile,'reasoning');
 const keyed=profile?.version==='2026-11-16.4',ranked=keyed||profile?.version==='2026-11-16.3';
 if(!exactKeys(profile,ranked?['version','provider','responseFormat','reasoning','rankingRubricVersion']:hasReasoning?['version','provider','responseFormat','reasoning']:['version','provider','responseFormat'])||!['2026-11-15.2','2026-11-16.1','2026-11-16.2','2026-11-16.3','2026-11-16.4'].includes(profile.version)||profile.responseFormat!==(keyed?'discovery-keyed-ranked-json-schema-v3':ranked?'discovery-ranked-json-schema-v2':'discovery-json-schema-v1')||(ranked&&profile.rankingRubricVersion!==RANKING_RUBRIC_VERSION))throw Error('Invalid discovery request profile');
 if(['2026-11-16.1','2026-11-16.2','2026-11-16.3','2026-11-16.4'].includes(profile.version)&&profile.provider?.zdr!==true||profile.version==='2026-11-15.2'&&Object.hasOwn(profile.provider??{},'zdr'))throw Error('Incompatible discovery ZDR policy');
 const requiredEffort=(ranked||profile.version==='2026-11-16.2')?'low':'none';
 if((profile.version!=='2026-11-15.2'&&!hasReasoning)||(hasReasoning&&profile.reasoning?.effort!==requiredEffort))throw Error('Incompatible discovery reasoning policy');
 return {...(ranked?{rankingRubricVersion:RANKING_RUBRIC_VERSION}:{}),version:profile.version,provider:validateProviderPolicy(profile.provider),responseFormat:profile.responseFormat,...(hasReasoning?{reasoning:validateReasoningControl(profile.reasoning)}:{})};
}
