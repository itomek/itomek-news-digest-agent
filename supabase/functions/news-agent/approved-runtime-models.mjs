// Code-reviewed choices only. No request, source or model can extend this registry.
// These are budget ceilings, not model-quality evidence or activation authority.
export const DEFAULT_RUNTIME_MODEL='openai/gpt-oss-120b';
export const APPROVED_RUNTIME_MODELS=Object.freeze([
 Object.freeze({model:DEFAULT_RUNTIME_MODEL,provider:'Cerebras',discoveryProfileVersion:'2026-11-17.6',maxCostCredits:.076596,maxOutputTokens:8192,reviewBatchSize:16}),
 Object.freeze({model:'google/gemma-4-26b-a4b-it',provider:'PrimeIntellect',discoveryProfileVersion:'2026-11-17.8',maxCostCredits:.036045,maxOutputTokens:4096,reviewBatchSize:16}),
]);
export const approvedRuntimeModel=model=>APPROVED_RUNTIME_MODELS.find(item=>item.model===model);
