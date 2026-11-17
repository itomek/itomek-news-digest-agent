// Research-derived allowlist, not paid-call authorization or a model-quality verdict.
// Sources/snapshots: docs/warpcore-model-validation-research.md. Price ceilings
// use the listed long-context tier for Haiku/Luna; Gemini promotion changes fail
// routing closed. Revalidate every pricing dimension before reserving paid usage.
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const profile=(provider,prompt,completion,disableReasoning=false)=>freeze({version:'2026-11-15.2',...(disableReasoning?{reasoning:{effort:'none'}}:{}),responseFormat:'discovery-json-schema-v1',provider:{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0}}});
// New open-model profiles are pilot candidates only; SQL binding/activation is separate.
const openProfile=(provider,prompt,completion)=>freeze({version:'2026-11-16.1',reasoning:{effort:'none'},responseFormat:'discovery-json-schema-v1',provider:{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0},zdr:true}});
const profiles=freeze({
 'anthropic/claude-haiku-5.5':profile('anthropic',0.5,2.5,true),
 'openai/gpt-5.6-luna':profile('openai',0.4,1.8,true),
 'google/gemini-3.8-flash':profile('google-ai-studio',0.75,3.75),
 'google/gemma-4-26b-a4b-it':openProfile('primeintellect/bf16',0.06,0.18),
 'google/gemma-4-31b-it':openProfile('deepinfra/fp8',0.20,0.40),
});
export function requestProfileForModel(model){return typeof model==='string'&&Object.hasOwn(profiles,model)?profiles[model]:undefined;}

// Exact reviewed upstream display identities; historical profiles remain optional.
const expectedProviders=freeze({'google/gemma-4-26b-a4b-it':'PrimeIntellect','google/gemma-4-31b-it':'DeepInfra'});
export function expectedProviderForModel(model){return typeof model==='string'&&Object.hasOwn(expectedProviders,model)?expectedProviders[model]:undefined;}
