import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {registry,createBlueskyAdapter} from './adapters.mjs';
import {validateConfig} from '../bluesky-collect/core.mjs';
import {MAX_SOURCES} from '../_shared/pipeline.mjs';
test('roster retains existing sources plus official frontier sources',async()=>{
 const roster=JSON.parse(await fs.readFile(new URL('./initial-sources.json',import.meta.url),'utf8'));
 assert.equal(roster.length,43);assert.ok(roster.length<=MAX_SOURCES);assert.equal(new Set(roster.map(s=>s.id)).size,43);
 for(const source of roster)assert.equal(typeof registry[source.adapter]?.collect,'function');
 const native=roster.filter(s=>s.adapter==='bluesky');assert.equal(native.length,4);
 const expected={'simonwillison.net':'did:plc:kft6lu4trxowqmter2b6vg6z','arstechnica.com':'did:plc:wld6fad6xsm4tz4kfkoikun2','theregister.com':'did:plc:bz67dxqh5nmjl5it36xylqyy','techcrunch.com':'did:plc:vtpyqvwce4x6gpa5dcizqecy'};
 for(const source of native){
  validateConfig(source.config);const [actor]=source.config.actors;assert.equal(source.config.actors.length,1);
  assert.equal(source.config.actorDids[actor],expected[actor]);assert.ok(source.config.terms.length>0);
  let captured;const adapter=createBlueskyAdapter(async config=>{captured=config;return {sources:[{status:'ok'}],candidates:[]};});
  assert.deepEqual(await adapter.collect(source.config),[]);assert.deepEqual(captured.actorDids,source.config.actorDids);
 }
 assert.equal(roster.filter(s=>s.adapter!=='bluesky').length,39);
});
