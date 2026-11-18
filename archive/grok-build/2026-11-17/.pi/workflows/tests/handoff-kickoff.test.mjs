import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_WORKFLOWS_ROOT;
if (!root) throw new Error('PI_WORKFLOWS_ROOT required');
const { loadWorkflowFile } = await import(pathToFileURL(path.join(root, 'src/workflows/loader.ts')));
const { validateWorkflowDefinition } = await import(pathToFileURL(path.join(root, 'src/workflows/graph.ts')));
const { compileWorkflowDefinition } = await import(pathToFileURL(path.join(root, 'src/workflows/composition.ts')));
const here = new URL('../', import.meta.url);
const w = await loadWorkflowFile(new URL('handoff-kickoff.workflow.ts', here).pathname);
const { digest, parseDispositions, acceptedBlockers, approveOutput, decisionPresentation, verifyReviewer } = await import(new URL('handoff-kickoff.workflow.ts', here));

test('installed loader/graph: kickoff and legacy lane; four protected choices, no timeout approval or execution tools', async () => {
  for (const f of ['handoff-kickoff', 'step']) {
    const x = await loadWorkflowFile(new URL(`${f}.workflow.ts`, here).pathname);
    validateWorkflowDefinition(x); assert.ok(Object.keys(compileWorkflowDefinition(x).nodes).length);
  }
  assert.deepEqual(Object.keys(w.nodes.decide.humanDecision.choices).sort(), ['approve','followthrough','revise','stop']);
  assert.equal(w.nodes.decide.humanDecision.onTimeout, undefined);
  for (const n of ['assess','draft','disposition']) {
    assert.deepEqual(w.nodes[n].allowedTools, ['read','grep','find','ls']);
    assert.equal(w.nodes[n].timeoutMs, null);
  }
  assert.equal(w.nodes.save.nodeType, 'action');
  assert.deepEqual(Object.keys(w.exits).sort(), ['approved','followthrough','stopped']);
});
test('finding disposition, not count or severity, determines blockers', () => {
  const findings = [{ id:'f1' }];
  for (const decision of ['reject','defer']) {
    const x = parseDispositions({summary:'not blocking',dispositions:[{id:'f1',decision,material:false,reason:'no impact on core use'}]}, findings);
    assert.equal(acceptedBlockers(x.dispositions).length, 0);
  }
  const x = parseDispositions({summary:'broken core',dispositions:[{id:'f1',decision:'accept',material:true,reason:'core action loses data'}]}, findings);
  assert.equal(acceptedBlockers(x.dispositions).length,1);
  assert.throws(()=>parseDispositions({summary:'missing',dispositions:[]},findings));
});
test('approval binds exact artifacts; done/followthrough and unavailable review cannot masquerade as ready', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'kickoff-check-'));
  try {
    const proposal=path.join(dir,'proposal.md'),workflow=path.join(dir,'execution.workflow.ts');
    writeFileSync(proposal,'proposal');writeFileSync(workflow,'source');
    const o={ draft:{originalDone:true,doneEvidence:['commit evidence']}, save:{proposal,workflow,proposalDigest:digest('proposal'),sourceDigest:digest('source')}, review:{status:'reviewed'}, disposition:{dispositions:[]}, decide:{choice:'followthrough'} };
    assert.equal(approveOutput(o,true).status,'followthrough');
    assert.equal(approveOutput(o,false).executionStarted,false);
    assert.throws(()=>approveOutput({...o,draft:{originalDone:false,doneEvidence:[]}},true));
    assert.throws(()=>approveOutput({...o,review:{status:'blocked'}},false));
    assert.throws(()=>approveOutput({...o,disposition:{dispositions:[{decision:'accept',material:true}]}},false));
    writeFileSync(workflow,'changed');assert.throws(()=>approveOutput(o,false),/changed/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('legacy lane explicitly injects policy and dispositions before review-driven repair', async () => {
  const s=readFileSync(new URL('step.workflow.ts',here),'utf8');
  assert.ok(s.includes('delivery-policy.md'));assert.ok(s.includes('fork:false'));
  assert.ok(s.includes('to: "brief_disposition"'));assert.ok(s.includes('to: "build_disposition"'));
  assert.ok(!s.includes('poll its status'));assert.ok(s.includes('judgment.blockers.length === 0'));
  const lane=await loadWorkflowFile(new URL('step.workflow.ts',here).pathname);
  const ctx={outputs:{prepare:{runId:'fixture',step:'step.md',brief:'brief.md',diffPatch:'diff.patch',gate:'gate.json',review:'/nonexistent-review-fixture'},gate:{ok:true},diff:{chars:10},build_review:{ok:true},build_disposition:{available:true,blockers:[]}}};
  assert.equal(lane.nodes.complete.run(ctx).route,'commit');
  ctx.outputs.build_disposition.blockers.push({condition:'broken core'});
  assert.equal(lane.nodes.complete.run(ctx).route,'fix');
  ctx.outputs.fix={ok:true};assert.equal(lane.nodes.complete.run(ctx).route,'stop');
  const prompt=lane.nodes.build_review_dispatch.prompt(ctx);
  assert.ok(prompt.includes('Supply evidence, not a veto'));assert.ok(prompt.includes('fork:false'));
  assert.ok(prompt.includes('IMMEDIATELY submit'));
  assert.equal(lane.nodes.build_review_wait.nodeType,'checkpoint');
  assert.equal(lane.nodes.build_review_collect.allowedTools.includes('subagent'),false);
});
test('actual channel normalizer accepts ordinary large source and explicit artifact-reference fallback', async () => {
  const {normalizeDecisionPresentation}=await import(pathToFileURL(path.join(root,'src/workflows/decision-presentation.ts')));
  const dir=mkdtempSync(path.join(tmpdir(),'kickoff-presentation-'));
  try {
    const proposal=path.join(dir,'proposal.md');writeFileSync(proposal,'Scope and authority');
    for (const size of [18000,90000]) {
      const o={save:{proposal,workflow:'draft.ts',sourceDigest:'abc',proposalDigest:'def'},draft:{summary:'Draft',source:'x'.repeat(size)},review:{status:'reviewed'},disposition:{dispositions:[]}};
      const p=normalizeDecisionPresentation(decisionPresentation({task:'task',authority:'draft only',handoff:'evidence'},o));
      assert.ok(p.blocks.every(b=>b.text.length<16000));
      if(size>48000) assert.ok(p.blocks.some(b=>b.text.includes('EXCERPT')));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('actual engine parks after accepted dispatch and resumes ordinary checkpoint without another model turn', async () => {
  const {WorkflowEngine}=await import(pathToFileURL(path.join(root,'src/workflows/engine.ts')));
  const {WorkflowRunStore}=await import(pathToFileURL(path.join(root,'src/workflows/store.ts')));
  const {recordWorkflowSubmission,requestForAttempt}=await import(pathToFileURL(path.join(root,'src/workflows/requests.ts')));
  const {defineWorkflow,compute}=await import(pathToFileURL(path.join(root,'src/workflows/index.ts')));
  const dir=mkdtempSync(path.join(tmpdir(),'kickoff-wait-'));
  const store=new WorkflowRunStore(path.join(dir,'state.sqlite'));
  let modelCalls=0;
  const receipt={id:'12345678-1234-1234-1234-123456789abc',artifacts:dir,blocked:''};
  const fixture=defineWorkflow({name:'kickoff-handoff-fixture',startAt:'dispatch',nodes:{dispatch:{...w.nodes.dispatch,prompt:()=> 'Dispatch fixture; no real child'},await_review:w.nodes.await_review,done:compute({run:({outputs})=>outputs.await_review})},edges:[{from:'dispatch',to:'await_review'},{from:'await_review',to:'done'}]});
  try {
    const engine=new WorkflowEngine({store,executor:{enforcesToolAllowlist:true,async runAgentStep(r){modelCalls++;const a=await r.accept(receipt);assert.equal(a.ok,true,a.error);return {output:a.value};}}});
    const waiting=await engine.run(fixture,{});
    assert.equal(waiting.state.status,'waiting');assert.equal(modelCalls,1);
    const req=requestForAttempt(store.state,waiting.runId,waiting.state.currentAttemptId);
    assert.equal(req.kind,'checkpoint');
    recordWorkflowSubmission(store.state,{requestId:req.requestId,submissionId:'fixture-completion',idempotencyKey:'fixture-completion',expectedRevision:req.revision,payload:{id:receipt.id},outcome:'accepted',settle:true});
    const done=await engine.resumeRun(fixture,waiting.runId);
    assert.equal(done.state.status,'completed');assert.equal(modelCalls,1);
    assert.equal(done.state.finalOutput.id,receipt.id);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
test('dispatch completes before external wait; recorded wrong thinking cannot pass review', () => {
  assert.ok(w.nodes.dispatch.prompt({input:{reviewer:'deepseek/deepseek-flash:high'},outputs:{save:{}}}).includes('IMMEDIATELY submit'));
  assert.equal(w.nodes.await_review.nodeType,'checkpoint');
  assert.equal(w.nodes.review.allowedTools.includes('subagent'),false);
  const dir=mkdtempSync(path.join(tmpdir(),'kickoff-model-'));
  try {
    writeFileSync(path.join(dir,'run.json'),JSON.stringify({id:'fixture'}));
    writeFileSync(path.join(dir,'result.json'),JSON.stringify({status:'completed',text:'actual report'}));
    const events=[{type:'model_change',provider:'deepseek',modelId:'deepseek-flash'},{type:'thinking_level_change',thinkingLevel:'low'}];
    writeFileSync(path.join(dir,'session.jsonl'),events.map(JSON.stringify).join('\n'));
    assert.throws(()=>verifyReviewer(dir,'deepseek/deepseek-flash:high'),/mismatch/);
    events[1].thinkingLevel='high';writeFileSync(path.join(dir,'session.jsonl'),events.map(JSON.stringify).join('\n'));
    assert.equal(verifyReviewer(dir,'deepseek/deepseek-flash:high').report,'actual report');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
