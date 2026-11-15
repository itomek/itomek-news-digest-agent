// Trusted discovery request controls. No model, price or provider default is selected.
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const DISCOVERY_RESPONSE_FORMAT=freeze({type:'json_schema',json_schema:{name:'discovery_review',strict:true,schema:{type:'object',properties:{decisions:{type:'array',items:{type:'object',properties:{id:{type:'string'},action:{type:'string',enum:['skip','verify']},reason:{type:'string'}},required:['id','action','reason'],additionalProperties:false}}},required:['decisions'],additionalProperties:false}}});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
export function matchesDiscoveryFormat(value,expected=DISCOVERY_RESPONSE_FORMAT){
 if(Array.isArray(expected))return Array.isArray(value)&&value.length===expected.length&&expected.every((v,i)=>matchesDiscoveryFormat(value[i],v));
 if(object(expected))return exactKeys(value,Object.keys(expected))&&Object.keys(expected).every(k=>matchesDiscoveryFormat(value[k],expected[k]));
 return value===expected;
}
export function validateProviderPolicy(provider){
 if(!exactKeys(provider,['only','order','allow_fallbacks','require_parameters','max_price'])||!Array.isArray(provider.only)||provider.only.length!==1||typeof provider.only[0]!=='string'||provider.only[0].length>128||!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(provider.only[0])||!Array.isArray(provider.order)||provider.order.length!==1||provider.order[0]!==provider.only[0]||provider.allow_fallbacks!==false||provider.require_parameters!==true||!exactKeys(provider.max_price,['prompt','completion','request'])||!Number.isFinite(provider.max_price.prompt)||provider.max_price.prompt<=0||!Number.isFinite(provider.max_price.completion)||provider.max_price.completion<=0||provider.max_price.request!==0)throw Error('Invalid discovery provider policy');
 return structuredClone(provider);
}
export function validateRequestProfile(profile){
 if(!exactKeys(profile,['version','provider','responseFormat'])||profile.version!=='2026-11-15.1'||profile.responseFormat!=='discovery-json-schema-v1')throw Error('Invalid discovery request profile');
 return {version:profile.version,provider:validateProviderPolicy(profile.provider),responseFormat:profile.responseFormat};
}
