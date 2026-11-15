// Research-derived allowlist, not paid-call authorization or a model-quality verdict.
// Sources/snapshots: docs/warpcore-model-validation-research.md. Price ceilings
// use the listed long-context tier for Haiku/Luna; Gemini promotion changes fail
// routing closed. Revalidate every pricing dimension before reserving paid usage.
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const profile=(provider,prompt,completion)=>freeze({version:'2026-11-15.1',responseFormat:'discovery-json-schema-v1',provider:{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0}}});
const profiles=freeze({
 'anthropic/claude-haiku-5.5':profile('anthropic',0.5,2.5),
 'openai/gpt-5.6-luna':profile('openai',0.4,1.8),
 'google/gemini-3.8-flash':profile('google-ai-studio',0.75,3.75),
});
export function requestProfileForModel(model){return typeof model==='string'&&Object.hasOwn(profiles,model)?profiles[model]:undefined;}
