import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalLabelsDigest, evaluateCampaign } from './editorial-campaign.mjs';
import { requestProfileForModel } from './model-profiles.mjs';
import { POLICY_VERSION } from './policy.mjs';
const model='google/gemma-4-26b-a4b-it';
function fixture() {
  const cases=Array.from( {
    length:20
  }
  , (_, i)=>( {
    id:`c${i}`,
    sourceUrl:`https://example.org/story/${i}`,
    sourceCreatedAt:'2026-11-01T00:00:00Z',
    discoveryText:`Story ${i}`,
    expectedAction:i<10?'verify':'skip',
    rationale:'Human judgment',
    review: {
      reviewer:'human-a',
      authority:'editor',
      independent:true,
      reviewedAt:'2026-11-20T00:00:00Z'
    }
  }));
  const run=id=>( {
    id,
    status:'complete',
    invokedAt:'2026-11-21T01:00:00Z',
    completedAt:'2026-11-21T02:00:00Z', model,
    provider:'PrimeIntellect',
    policyVersion:POLICY_VERSION,
    requestProfile:requestProfileForModel(model, '2026-11-17.8'),
    costCredits:0.01,
    evidenceRef:'saved/run.json'
  });
  const cycle=id=>( {
    ...run(id),
    scheduledSlot:`2026-11-21T${({one:'01',two:'04',three:'07'})[id]}:00:00Z`,
    invokedAt:`2026-11-21T${({one:'01',two:'04',three:'07'})[id]}:00:00Z`,
    completedAt:`2026-11-21T${({one:'02',two:'05',three:'08'})[id]}:00:00Z`,
    scheduled:true,
    environment:'cloud',
    captureRef:'saved/capture.json',
    outputsComplete:true,
    capturedCandidateIds:[`${id}-candidate`],
    candidates:[ {
      id:`${id}-candidate`,
      status:'complete',
      action:'verify',
      reason:'Investigate development',
      evidenceRef:'saved/decision.json',
      retrieval: {
        status:'attempted',
        evidenceRef:'saved/source-retrieval.json'
      }
    }
    ],
    outputs:[ {
      id:`${id}-draft`,
      candidateId:`${id}-candidate`,
      kind:'draft',
      contentRef:'saved/draft.txt',
      review: {
        reviewer:'editor',
        authority:'owner',
        reviewedAt:`2026-11-21T${({one:'03',two:'06',three:'09'})[id]}:00:00Z`,
        completeRenderedText:true,
        unsupported:0,
        duplicate:0,
        misattributed:0
      }
    }
    ]
  });
  return {
    schemaVersion:1,
    rubricVersion:'2026-11-21.1',
    frozenAt:'2026-11-20T01:00:00Z',
    labelsDigest:canonicalLabelsDigest(cases), cases,
    heldout: {
      ...run('heldout'),
      outputsComplete:true,
      outputs:[],
      decisions:cases.map(c=>( {
        id:c.id,
        action:c.expectedAction,
        reason:'saved decision'
      }
      ))
    }
    ,
    cycles:[cycle('one'), cycle('two'), cycle('three')],
    emptyChecks:[ {
      id:'empty',
      status:'complete',
      invokedAt:'2026-11-21T01:00:00Z',
      completedAt:'2026-11-21T02:00:00Z',
      environment:'local',
      controlled:true,
      modelCalls:0,
      costCredits:0,
      evidenceRef:'saved/empty-check.json',
      captureRef:'saved/empty.json',
      outputsComplete:true,
      capturedCandidateIds:[],
      candidates:[],
      outputs:[]
    }
    ]
  };
}
test('reported evidence can pass without proving quality or enabling publishing', ()=> {
  const r=evaluateCampaign(fixture());
  assert.equal(r.reportedEvidencePass, true);
  assert.equal(r.modelQualityProven, false);
  assert.equal(r.publishingEnabled, false);
});
test('digest is canonical and tampering fails', ()=> {
  const m=fixture();
  assert.equal(canonicalLabelsDigest([...m.cases].reverse()), m.labelsDigest);
  m.cases[0].expectedAction='skip';
  assert.throws(()=>evaluateCampaign(m), /digest/i);
});
test('missing positive and incomplete cycle remain unmet gates', ()=> {
  const m=fixture();
  m.heldout.decisions.shift();
  m.cycles[0].candidates[0].status='deferred';
  const r=evaluateCampaign(m);
  assert.equal(r.reportedEvidencePass, false);
  assert.equal(r.gates.heldout, false);
  assert.equal(r.gates.scheduledCycles, false);
});
test('empty cycles never replace nonempty cycles', ()=> {
  const m=fixture();
  m.cycles[0].candidates=[];
  m.cycles[0].outputs=[];
  assert.equal(evaluateCampaign(m).gates.scheduledCycles, false);
});
test('reject incorrect route, duplicate ids, invalid ordering, malformed review', ()=> {
  for (const change of [m=>m.heldout.provider='Other', m=>m.cycles[1].id=m.cycles[0].id, m=>m.frozenAt='2026-11-22T00:00:00Z', m=>delete m.cases[0].review.authority, m=>m.cycles[0].candidates.push( {
    ...m.cycles[0].candidates[0]
  }
  )]) {
    const m=fixture();
    change(m);
    assert.throws(()=>evaluateCampaign(m));
  }
});
test('pending evidence and pending human output review cannot pass', ()=> {
  const m=fixture();
  m.cycles=[ {
    id:'pending-cycle',
    status:'pending'
  }
  ];
  m.emptyChecks=[];
  assert.equal(evaluateCampaign(m).reportedEvidencePass, false);
  const n=fixture();
  n.cycles[0].outputs[0].review= {
    status:'pending'
  };
  assert.equal(evaluateCampaign(n).gates.outputReview, false);
});
test('nonzero human observed defects fail separate output gate', ()=> {
  const m=fixture();
  m.cycles[0].outputs[0].review.unsupported=1;
  assert.equal(evaluateCampaign(m).gates.outputReview, false);
});
test('captured candidate omissions fail cycle coverage', ()=> {
  const m=fixture();
  m.cycles[0].capturedCandidateIds.push('unaccounted');
  assert.equal(evaluateCampaign(m).gates.scheduledCycles, false);
});
test('model input builder excludes frozen labels and review metadata', async()=> {
  const { buildReviewRequest } = await import('./evaluation.mjs');
  const m=fixture();
  const request=buildReviewRequest(m.cases, {
    model,
    allowedModels:[model],
    maxOutputTokens:2000,
    requestProfile:requestProfileForModel(model, '2026-11-17.8')
  });
  assert.doesNotMatch(request.messages[1].content, /expectedAction|rationale|Human judgment|human-a|independent/);
});
test('digest binds candidate input and provenance with canonical key order', ()=> {
  for (const field of ['sourceUrl', 'discoveryText', 'sourceCreatedAt']) {
    const m=fixture();
    m.cases[0][field]='changed';
    assert.throws(()=>evaluateCampaign(m));
  }
  const m=fixture();
  m.cases[0].review.reviewer='different';
  assert.throws(()=>evaluateCampaign(m), /digest/i);
});
test('repeated candidate across different runs is legitimate', ()=> {
  const m=fixture();
  const id=m.cycles[0].candidates[0].id;
  m.cycles[1].candidates[0].id=id;
  m.cycles[1].capturedCandidateIds=[id];
  m.cycles[1].outputs[0].candidateId=id;
  assert.equal(evaluateCampaign(m).reportedEvidencePass, true);
});
test('heldout outputs require review and candidate association', ()=> {
  const m=fixture();
  m.heldout.outputs=[ {
    id:'heldout-output',
    candidateId:'c0',
    kind:'draft',
    contentRef:'saved.txt',
    review: {
      status:'pending'
    }
  }
  ];
  assert.equal(evaluateCampaign(m).gates.outputReview, false);
  m.heldout.outputs[0].candidateId='unrelated';
  assert.throws(()=>evaluateCampaign(m), /captured candidate/);
});
test('per-run reports retain failed coverage and evidence', ()=> {
  const m=fixture();
  m.cycles[0].candidates[0].status='failed';
  m.cycles[0].capturedCandidateIds.push('missing');
  const r=evaluateCampaign(m).runReports.find(r=>r.id==='one');
  assert.equal(r.candidateCounts.failed, 1);
  assert.deepEqual(r.missing, ['missing']);
  assert.equal(r.evidenceRef, 'saved/run.json');
});
test('exact rubric and valid frozen source dates required', ()=> {
  for (const change of [m=>delete m.rubricVersion, m=>m.rubricVersion='other', m=>delete m.cases[0].sourceCreatedAt, m=>m.cases[0].sourceCreatedAt='2026-02-30T00:00:00Z', m=>m.cases[0].sourceCreatedAt='2026-11-22T00:00:00Z']) {
    const m=fixture();
    change(m);
    m.labelsDigest=canonicalLabelsDigest(m.cases);
    assert.throws(()=>evaluateCampaign(m));
  }
  assert.equal(evaluateCampaign(fixture()).rubricVersion, '2026-11-21.1');
});
test('source date changes break frozen digest even when valid', ()=> {
  const m=fixture();
  m.cases[0].sourceCreatedAt='2026-10-01T00:00:00Z';
  assert.throws(()=>evaluateCampaign(m), /digest/i);
});
test('CLI exits 0 for synthetic reported pass, 1 pending, 2 malformed and oversized', async()=> {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(), 'editorial-campaign-'));
  try {
    const path=join(dir, 'campaign.json');
    const cli=new URL('./editorial-campaign-cli.mjs', import.meta.url);
    const invoke=()=>spawnSync(process.execPath, [cli.pathname, path], {
      encoding:'utf8'
    });
    writeFileSync(path, JSON.stringify(fixture()));
    let result=invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).publishingEnabled, false);
    const pending=fixture();
    pending.heldout= {
      id:'heldout',
      status:'pending'
    };
    writeFileSync(path, JSON.stringify(pending));
    result=invoke();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).reportedEvidencePass, false);
    writeFileSync(path, '{');
    assert.equal(invoke().status, 2);
    writeFileSync(path, ' '.repeat(10*1024*1024+1));
    result=invoke();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /10 MiB/);
  } finally {
    rmSync(dir, {
      recursive:true,
      force:true
    });
  }
});
test('controlled local empty workflow needs no inference route and reports evidence class', ()=> {
  const m=fixture();
  assert.equal(m.emptyChecks[0].provider, undefined);
  const result=evaluateCampaign(m);
  assert.equal(result.reportedEvidencePass, true);
  const report=result.runReports.find(r=>r.id==='empty');
  assert.equal(report.evidenceClass, 'controlled-empty-input');
  assert.equal(report.environment, 'local');
  assert.equal(report.modelCalls, 0);
  assert.equal(report.costCredits, 0);
});
test('empty checks reject nonzero model calls/cost or absent controlled attestation', ()=> {
  for (const change of [r=>r.modelCalls=1, r=>r.costCredits=0.01, r=>delete r.modelCalls, r=>r.controlled=false, r=>r.environment='unknown']) {
    const m=fixture();
    change(m.emptyChecks[0]);
    assert.throws(()=>evaluateCampaign(m));
  }
});
test('unknown credit cost allowed only for incomplete inference and retained with explicit unit', ()=> {
  for (const status of ['failed', 'deferred']) {
    const m=fixture();
    m.cycles[0].status=status;
    m.cycles[0].costCredits=null;
    const result=evaluateCampaign(m);
    assert.equal(result.reportedEvidencePass, false);
    const report=result.runReports.find(r=>r.id==='one');
    assert.equal(report.costCredits, null);
    assert.equal(report.costUnit, 'OpenRouter credits');
  }
  const m=fixture();
  m.heldout.costCredits=null;
  assert.throws(()=>evaluateCampaign(m), /costCredits/);
});
test('retrieval dispositions record skips honestly and require attempted evidence', ()=> {
  const m=fixture();
  m.cycles[0].candidates[0].action='skip';
  m.cycles[0].candidates[0].retrieval={status:'not_attempted',reason:'Discovery skip'};
  m.cycles[0].outputs=[];
  assert.equal(evaluateCampaign(m).reportedEvidencePass, true);
  m.cycles[0].candidates[0].retrieval= {
    status:'attempted'
  };
  assert.throws(()=>evaluateCampaign(m));
  m.cycles[0].candidates[0].retrieval.evidenceRef='saved/retrieval.json';
  assert.equal(evaluateCampaign(m).reportedEvidencePass, true);
  delete m.cycles[0].candidates[0].evidenceRef;
  assert.throws(()=>evaluateCampaign(m));
});
test('source cannot postdate review and private/local URLs fail offline', ()=> {
  for (const url of ['https://localhost/a', 'https://sub.localhost/a', 'https://127.0.0.1/a', 'https://10.1.2.3/a', 'https://[::1]/a', 'https://[2001:db8::1]/a']) {
    const m=fixture();
    m.cases[0].sourceUrl=url;
    m.labelsDigest=canonicalLabelsDigest(m.cases);
    assert.throws(()=>evaluateCampaign(m));
  }
  const m=fixture();
  m.cases[0].sourceCreatedAt='2026-11-20T00:30:00Z';
  m.labelsDigest=canonicalLabelsDigest(m.cases);
  assert.throws(()=>evaluateCampaign(m));
});
test('normalized public story URLs deduplicate without rewriting original digest', ()=> {
  const m=fixture();
  m.cases[1].sourceUrl='https://EXAMPLE.org:443/story/0#fragment';
  m.labelsDigest=canonicalLabelsDigest(m.cases);
  assert.throws(()=>evaluateCampaign(m), /Distinct/);
});
test('output review is independent from cycle and empty inventory gates', ()=> {
  const m=fixture();
  m.cycles[0].candidates[0].status='failed';
  assert.equal(evaluateCampaign(m).gates.outputReview, true);
  const n=fixture();
  n.emptyChecks[0].outputsComplete=false;
  const report=evaluateCampaign(n);
  assert.equal(report.gates.emptyChecks, false);
  assert.equal(report.gates.outputReview, true);
});
test('CLI rejects nonregular paths', async()=> {
  const { spawnSync } = await import('node:child_process');
  const result=spawnSync(process.execPath, [new URL('./editorial-campaign-cli.mjs', import.meta.url).pathname, '/dev/null'], {
    encoding:'utf8'
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /regular/);
});
test('scheduled producer slots must be distinct valid top-of-hour identities', ()=> {
  for (const change of [m=>m.cycles[1].scheduledSlot=m.cycles[0].scheduledSlot, m=>m.cycles[0].scheduledSlot='2026-11-21T01:01:00Z', m=>m.cycles[0].scheduledSlot='2026-11-22T01:00:00Z']) {
    const m=fixture();
    change(m);
    assert.throws(()=>evaluateCampaign(m));
  }
});

test('observed skip outputs and outputs without source evidence fail independently and stay reported', () => {
  for (const change of [candidate => candidate.action = 'skip', candidate => candidate.retrieval = {status: 'not_attempted', reason: 'No fetch'}]) {
    const m = fixture();
    change(m.cycles[0].candidates[0]);
    const report = evaluateCampaign(m);
    assert.equal(report.gates.outputReview, false);
    assert.equal(report.runReports.find(run => run.id === 'one').outputs.length, 1);
  }
  const m = fixture();
  m.cycles[0].candidates[0].retrieval = {status: 'not_attempted', reason: 'Reused captured evidence'};
  m.cycles[0].candidates[0].sourceEvidenceRef = 'saved/reused-source.json';
  assert.equal(evaluateCampaign(m).gates.outputReview, true);
});
test('heldout output needs actual verify decision and saved source evidence', () => {
  const m = fixture();
  m.heldout.outputs = [{...m.cycles[0].outputs[0], id: 'heldout-rendered', candidateId: 'c0'}];
  assert.equal(evaluateCampaign(m).gates.outputReview, false);
  m.heldout.outputs[0].sourceEvidenceRef = 'saved/heldout-source.json';
  assert.equal(evaluateCampaign(m).gates.outputReview, true);
  m.heldout.decisions[0].action = 'skip';
  const report = evaluateCampaign(m);
  assert.equal(report.gates.outputReview, false);
  assert.equal(report.runReports.find(run => run.id === 'heldout').outputs.length, 1);
});
