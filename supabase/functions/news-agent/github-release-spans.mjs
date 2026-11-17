// Lexical locations in the unchanged GitHub API response, not extracted content.
// JSON.parse validates syntax; the bounded scanner distinguishes top-level keys
// from nested assets and string decoys, including escaped key spellings.
export function githubReleaseStringSpans(raw){
 const fail=()=>{throw Error('Ambiguous GitHub release JSON fields');};
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>100000)fail();
 let parsed;try{parsed=JSON.parse(raw);}catch{fail();}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail();
 let i=0;const spans={},keys=new Set();
 const whitespace=()=>{while(/[\x20\t\r\n]/.test(raw[i]??'')&&i<raw.length)i++;};
 function string(){
  if(raw[i++]!=='"')fail();const start=i;
  while(i<raw.length){if(raw[i]==='\\'){i+=2;continue;}if(raw[i]==='"'){const end=i++;return {start,end,value:JSON.parse(raw.slice(start-1,end+1))};}i++;}fail();
 }
 function value(depth){
  if(depth>40)fail();whitespace();
  if(raw[i]==='"')return string();
  if(raw[i]==='{'){
   i++;whitespace();if(raw[i]==='}'){i++;return;}
   for(;;){whitespace();const key=string();if(depth===0){if(keys.has(key.value))fail();keys.add(key.value);}whitespace();if(raw[i++]!==':')fail();const item=value(depth+1);
    if(depth===0&&['body','published_at'].includes(key.value)){if(!item||item.value!==parsed[key.value]||typeof item.value!=='string')fail();spans[key.value]={start:item.start,end:item.end};}
    whitespace();if(raw[i]==='}'){i++;return;}if(raw[i++]!==',')fail();}
  }
  if(raw[i]==='['){i++;whitespace();if(raw[i]===']'){i++;return;}for(;;){value(depth+1);whitespace();if(raw[i]===']'){i++;return;}if(raw[i++]!==',')fail();}}
  const start=i;while(i<raw.length&&!/[\x20\t\r\n,}\]]/.test(raw[i]))i++;if(i===start)fail();
 }
 value(0);whitespace();if(i!==raw.length||!spans.body||!spans.published_at)fail();return spans;
}
