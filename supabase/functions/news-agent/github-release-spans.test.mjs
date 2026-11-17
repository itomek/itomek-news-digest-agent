import test from 'node:test';import assert from 'node:assert/strict';
import {githubReleaseStringSpans} from './github-release-spans.mjs';
test('top-level release fields bind exact raw escaped lexemes, not nested assets or string decoys',()=>{
 const raw=JSON.stringify({assets:[{body:'metadata body',published_at:'wrong'}],description:'fake "body": "metadata"',body:'Release 🦀 "quotes"\\path\nnew capability',published_at:'2026-11-16T12:00:00Z'});
 const spans=githubReleaseStringSpans(raw),parsed=JSON.parse(raw);for(const key of ['body','published_at'])assert.equal(JSON.parse('"'+raw.slice(spans[key].start,spans[key].end)+'"'),parsed[key]);assert.equal(raw.slice(spans.body.start,spans.body.end).includes('metadata'),false);
});
test('ambiguous duplicates, nonstring fields and malformed JSON are rejected',()=>{
 for(const raw of ['{"body":"a","body":"b","published_at":"d"}','{"body":"a","bo\\u0064y":"b","published_at":"d"}','{"body":"a","published_at":"d","published_at":"e"}','{"body":null,"published_at":"d"}','{"body":"a"}','[]','{"body":"a","published_at":"d"} trailing'])assert.throws(()=>githubReleaseStringSpans(raw));
});
