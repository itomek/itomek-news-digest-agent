// Only native news reposts; never arbitrary AT Protocol collection writes.
export function repostSubject(value){
 if(!value||typeof value.uri!=='string'||!/^at:\/\/did:plc:[a-z2-7]{24}\/app\.bsky\.feed\.post\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value.uri)||typeof value.cid!=='string'||!/^bafyre[a-z2-7]{53}$/.test(value.cid))throw Error('Exact original post URI and CID required');
 return {uri:value.uri,cid:value.cid};
}
export function recordCollection(record){
 if(record?.$type==='app.bsky.feed.post')return record.$type;
 if(record?.$type==='app.bsky.feed.repost'){repostSubject(record.subject);if(Object.keys(record).some(k=>!['$type','subject','createdAt'].includes(k)))throw Error('Native repost must not contain copied text');return record.$type;}
 throw Error('Unsupported publication collection');
}
