import test from 'node:test';
import assert from 'node:assert/strict';
import {isApprovedPrimarySourceUrl,PRIMARY_SOURCE_POLICY_VERSION,primarySourceAttributionLabel} from './primary-source-policy.mjs';

test('reviewed first-party origins and exact official project releases are supported',()=>{
 assert.equal(PRIMARY_SOURCE_POLICY_VERSION,'2026-11-18.1');
 for(const url of [
  'https://rocm.blogs.amd.com/software-tools-optimization/example/index.html','https://ir.amd.com/news-events/press-releases/detail/1305/example',
  'https://openai.com/index/example/','https://www.anthropic.com/news/example','https://blog.google/products-and-platforms/products/search/example/',
  'https://deepmind.google/blog/example/','https://research.google/blog/example/','https://blogs.nvidia.com/blog/example/',
  'https://supabase.com/blog/example','https://firebase.blog/posts/2026/11/example','https://www.apple.com/newsroom/2026/11/example/',
  'https://mistral.ai/news/example','https://newsroom.arm.com/news/example','https://www.intc.com/news-events/press-releases/detail/1/example',
  'https://pytorch.org/blog/example/','https://github.blog/changelog/example/','https://www.perplexity.ai/hub/blog/example',
  'https://devblogs.microsoft.com/dotnet/example/','https://devblogs.microsoft.com/visualstudio/example/',
  'https://omarchy.org/news/example','https://milfordtownship.org/example/','https://buckslib.org/example/',
  'https://huggingface.co/blog/example-official-post',
  'https://github.com/lemonade-sdk/lemonade/releases/tag/v47.1.0',
  'https://github.com/ROCm/TheRock/releases/tag/therock-7.0',
  'https://github.com/ggml-org/llama.cpp/releases/tag/b1234',
  'https://github.com/vllm-project/vllm/releases/tag/v1.0',
  'https://github.com/ollama/ollama/releases/tag/v1.0',
  'https://github.com/ml-explore/mlx/releases/tag/v1.0',
  'https://github.com/anthropics/claude-code/releases/tag/v2.1.325',
 ])assert.equal(isApprovedPrimarySourceUrl(url),true,url);
});

test('secondary and unsupported publishers cannot become primary via an arbitrary project link',()=>{
 for(const url of [
  'https://arstechnica.com/ai/2026/11/example/',
  
  'https://example.com/primary-announcement','https://nvidia.com/example',
  'https://github.com/unknown/project/releases/tag/v1','https://github.com/lemonade-sdk/unknown/releases/tag/v1',
  'https://github.com/unknown/lemonade/releases/tag/v1','https://github.com/lemonade-sdk/lemonade-fork/releases/tag/v1',
  'https://github.com/lemonade-sdk/lemonade/issues/1','https://github.com/lemonade-sdk/lemonade/pull/1',
  'https://github.com/lemonade-sdk/lemonade/discussions/1','https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/README.md',
  'https://huggingface.co/blog/community/unsupported','https://huggingface.co/unknown/model','https://huggingface.co/nvidia/unknown',
  'https://devblogs.microsoft.com/community/example','https://bsky.app/profile/example/post/123',
 ])assert.equal(isApprovedPrimarySourceUrl(url),false,url);
});

test('noncanonical and namespace-confusing URLs fail closed without URL normalization privilege',()=>{
 const base='https://github.com/lemonade-sdk/lemonade/releases/tag/v1';
 for(const raw of [null,{},42,'',base+'#fragment',base+'?raw=1',base+'?',
  ' http://openai.com/index/example','https://openai.com/index/example ',
  'http://openai.com/index/example','https://openai.com:443/index/example','https://openai.com:8443/index/example',
  'https://user:pass@openai.com/index/example','https://openai.com@evil.example/example',
  'https://openai.com.evil.example/example','https://evil-openai.com/example','https://openai.com./example',
  'https://OPENAI.COM/example','https://openai.com/a/../example','https://openai.com//example',
  'https://openai.com/\\evil.example/example','https://openai.com/line\nbreak',
  'https://github.com/lemonade-sdk%2flemonade/releases/tag/v1',
  'https://github.com/lemonade-sdk/lemonade%2fother/releases/tag/v1',
  'https://github.com/lemonade-sdk/lemonade/releases/tag/%2e%2e',
  'https://github.com/lemonade-sdk/lemonade/releases/tag/v1/extra',
  'https://github.com/lemonade-sdk/lemonade/../unknown/releases/tag/v1',
  'https://huggingface.co/blog/%2funknown/post','https://huggingface.co/blog/../unknown/model',
 ])assert.equal(isApprovedPrimarySourceUrl(raw),false,String(raw));
});


test('every approved publisher and release repository has one deterministic friendly attribution label',()=>{
 const cases=[
  ['ir.amd.com','AMD'],['rocm.blogs.amd.com','AMD'],['blogs.nvidia.com','NVIDIA'],['openai.com','OpenAI'],
  ['www.anthropic.com','Anthropic'],['blog.google','Google'],['deepmind.google','Google'],['research.google','Google'],
  ['mistral.ai','Mistral'],['supabase.com','Supabase'],['firebase.blog','Firebase'],['www.apple.com','Apple'],
  ['newsroom.arm.com','Arm'],['www.intc.com','Intel'],['pytorch.org','PyTorch'],['github.blog','GitHub'],
  ['www.perplexity.ai','Perplexity'],['omarchy.org','Omarchy'],['milfordtownship.org','Milford Township'],['buckslib.org','Bucks County Free Library'],
 ];
 for(const [host,label] of cases){const url=`https://${host}/announcement`;assert.equal(isApprovedPrimarySourceUrl(url),true);assert.equal(primarySourceAttributionLabel(url),label,url);}
 for(const [path,label] of [['lemonade-sdk/lemonade','Lemonade'],['ROCm/TheRock','AMD'],['ggml-org/llama.cpp','llama.cpp'],['vllm-project/vllm','vLLM'],['ollama/ollama','Ollama'],['ml-explore/mlx','MLX'],['anthropics/claude-code','Anthropic']])assert.equal(primarySourceAttributionLabel(`https://github.com/${path}/releases/tag/v1`),label,path);
 assert.equal(primarySourceAttributionLabel('https://huggingface.co/blog/official-announcement'),'Hugging Face');
 assert.equal(primarySourceAttributionLabel('https://devblogs.microsoft.com/dotnet/announcement'),'Microsoft');
 assert.equal(primarySourceAttributionLabel('https://devblogs.microsoft.com/visualstudio/announcement'),'Microsoft');
});

test('unsupported publishers and URL lookalikes never receive an attribution label',()=>{
 for(const url of [null,{},'https://arstechnica.com/announcement','https://openai.com.evil.example/announcement','https://openai.com:443/announcement','https://user@openai.com/announcement','https://github.com/unknown/lemonade/releases/tag/v1','https://github.com/lemonade-sdk/lemonade/issues/1','https://github.com/lemonade-sdk/lemonade%2funknown/releases/tag/v1','https://huggingface.co/blog/community/announcement','https://devblogs.microsoft.com/unknown/announcement']){
  assert.equal(isApprovedPrimarySourceUrl(url),false);assert.equal(primarySourceAttributionLabel(url),undefined,String(url));
 }
});

test('configured reporting, GAIA releases and the exact Lemonade PR API can support attributed news',()=>{
 for(const url of ['https://www.theverge.com/science/voyager','https://www.technologyreview.com/2026/11/18/model','https://www.techpowerup.com/123/new-gpu','https://github.com/amd/gaia/releases/tag/v1','https://api.github.com/repos/lemonade-sdk/lemonade/pulls/4000'])assert.equal(isApprovedPrimarySourceUrl(url),true,url);
 for(const url of ['https://api.github.com/repos/unknown/project/pulls/4000','https://api.github.com/repos/lemonade-sdk/lemonade/issues/4000','https://api.github.com/repos/lemonade-sdk/lemonade/pulls/4000/files'])assert.equal(isApprovedPrimarySourceUrl(url),false,url);
});
