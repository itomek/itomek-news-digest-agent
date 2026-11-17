// Fixed, local pilot authorization ledger. No model HTTP, key lookup or date reset.
// A reservation is consumed before dispatch; uncertainty never authorizes replay.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const CAMPAIGN='2026-11-15',BUDGET=2000000n,MAX_ATTEMPTS=24,VERSION=1;
const repository=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const inside=(candidate,root)=>candidate===root||candidate.startsWith(root+path.sep);
// Convert the exact decimal rendering of the supplied finite JS number into
// integer microUSD, rounding upward without floating-point multiplication loss.
function microUsd(value){
 const [mantissa,power='0']=value.toString().toLowerCase().split('e');
 const [whole,fraction='']=mantissa.split('.');
 const coefficient=BigInt(whole+fraction),shift=6+Number(power)-fraction.length;
 if(shift>=0)return coefficient*10n**BigInt(shift);
 const divisor=10n**BigInt(-shift);return (coefficient+divisor-1n)/divisor;
}
function privateFile(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw Error('Absolute private ledger path required');
 const absolute=path.resolve(file);
 if(inside(absolute,repository))throw Error('Ledger must be outside repository');
 const parent=path.dirname(absolute);
 fs.mkdirSync(parent,{recursive:true,mode:0o700});
 const realParent=fs.realpathSync(parent);
 if(inside(realParent,repository))throw Error('Ledger must be outside repository');
 const directory=fs.statSync(realParent);
 if(!directory.isDirectory()||(directory.mode&0o077)!==0)throw Error('Ledger parent must be private with 0700 permissions');
 try{const fd=fs.openSync(absolute,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}
 const stat=fs.lstatSync(absolute);
 if(stat.isSymbolicLink()||!stat.isFile())throw Error('Ledger must be a regular file, never a symbolic link');
 if((stat.mode&0o777)!==0o600)throw Error('Ledger file must have 0600 permissions');
 return absolute;
}
export function openPilotLedger(file){
 const db=new DatabaseSync(privateFile(file));let closed=false;
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  const names=db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all().map(row=>row.name);
  if(names.some(name=>!['campaign','attempts'].includes(name)))throw Error('Unknown campaign ledger schema');
  db.exec(`CREATE TABLE IF NOT EXISTS campaign(
   singleton INTEGER PRIMARY KEY CHECK(singleton=1),campaign_id TEXT NOT NULL,
   budget_microusd TEXT NOT NULL,max_attempts INTEGER NOT NULL,version INTEGER NOT NULL,
   blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN(0,1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS attempts(
   id TEXT PRIMARY KEY,request_hash TEXT NOT NULL UNIQUE,model TEXT NOT NULL,
   reservation_microusd TEXT NOT NULL,reservation_usd TEXT NOT NULL,
   status TEXT NOT NULL CHECK(status IN('reserved','dispatched','uncertain','settled')),
   cost_microusd TEXT,cost_usd TEXT,outcome TEXT CHECK(outcome IN('success','failure')),
   created_at TEXT NOT NULL,dispatched_at TEXT,settled_at TEXT
  ) STRICT;`);
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare('INSERT OR IGNORE INTO campaign(singleton,campaign_id,budget_microusd,max_attempts,version) VALUES(1,?,?,?,?)').run(CAMPAIGN,BUDGET.toString(),MAX_ATTEMPTS,VERSION);
   const config=db.prepare('SELECT * FROM campaign').all();
   if(config.length!==1||config[0].singleton!==1||config[0].campaign_id!==CAMPAIGN||config[0].budget_microusd!==BUDGET.toString()||config[0].max_attempts!==MAX_ATTEMPTS||config[0].version!==VERSION)throw Error('Campaign configuration mismatch; limits cannot change');
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }catch(error){db.close();throw error;}
 const transaction=fn=>{
  if(closed)throw Error('Ledger is closed');db.exec('BEGIN IMMEDIATE');
  try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
 };
 const rows=()=>db.prepare('SELECT * FROM attempts ORDER BY created_at,id').all();
 const totals=attempts=>{
  let held=0n,spent=0n;
  for(const attempt of attempts){if(attempt.status==='settled')spent+=BigInt(attempt.cost_microusd);else held+=BigInt(attempt.reservation_microusd);}
  return {held,spent};
 };
 const get=id=>{if(typeof id!=='string')throw Error('Invalid attempt ID');const attempt=db.prepare('SELECT * FROM attempts WHERE id=?').get(id);if(!attempt)throw Error('Unknown attempt ID');return attempt;};
 return {
  reserve({requestHash,model,reservationUsd}={}){
   if(typeof requestHash!=='string'||!/^[a-f0-9]{64}$/.test(requestHash))throw Error('Invalid request hash');
   if(typeof model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model))throw Error('Invalid model');
   if(!Number.isFinite(reservationUsd)||reservationUsd<=0||reservationUsd>2)throw Error('Invalid reservation USD');
   const amount=microUsd(reservationUsd);
   return transaction(()=>{
    const attempts=rows(),config=db.prepare('SELECT blocked FROM campaign WHERE singleton=1').get();
    if(config.blocked)throw Error('Campaign spending blocked');
    if(attempts.some(a=>a.request_hash===requestHash))throw Error('Duplicate request; no automatic retry');
    if(attempts.some(a=>a.status!=='settled'))throw Error('Existing in-flight attempt requires reconciliation');
    if(attempts.length>=MAX_ATTEMPTS)throw Error('Campaign attempt limit reached');
    const {held,spent}=totals(attempts);
    if(spent+held+amount>BUDGET)throw Error('Campaign budget exhausted');
    const id=randomUUID();
    db.prepare("INSERT INTO attempts(id,request_hash,model,reservation_microusd,reservation_usd,status,created_at) VALUES(?,?,?,?,?,'reserved',?)").run(id,requestHash,model,amount.toString(),reservationUsd.toString(),new Date().toISOString());
    return id;
   });
  },
  markDispatched(id){return transaction(()=>{const attempt=get(id);if(attempt.status!=='reserved')throw Error('Dispatch already recorded or attempt held; no retry');db.prepare("UPDATE attempts SET status='dispatched',dispatched_at=? WHERE id=?").run(new Date().toISOString(),id);});},
  markUncertain(id){return transaction(()=>{const attempt=get(id);if(attempt.status==='settled')throw Error('Immutable settled attempt');if(attempt.status!=='uncertain')db.prepare("UPDATE attempts SET status='uncertain' WHERE id=?").run(id);});},
  settle(id,{costUsd,outcome}={}){
   if(!Number.isFinite(costUsd)||costUsd<0)throw Error('Invalid actual cost USD');
   if(!['success','failure'].includes(outcome))throw Error('Invalid settlement outcome');
   const amount=microUsd(costUsd),raw=costUsd.toString();
   return transaction(()=>{
    const attempt=get(id);
    if(attempt.status==='settled'){
     if(attempt.cost_usd!==raw||attempt.outcome!==outcome)throw Error('Immutable settlement');
     return;
    }
    if(attempt.status==='reserved')throw Error('Dispatch not recorded');
    db.prepare("UPDATE attempts SET status='settled',cost_microusd=?,cost_usd=?,outcome=?,settled_at=? WHERE id=?").run(amount.toString(),raw,outcome,new Date().toISOString(),id);
    if(costUsd>Number(attempt.reservation_usd)||amount>BigInt(attempt.reservation_microusd)||totals(rows()).spent>BUDGET)db.prepare('UPDATE campaign SET blocked=1 WHERE singleton=1').run();
   });
  },
  snapshot(){return transaction(()=>{
   const attempts=rows(),{held,spent}=totals(attempts),blocked=db.prepare('SELECT blocked FROM campaign WHERE singleton=1').get().blocked===1;
   return {campaignId:CAMPAIGN,budgetMicrousd:BUDGET.toString(),maxAttempts:MAX_ATTEMPTS,attemptCount:attempts.length,heldMicrousd:held.toString(),spentMicrousd:spent.toString(),blocked,inFlightAttempts:attempts.filter(a=>a.status!=='settled').length,
    attempts:attempts.map(a=>({id:a.id,requestHash:a.request_hash,model:a.model,status:a.status,reservationMicrousd:a.reservation_microusd,costMicrousd:a.cost_microusd,outcome:a.outcome,createdAt:a.created_at,dispatchedAt:a.dispatched_at,settledAt:a.settled_at}))};
  });},
  close(){if(!closed){db.close();closed=true;}},
 };
}
