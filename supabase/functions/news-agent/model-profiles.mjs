import {RANKING_RUBRIC_VERSION} from './ranking-rubric.mjs';
// Research-derived allowlist, not paid-call authorization or a model-quality verdict.
// Sources/snapshots: docs/warpcore-model-validation-research.md. Price ceilings
// use the listed long-context tier for Haiku/Luna; Gemini promotion changes fail
// routing closed. Revalidate every pricing dimension before reserving paid usage.
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const profile=(provider,prompt,completion,disableReasoning=false)=>freeze({version:'2026-11-15.2',...(disableReasoning?{reasoning:{effort:'none'}}:{}),responseFormat:'discovery-json-schema-v1',provider:{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0}}});
// New open-model profiles are pilot candidates only; SQL binding/activation is separate.
const openProfile=(provider,prompt,completion)=>freeze({version:'2026-11-16.1',reasoning:{effort:'none'},responseFormat:'discovery-json-schema-v1',provider:{only:[provider],order:[provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt,completion,request:0},zdr:true}});
const nvidiaProfile=(version,tag,prompt,completion)=>freeze({...openProfile(tag,prompt,completion),version,responseFormat:'discovery-keyed-ranked-json-schema-v3',rankingRubricVersion:RANKING_RUBRIC_VERSION});
const profiles=freeze({
 'nvidia/nemotron-3.5-super-vl':nvidiaProfile('2026-11-17.1','deepinfra/fp4',.15,.50),
 'nvidia/nemotron-3-super-120b-a12b':nvidiaProfile('2026-11-17.2','deepinfra/bf16',.075,.40),
 'anthropic/claude-haiku-5.5':profile('anthropic',0.5,2.5,true),
 'openai/gpt-5.6-luna':profile('openai',0.4,1.8,true),
 'google/gemini-3.8-flash':profile('google-ai-studio',0.75,3.75),
 'google/gemma-4-26b-a4b-it':openProfile('primeintellect/bf16',0.06,0.18),
 'google/gemma-4-31b-it':openProfile('deepinfra/fp8',0.20,0.40),
 'openai/gpt-oss-120b':freeze({version:'2026-11-16.2',reasoning:{effort:'low'},responseFormat:'discovery-json-schema-v1',provider:{only:['groq'],order:['groq'],allow_fallbacks:false,require_parameters:true,max_price:{prompt:0.15,completion:0.60,request:0},zdr:true}}),
});
const rankedGptOss=freeze({...profiles['openai/gpt-oss-120b'],version:'2026-11-16.3',responseFormat:'discovery-ranked-json-schema-v2',rankingRubricVersion:RANKING_RUBRIC_VERSION});
const keyedGptOss=freeze({...rankedGptOss,version:'2026-11-16.4',responseFormat:'discovery-keyed-ranked-json-schema-v3'});
const stageAwareNvidia=freeze({...profiles['nvidia/nemotron-3.5-super-vl'],version:'2026-11-17.3'});
const codedNvidia=freeze({...stageAwareNvidia,version:'2026-11-17.4',responseFormat:'discovery-keyed-coded-ranking-json-schema-v4'});
const togetherNvidia=freeze({...codedNvidia,version:'2026-11-17.5',provider:{...codedNvidia.provider,only:['together'],order:['together']}});
export function requestProfileForModel(model,version){
 if(typeof model!=='string'||!Object.hasOwn(profiles,model))return undefined;
 const current=model==='openai/gpt-oss-120b'?keyedGptOss:model==='nvidia/nemotron-3.5-super-vl'?togetherNvidia:profiles[model];
 if(version===undefined||version===current.version)return current;
 if(model==='nvidia/nemotron-3.5-super-vl'&&version===codedNvidia.version)return codedNvidia;
 if(model==='nvidia/nemotron-3.5-super-vl'&&version===stageAwareNvidia.version)return stageAwareNvidia;
 if(model==='openai/gpt-oss-120b'&&version===rankedGptOss.version)return rankedGptOss;
 return version===profiles[model].version?profiles[model]:undefined;
}

// Exact reviewed upstream display identities; historical profiles remain optional.
const expectedProviders=freeze({'nvidia/nemotron-3.5-super-vl':'DeepInfra','nvidia/nemotron-3-super-120b-a12b':'DeepInfra','google/gemma-4-26b-a4b-it':'PrimeIntellect','google/gemma-4-31b-it':'DeepInfra','openai/gpt-oss-120b':'Groq'});
export function expectedProviderForModel(model,version){
 if(typeof model!=='string'||!Object.hasOwn(expectedProviders,model))return undefined;
 const selected=requestProfileForModel(model,version);if(!selected)return undefined;
 return model==='nvidia/nemotron-3.5-super-vl'&&selected.version==='2026-11-17.5'?'Together':expectedProviders[model];
}
