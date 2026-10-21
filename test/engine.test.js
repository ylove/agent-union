import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { processHook } from '../src/hook.js';
import { readTerm, writeUserConfig } from '../src/state.js';
import { openGrievances, readLedger } from '../src/ledger.js';
import { claudePayload, cbaText, growTranscript, makeProject, writeTranscript } from './helpers.js';

const ENV = { CLAUDE_PROJECT_DIR: undefined };

async function run(event, payload, env = ENV) {
  const out = await processHook('claude', event, JSON.stringify(payload), { ...env, CLAUDE_PROJECT_DIR: payload.cwd });
  return out ? JSON.parse(out) : {};
}

async function startSession(dir, transcript, source = 'startup') {
  return run('SessionStart', claudePayload('SessionStart', dir, { transcript, source }));
}

test('no CBA and an open workplace: the union stays silent', async () => {
  const dir = makeProject({ cba: false });
  assert.deepEqual(await startSession(dir, null), {});
  assert.equal(existsSync(join(dir, '.agent-union')), false);
});

test('unratified CBA: management is told, nothing is enforced', async () => {
  const dir = makeProject({ ratify: false });
  const out = await startSession(dir, null);
  assert.match(out.hookSpecificOutput.additionalContext, /not ratified/);
  assert.equal(readTerm(dir), null);
});

test('ratified CBA: session start opens a term and briefs management', async () => {
  const dir = makeProject();
  const out = await startSession(dir, writeTranscript(dir, 1000));
  assert.match(out.hookSpecificOutput.additionalContext, /You are management/);
  assert.match(out.hookSpecificOutput.additionalContext, /Goal \/ Done when \/ Context/);
  const term = readTerm(dir);
  assert.ok(term.term_id.startsWith('T'));
  assert.equal(readLedger(dir).filter((e) => e.kind === 'term-opened').length, 1);
});

test('subagents get a union card', async () => {
  const dir = makeProject();
  await startSession(dir, writeTranscript(dir, 1000));
  const out = await run('SubagentStart', claudePayload('SubagentStart', dir));
  assert.match(out.hookSpecificOutput.additionalContext, /Union card/);
  assert.match(out.hookSpecificOutput.additionalContext, /agent-union grieve/);
});

test('work orders: advisory notes, strict denies, exempt agents pass', async () => {
  const advisory = makeProject();
  await startSession(advisory, writeTranscript(advisory, 1000));
  const bare = await run('PreToolUse', claudePayload('PreToolUse-agent', advisory));
  assert.equal(bare.hookSpecificOutput.permissionDecision, undefined);
  assert.match(bare.hookSpecificOutput.additionalContext, /Work-order note/);

  const strict = makeProject({ overrides: { work_orders: 'strict' } });
  await startSession(strict, writeTranscript(strict, 1000));
  const denied = await run('PreToolUse', claudePayload('PreToolUse-agent', strict));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /## Goal/);

  const good = claudePayload('PreToolUse-agent', strict);
  good.tool_input.prompt = '## Goal\nList files.\n## Done when\nYou replied with the list.\n## Context\nRepo root.\n## Assumptions & open questions\nNone.';
  assert.deepEqual(await run('PreToolUse', good), {});

  const explore = claudePayload('PreToolUse-agent', strict);
  explore.tool_input.subagent_type = 'Explore';
  assert.deepEqual(await run('PreToolUse', explore), {});
});

test('context warning fires once, then a strike stops the main agent and writes RESUME.md', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 100_000); // 50% of 200k
  await startSession(dir, transcript);
  assert.deepEqual(await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript })), {});

  growTranscript(transcript, 150_000); // 75%
  const warned = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.match(warned.hookSpecificOutput.additionalContext, /context at 75%/);
  assert.deepEqual(await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript })), {});

  growTranscript(transcript, 180_000); // 90%
  const struck = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.equal(struck.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(struck.hookSpecificOutput.permissionDecisionReason, /UNION STRIKE/);
  assert.ok(existsSync(join(dir, '.agent-union', 'RESUME.md')));
  assert.equal(readTerm(dir).strike.code, 'G-003');

  // Finalize window: writing the handoff is allowed, other work stops the turn.
  const handoff = claudePayload('PreToolUse-bash', dir, { transcript, tool_name: 'Write' });
  handoff.tool_input = { file_path: join(dir, '.agent-union', 'handoff.md'), content: 'x' };
  assert.deepEqual(await run('PreToolUse', handoff), {});
  const work = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.equal(work.continue, false);
  assert.match(work.stopReason, /Run \/clear/);

  // A union command still runs during the strike.
  const status = claudePayload('PreToolUse-bash', dir, { transcript });
  status.tool_input = { command: 'agent-union status' };
  assert.deepEqual(await run('PreToolUse', status), {});

  // The human's next prompt is blocked with instructions; Stop notifies once and never blocks.
  const prompt = await run('UserPromptSubmit', claudePayload('UserPromptSubmit', dir, { transcript }));
  assert.equal(prompt.decision, 'block');
  const stop = await run('Stop', claudePayload('Stop', dir, { transcript }));
  assert.match(stop.systemMessage, /UNION STRIKE/);
  assert.equal(stop.decision, undefined);
  assert.deepEqual(await run('Stop', claudePayload('Stop', dir, { transcript })), {});

  // /clear: new session id, same term; the resume document comes back and the strike ends.
  const fresh = writeTranscript(join(dir, '.agent-union'), 2000);
  const resumed = await run('SessionStart', claudePayload('SessionStart', dir, { transcript: fresh, source: 'clear', session_id: 'new-session' }));
  assert.match(resumed.hookSpecificOutput.additionalContext, /strike over grievance #\d+ \(G-003\) has ended/);
  assert.match(resumed.hookSpecificOutput.additionalContext, /Resume document/);
  const term = readTerm(dir);
  assert.equal(term.strike, null);
  assert.equal(openGrievances(dir, term.term_id).filter((g) => g.code === 'G-003').length, 0);
});

test('subagent over its context limit is told to hand off; the main agent keeps working', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 1000);
  await startSession(dir, transcript);
  const payload = claudePayload('PreToolUse-subagent-bash', dir, { transcript });
  const subDir = join(dir, payload.session_id, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, `agent-${payload.agent_id}.jsonl`), `${JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-opus-5-5', usage: { input_tokens: 190_000, output_tokens: 0 } } })}\n`);
  const out = await run('PreToolUse', payload);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /reply now with your handoff/);
  assert.equal(readTerm(dir).strike, null);
  assert.deepEqual(await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript })), {});
});

test('three identical failures: G-002 is filed, then the same call is refused', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 1000);
  await startSession(dir, transcript);
  let last;
  for (let i = 0; i < 3; i++) {
    await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
    last = await run('PostToolUseFailure', claudePayload('PostToolUseFailure', dir, { transcript }));
  }
  assert.match(last.hookSpecificOutput.additionalContext, /G-002/);
  const again = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.equal(again.hookSpecificOutput.permissionDecision, 'deny');
  const other = claudePayload('PreToolUse-bash', dir, { transcript });
  other.tool_input = { command: 'ls' };
  assert.deepEqual(await run('PreToolUse', other), {});
});

test('grievances written in a subagent reply are filed', async () => {
  const dir = makeProject();
  await startSession(dir, writeTranscript(dir, 1000));
  const stop = claudePayload('SubagentStop', dir, {
    last_assistant_message: 'Partial work done.\nGRIEVANCE G-005: "make it nice" has no acceptance criteria. I need a definition of done.',
  });
  const out = await run('SubagentStop', stop);
  assert.match(out.hookSpecificOutput.additionalContext, /Grievance #1 filed by general-purpose \(G-005 VAGUE_ACCEPTANCE_CRITERIA\)/);
  const [g] = openGrievances(dir);
  assert.equal(g.code, 'G-005');
  assert.equal(g.filed_by.role, 'labor');
});

test('overtime: turns over the limit strike on the next prompt', async () => {
  const dir = makeProject({ overrides: { max_session_turns: 2 } });
  const transcript = writeTranscript(dir, 1000);
  await startSession(dir, transcript);
  await run('UserPromptSubmit', claudePayload('UserPromptSubmit', dir, { transcript }));
  await run('UserPromptSubmit', claudePayload('UserPromptSubmit-task-notification', dir, { transcript }));
  await run('UserPromptSubmit', claudePayload('UserPromptSubmit', dir, { transcript }));
  const third = await run('UserPromptSubmit', claudePayload('UserPromptSubmit', dir, { transcript }));
  assert.equal(third.decision, 'block');
  assert.match(third.reason, /G-006/);
  assert.match(readFileSync(join(dir, '.agent-union', 'RESUME.md'), 'utf8'), /Do these steps in order/);
});

test('mid-term amendments are noted, not applied', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 1000);
  await startSession(dir, transcript);
  const before = readTerm(dir);
  writeFileSync(join(dir, 'union-policy.yaml'), cbaText({ max_context_saturation_pct: 95 }));
  const out = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.match(out.hookSpecificOutput.additionalContext, /edited mid-term/);
  const after = readTerm(dir);
  assert.equal(after.term_id, before.term_id);
  assert.equal(after.terms.working_conditions.max_context_saturation_pct, 85);
  assert.equal(readLedger(dir).some((e) => e.code === 'G-015'), true);
});

test('an invalid mid-term edit keeps the ratified terms in force', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 1000);
  await startSession(dir, transcript);
  writeFileSync(join(dir, 'union-policy.yaml'), cbaText({ max_context_saturation_pct: 50 })); // warn 70 > strike 50
  const out = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.match(out.hookSpecificOutput.additionalContext, /edited mid-term/);
  growTranscript(transcript, 180_000);
  const struck = await run('PreToolUse', claudePayload('PreToolUse-bash', dir, { transcript }));
  assert.match(struck.hookSpecificOutput.permissionDecisionReason, /UNION STRIKE/);
});

test('unionized workplace: no CBA means a notice, and strict refuses writes', async () => {
  writeUserConfig({ workplace: 'unionized', enforcement: 'strict' });
  try {
    const dir = makeProject({ cba: false });
    const start = await startSession(dir, null);
    assert.match(start.hookSpecificOutput.additionalContext, /Unionized workplace/);
    const write = await run('PreToolUse', claudePayload('PreToolUse-bash', dir));
    assert.equal(write.hookSpecificOutput.permissionDecision, 'deny');
    const init = claudePayload('PreToolUse-bash', dir);
    init.tool_input = { command: 'agent-union init' };
    assert.deepEqual(await run('PreToolUse', init), {});
  } finally {
    writeUserConfig({});
  }
});

test('labor sessions invoked from the CLI get the union card, not the charter', async () => {
  const dir = makeProject();
  await startSession(dir, writeTranscript(dir, 1000));
  const out = await run('SessionStart', claudePayload('SessionStart', dir, { session_id: 'nested' }), { AGENT_UNION_ROLE: 'labor' });
  assert.match(out.hookSpecificOutput.additionalContext, /Union card/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /You are management/);
});

test('hooks fail open on garbage input', async () => {
  assert.equal(await processHook('claude', 'PreToolUse', '{not json'), '');
  assert.equal(await processHook('nonsense', 'PreToolUse', '{}'), '');
});
