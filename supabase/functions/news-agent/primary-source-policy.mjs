// Private verification boundary, reviewed against news-collect/initial-sources.json
// (43-source roster). This is a provenance allowlist, not factual verification or
// a declaration that unsupported sites cannot be primary. Quotes, actual dates,
// scope, meaningful change and dedup still require the existing receipt checks.
// Callers MUST intersect this policy with configured allowedSourceHosts; this
// module grants no network egress, follows no redirects and performs no I/O.
// Native public originals retain their separate pinned-identity repost path.
export const PRIMARY_SOURCE_POLICY_VERSION='2026-11-17.1';
const ORIGINS=new Set([
 'ir.amd.com','rocm.blogs.amd.com','blogs.nvidia.com','openai.com',
 'www.anthropic.com','blog.google','deepmind.google','research.google',
 'mistral.ai','supabase.com','firebase.blog','www.apple.com','newsroom.arm.com',
 'www.intc.com','pytorch.org','github.blog','www.perplexity.ai',
 'omarchy.org','milfordtownship.org','buckslib.org',
]);
const RELEASE_REPOS=new Set([
 'lemonade-sdk/lemonade','ROCm/TheRock','ggml-org/llama.cpp',
 'vllm-project/vllm','ollama/ollama','ml-explore/mlx','anthropics/claude-code',
]);
export function isApprovedPrimarySourceUrl(raw){
 if(typeof raw!=='string'||raw.length>2048||/[\s\\%?#]/u.test(raw))return false;
 // Reject explicit ports (including :443), credentials and noncanonical hosts
 // before URL can erase/normalize those distinctions.
 const authority=/^https:\/\/([a-z0-9.-]+)\//.exec(raw);
 if(!authority)return false;
 let url;try{url=new URL(raw);}catch{return false;}
 if(url.href!==raw||url.origin!=='https://'+authority[1]||url.username||url.password||url.port||url.search||url.hash||url.pathname.includes('//'))return false;
 if(url.hostname==='github.com'){
  const match=/^\/([^/]+\/[^/]+)\/releases(?:\/tag\/([A-Za-z0-9._+~-]+))?\/?$/.exec(url.pathname);
  return !!match&&RELEASE_REPOS.has(match[1]);
 }
 if(url.hostname==='huggingface.co'){
  // Only the roster's first-party blog namespace, never community-author blog
  // paths or model/dataset/user repositories on this multi-tenant origin.
  return /^\/blog\/[a-z0-9][a-z0-9-]*\/?$/.test(url.pathname);
 }
 if(url.hostname==='devblogs.microsoft.com')return /^\/(dotnet|visualstudio)(\/|$)/.test(url.pathname);
 return ORIGINS.has(url.hostname);
}

// Friendly publisher identity for approved provenance only. This label does not
// assert independent confirmation; callers retain the exact source-bound proof.
const PUBLISHERS=Object.freeze({
 'ir.amd.com':'AMD','rocm.blogs.amd.com':'AMD','blogs.nvidia.com':'NVIDIA',
 'openai.com':'OpenAI','www.anthropic.com':'Anthropic','blog.google':'Google',
 'deepmind.google':'Google','research.google':'Google','mistral.ai':'Mistral',
 'supabase.com':'Supabase','firebase.blog':'Firebase','www.apple.com':'Apple',
 'newsroom.arm.com':'Arm','www.intc.com':'Intel','pytorch.org':'PyTorch',
 'github.blog':'GitHub','www.perplexity.ai':'Perplexity','omarchy.org':'Omarchy',
 'milfordtownship.org':'Milford Township','buckslib.org':'Bucks County Free Library',
 'huggingface.co':'Hugging Face','devblogs.microsoft.com':'Microsoft',
});
const PROJECT_PUBLISHERS=Object.freeze({
 'lemonade-sdk/lemonade':'Lemonade','ROCm/TheRock':'AMD',
 'ggml-org/llama.cpp':'llama.cpp','vllm-project/vllm':'vLLM',
 'ollama/ollama':'Ollama','ml-explore/mlx':'MLX','anthropics/claude-code':'Anthropic',
});
export function primarySourceAttributionLabel(raw){
 if(!isApprovedPrimarySourceUrl(raw))return undefined;
 const url=new URL(raw);
 if(url.hostname==='github.com')return PROJECT_PUBLISHERS[url.pathname.split('/').slice(1,3).join('/')];
 return PUBLISHERS[url.hostname];
}
