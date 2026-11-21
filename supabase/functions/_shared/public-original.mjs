// Shared public-original guard for captured verification and the final send check.
// Identity alone is insufficient: moderation/publicness can change without a CID change.
const fail=()=>{throw Error('Native verification evidence rejected');};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function warningLabels(value,depth=0){
 if(depth>40)fail();
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){
  if(key==='labels'&&!(Array.isArray(child)&&child.length===0||plain(child)&&Array.isArray(child.values)&&child.values.length===0))fail();
  if(['blocked','blockedBy','blocking','notFound','private','muted'].includes(key)&&child!==false&&child!==null&&child!==undefined)fail();
  warningLabels(child,depth+1);
 }
}
export function validatePublicOriginal(data,subject,authorDid,now=new Date().toISOString()){
 if(!plain(data)||!Array.isArray(data.posts)||data.posts.length!==1||Object.keys(data).some(k=>k!=='posts'))fail();
 const post=data.posts[0],record=post?.record;
 if(!plain(post)||post.uri!==subject.uri||post.cid!==subject.cid||post.author?.did!==authorDid
 ||post.$type!==undefined&&post.$type!=='app.bsky.feed.defs#postView'||!plain(record)||record.$type!=='app.bsky.feed.post'
 ||typeof record.text!=='string'||!record.text.trim()||record.text.length>3000||typeof record.createdAt!=='string')fail();
 warningLabels(post);
 const created=Date.parse(record.createdAt),time=Date.parse(now);
 if(!Number.isFinite(created)||!Number.isFinite(time)||created>time+300000||created<time-7*86400000)fail();
 return {text:record.text,createdAt:record.createdAt,publicationDate:new Date(created).toISOString().slice(0,10),subject:{uri:post.uri,cid:post.cid}};
}
