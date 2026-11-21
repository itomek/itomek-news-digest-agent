import { isIP } from 'node:net';
import { isPublicAddress } from './public-evidence-transport.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evaluateDecisions } from './evaluation.mjs';
import { requestProfileForModel } from './model-profiles.mjs';
import { POLICY_VERSION } from './policy.mjs';
const MODEL='google/gemma-4-26b-a4b-it';
const fail=message=> {
  throw new Error(message);
};
const text=(v, name)=> {
  if (typeof v!=='string'||!v.trim()||v.length>20000)fail(`Invalid ${name}`);
};
const list=(v, name)=> {
  if (!Array.isArray(v)||v.length>10000)fail(`Invalid ${name}`);
};
const date=(v, name)=> {
  if (typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().replace('.000Z', 'Z')!==v.replace('.000Z', 'Z'))fail(`Invalid ${name}`);
  return Date.parse(v);
};
function unique(items, name) {
  list(items, name);
  const ids=new Set();
  for (const item of items) {
    text(item?.id, `${name} id`);
    if (ids.has(item.id))fail(`Duplicate ${name} id`);
    ids.add(item.id);
  }
  return ids;
}
function storyUrl(raw) {
  const u=new URL(raw);
  const host=u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (u.protocol!=='https:'||u.username||u.password||/(^|\.)(localhost|local|localdomain|internal|test|invalid|home|lan)$/.test(host)||(isIP(host)&&!isPublicAddress(host)))fail('Public HTTPS story URL required');
  u.hash='';
  return u.href;
}
function authority(r) {
  text(r?.reviewer, 'reviewer');
  text(r?.authority, 'label authority');
}
function canonical(value) {
  if (Array.isArray(value))return value.map(canonical);
  if (value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k, canonical(value[k])]));
  return value;
}
export function canonicalLabelsDigest(cases) {
  list(cases, 'cases');
  return createHash('sha256').update(JSON.stringify(canonical([...cases].sort((a, b)=>a.id<b.id?-1:a.id>b.id?1:0)))).digest('hex');
}
// Pure saved-evidence inspection: no fetching, inference, mutation, publication or truth claim.
export function evaluateCampaign(m) {
  if (!m||m.schemaVersion!==1)fail('Unsupported campaign schemaVersion');
  if (m.rubricVersion!=='2026-11-21.1')fail('Unsupported rubricVersion');
  const frozen=date(m.frozenAt, 'frozenAt');
  unique(m.cases, 'case');
  const storyUrls=new Set();
  for (const c of m.cases) {
    if (date(c.sourceCreatedAt, 'sourceCreatedAt')>frozen)fail('Source date must not follow freeze');
    text(c.rationale, 'label rationale');
    authority(c.review);
    if (typeof c.review.independent!=='boolean')fail('Independent human review attestation required');
    if (date(c.sourceCreatedAt, 'sourceCreatedAt')>date(c.review.reviewedAt, 'label reviewedAt'))fail('Source date must not follow label review');
    if (date(c.review.reviewedAt, 'label reviewedAt')>frozen)fail('Labels must be reviewed before freeze');
    const normalized=storyUrl(c.sourceUrl);
    if (storyUrls.has(normalized))fail('Distinct public story provenance required');
    storyUrls.add(normalized);
  }
  if (m.labelsDigest!==canonicalLabelsDigest(m.cases))fail('Canonical labels digest mismatch');
  // Also validates actions, case identifiers and public HTTPS provenance.
  evaluateDecisions(m.cases, []);
  const runIds=new Set();
  const scheduledSlots=new Set();
  const runReports=[];
  function run(r, empty=false) {
    const evidenceClass=empty?'controlled-empty-input':'saved-model-inference';
    text(r?.id, 'run id');
    if (runIds.has(r.id))fail('Duplicate run id');
    runIds.add(r.id);
    if (!['pending', 'complete', 'deferred', 'failed'].includes(r.status))fail('Invalid run status');
    if (r.status==='pending') {
      runReports.push( {
        id:r.id,
        status:r.status, evidenceClass
      });
      return false;
    }
    const start=date(r.invokedAt, 'invokedAt'), end=date(r.completedAt, 'completedAt');
    if (start<=frozen||end<start)fail('Invalid freeze/invocation/completion ordering');
    if (empty) {
      if (r.controlled!==true||!['local', 'mock', 'cloud'].includes(r.environment)||r.modelCalls!==0||r.costCredits!==0)fail('Controlled empty checks require explicit environment, zero modelCalls and zero costCredits');
    } else if (r.model!==MODEL||r.provider!=='PrimeIntellect'||r.policyVersion!==POLICY_VERSION||!isDeepStrictEqual(r.requestProfile, requestProfileForModel(MODEL, '2026-11-17.8')))fail('Incorrect deployed model/provider/policy/profile route');
    if (!(r.costCredits===null&&['deferred', 'failed'].includes(r.status))&&(typeof r.costCredits!=='number'||!Number.isFinite(r.costCredits)||r.costCredits<0))fail('Invalid actual costCredits');
    text(r.evidenceRef, 'run evidenceRef');
    runReports.push( {
      id:r.id,
      status:r.status, evidenceClass,
      costUnit:'OpenRouter credits',
      environment:r.environment, ...(empty? {
        controlled:true,
        modelCalls:0
      }
      : {
      }
      ),
      invokedAt:r.invokedAt,
      completedAt:r.completedAt, ...(empty? {
      }
      : {
        model:r.model,
        provider:r.provider,
        policyVersion:r.policyVersion,
        requestProfile:r.requestProfile
      }
      ),
      costCredits:r.costCredits,
      evidenceRef:r.evidenceRef
    });
    return r.status==='complete';
  }
  const heldoutComplete=run(m.heldout);
  const score=m.heldout.status==='pending'?null:evaluateDecisions(m.cases, m.heldout.decisions);
  let reviewsPass=true, reviewedOutputs=0;
  const outputIds=new Set();
  function inspectOutputs(r, allowed, decisions, heldout=false) {
    unique(r.outputs, 'output');
    for (const o of r.outputs) {
      if (!allowed.has(o.candidateId))fail('Output must reference a captured candidate');
      const candidate = decisions.get(o.candidateId);
      const sourceEvidence = heldout ? o.sourceEvidenceRef : candidate?.sourceEvidenceRef;
      if (sourceEvidence !== undefined) text(sourceEvidence, 'saved sourceEvidenceRef');
      const hasSourceEvidence = !!sourceEvidence || (!heldout && candidate?.retrieval?.status === 'attempted' && !!candidate.retrieval.evidenceRef);
      if (candidate?.action !== 'verify' || !hasSourceEvidence) reviewsPass = false;
      if (outputIds.has(o.id))fail('Duplicate output id across cycles');
      outputIds.add(o.id);
      if (!['draft', 'native-subject'].includes(o.kind))fail('Invalid output kind');
      text(o.contentRef, 'complete rendered output contentRef');
      const review=o.review;
      if (!review||review.status==='pending') {
        reviewsPass=false;
        continue;
      }
      authority(review);
      reviewedOutputs++;
      if (date(review.reviewedAt, 'output reviewedAt')<date(r.completedAt, 'completedAt'))fail('Output review precedes completion');
      if (review.completeRenderedText!==true)fail('Complete rendered text review required');
      for (const field of ['unsupported', 'duplicate', 'misattributed']) {
        if (!Number.isSafeInteger(review[field])||review[field]<0)fail(`Invalid human review ${field}`);
        if (review[field]!==0)reviewsPass=false;
      }
    }
    if (typeof r.outputsComplete!=='boolean')fail('Explicit outputsComplete inventory attestation required');
    if (!r.outputsComplete)reviewsPass=false;
  }
  if (m.heldout.status!=='pending') {
    inspectOutputs(m.heldout, new Set(m.cases.map(c=>c.id)), new Map(m.heldout.decisions.map(decision => [decision.id, decision])), true);
    Object.assign(runReports.find(r=>r.id===m.heldout.id), {
      outputs:m.heldout.outputs,
      outputsComplete:m.heldout.outputsComplete,
      missingDecisions:score.missing
    });
  }
  function cycle(r, empty) {
    const complete=run(r, empty);
    if (r.status==='pending')return false;
    if (!empty) {
      if (r.scheduled!==true||r.environment!=='cloud')fail('Scheduled cloud evidence required');
      const slot=date(r.scheduledSlot, 'scheduledSlot');
      if (slot%3600000!==0||slot>date(r.invokedAt, 'invokedAt')||scheduledSlots.has(slot))fail('Invalid or duplicate scheduled slot');
      scheduledSlots.add(slot);
    }
    text(r.captureRef, 'captureRef');
    unique(r.candidates, 'candidate');
    unique(r.outputs, 'output');
    list(r.capturedCandidateIds, 'capturedCandidateIds');
    const captured=new Set();
    for (const id of r.capturedCandidateIds) {
      text(id, 'captured candidate id');
      if (captured.has(id))fail('Duplicate captured candidate id');
      captured.add(id);
    }
    if (r.candidates.some(c=>!captured.has(c.id)))fail('Candidate absent from captured inventory');
    const coverage=r.candidates.length===captured.size;
    for (const c of r.candidates) {
      if (!['complete', 'deferred', 'failed'].includes(c.status))fail('Invalid candidate status');
      text(c.evidenceRef, 'candidate decision/status evidenceRef');
      if (c.status==='complete') {
        if (!['verify', 'skip'].includes(c.action))fail('Invalid discovery action');
        text(c.reason, 'discovery reason');
      }
      if (c.retrieval?.status==='not_attempted')text(c.retrieval.reason, 'retrieval not attempted reason');
      else if (c.retrieval?.status==='attempted')text(c.retrieval.evidenceRef, 'retrieval attempt evidenceRef');
      else fail('Explicit retrieval disposition required');
    }
    if (empty) {
      if (typeof r.outputsComplete!=='boolean')fail('Explicit outputsComplete inventory attestation required');
    } else inspectOutputs(r, captured, new Map(r.candidates.map(candidate => [candidate.id, candidate])));
    Object.assign(runReports.find(report=>report.id===r.id), {
      scheduledSlot:r.scheduledSlot,
      captureRef:r.captureRef,
      captured:r.capturedCandidateIds.length,
      accounted:r.candidates.length,
      missing:r.capturedCandidateIds.filter(id=>!r.candidates.some(c=>c.id===id)),
      candidateCounts:Object.fromEntries(['complete', 'deferred', 'failed'].map(status=>[status, r.candidates.filter(c=>c.status===status).length])),
      candidates:r.candidates,
      outputs:r.outputs,
      outputsComplete:r.outputsComplete
    });
    return complete&&coverage&&r.candidates.every(c=>c.status==='complete')&&(empty?r.outputsComplete&&captured.size===0&&r.candidates.length===0&&r.outputs.length===0:r.candidates.length>0);
  }
  list(m.cycles, 'cycles');
  list(m.emptyChecks, 'emptyChecks');
  const cycles=m.cycles.map(r=>cycle(r, false));
  const empties=m.emptyChecks.map(r=>cycle(r, true));
  const gates= {
    frozenIndependentCorpus:m.cases.length>=20&&m.cases.every(c=>c.review.independent),
    heldout:!!(heldoutComplete&&score?.complete&&score.precision.denominator>0&&score.recall.denominator>0&&score.precision.value>=.9&&score.recall.value>=.9),
    scheduledCycles:cycles.filter(Boolean).length>=3&&cycles.every(Boolean),
    emptyChecks:empties.length>0&&empties.every(Boolean),
    outputReview:reviewsPass&&reviewedOutputs>0
  };
  return {
    schemaVersion:1,
    rubricVersion:m.rubricVersion, runReports, gates,
    unmetGates:Object.keys(gates).filter(k=>!gates[k]),
    heldout:score,
    reportedEvidencePass:Object.values(gates).every(Boolean),
    independence:'Self-attested human review; digest checks label integrity only.',
    modelQualityProven:false,
    publishingEnabled:false,
    remainingRequirements:['Public readback evidence', 'Owner go/no-go']
  };
}
