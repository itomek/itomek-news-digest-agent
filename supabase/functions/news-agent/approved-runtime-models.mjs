// Code-reviewed choices only. No request, source or model can extend this registry.
// These are budget ceilings, not model-quality evidence or activation authority.
export const DEFAULT_RUNTIME_MODEL='openai/gpt-oss-120b';
export const APPROVED_RUNTIME_MODELS=Object.freeze([
 Object.freeze({model:'meta-llama/llama-4-maverick',provider:'Parasail',discoveryProfileVersion:'2026-11-17.7',maxCostCredits:.216269,maxOutputTokens:4096,reviewBatchSize:16}),
 Object.freeze({model:DEFAULT_RUNTIME_MODEL,provider:'Cerebras',discoveryProfileVersion:'2026-11-17.6',maxCostCredits:.076596,maxOutputTokens:8192,reviewBatchSize:16}),
 Object.freeze({model:'nvidia/nemotron-3.5-super-vl',provider:'Together',discoveryProfileVersion:'2026-11-17.5',maxCostCredits:.157287,maxOutputTokens:4096,reviewBatchSize:16}),
 Object.freeze({model:'nvidia/nemotron-3-super-120b-a12b',provider:'DeepInfra',discoveryProfileVersion:'2026-11-17.2',maxCostCredits:.026215,maxOutputTokens:4096,reviewBatchSize:16}),
]);
export const approvedRuntimeModel=model=>APPROVED_RUNTIME_MODELS.find(item=>item.model===model);
