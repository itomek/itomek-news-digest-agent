#!/usr/bin/env node
// Local preparation only. No database, model, session, approval, or network modules.
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createReviewPacket} from '../supabase/functions/_shared/curation.mjs';
const keys=['storyKey','evidence','editorial','attributionChecks'];
export async function prepareLocalReview(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw Error('Unsupported input fields');
 if(!Array.isArray(input.attributionChecks)||input.attributionChecks.length>20)throw Error('Attribution checks required');
 const packet=await createReviewPacket(input);
 const checks=new Map();
 for(const c of input.attributionChecks){if(!c||typeof c.evidenceId!=='string'||c.checked!==true||checks.has(c.evidenceId)||Object.keys(c).some(k=>!['evidenceId','checked'].includes(k)))throw Error('Invalid attribution check');checks.set(c.evidenceId,true);}
 if(packet.evidence.some(e=>!checks.has(e.id))||checks.size!==packet.evidence.length)throw Error('Check attribution for each selected evidence item');
 const text=[packet.recordDraft.summary,packet.recordDraft.whyItMatters,...packet.recordDraft.links].join('\n\n');
 const graphemes=[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(text)].length;
 if(graphemes>300||new TextEncoder().encode(text).length>3000)throw Error('Preview exceeds Bluesky length limit');
 return {mode:'local_review_only',publishable:false,attributionVerification:'operator_attested_not_independently_verified',packet,postPreview:text,graphemes};
}
export async function runCLI(args){
 if(args.length!==4||args[0]!=='--input'||args[2]!=='--output'||!args[1]||!args[3])throw Error('Usage: --input draft.json --output review.json');
 const file=await open(args[1],'r');let input;
 try{if(!(await file.stat()).isFile())throw Error('Regular input file required');const buffer=Buffer.alloc(524289);let total=0;while(total<buffer.length){const {bytesRead}=await file.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}if(total>524288)throw Error('Input exceeds 512 KiB');input=JSON.parse(buffer.subarray(0,total).toString('utf8'));}finally{await file.close();}
 const result=await prepareLocalReview(input);
 // Never replace existing files. Private mode applies to newly created output.
 const output=await open(args[3],'wx',0o600);
 try{await output.writeFile(JSON.stringify(result,null,2)+'\n');}finally{await output.close();}
 return {mode:result.mode,approved:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await runCLI(process.argv.slice(2));console.log('Local review saved. Not approved or published.');}
 catch{console.error('Review preparation failed. Check the documented input schema, attribution checks, length limit, and unused output filename. No approval or publishing occurred.');process.exitCode=1;}
}
