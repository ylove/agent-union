import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { processHook } from '../src/hook.js';
import { readTerm, writeTerm } from '../src/state.js';
import { mergeHooks } from '../src/install/codex.js';
import { hookSpec } from '../src/install/antigravity.js';
import { fixture, makeProject } from './helpers.js';

function rollout(dir, inputTokens) {
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: inputTokens, output_tokens: 0 }, model_context_window: 475_000 } } })}\n`);
  return file;
}

async function codex(event, payload) {
  const out = await processHook('codex', event, JSON.stringify(payload));
  return out ? JSON.parse(out) : {};
}

function codexPayload(name, dir, transcript, patch = {}) {
  return { ...fixture('codex', name), cwd: dir, transcript_path: transcript, ...patch };
}

test('Codex: charter on session start, strike from rollout token counts', async () => {
  const dir = makeProject({ overrides: { context_warning_pct: 40, max_context_saturation_pct: 50 } });
  const transcript = rollout(dir, 10_000);
  const start = await codex('SessionStart', codexPayload('SessionStart', dir, transcript));
  assert.match(start.hookSpecificOutput.additionalContext, /You are management/);
  assert.deepEqual(await codex('PreToolUse', codexPayload('PreToolUse', dir, transcript)), {});

  rollout(dir, 300_000); // 63% of 475k
  const struck = await codex('PreToolUse', codexPayload('PreToolUse', dir, transcript));
  assert.equal(struck.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(struck.hookSpecificOutput.permissionDecisionReason, /UNION STRIKE/);
  // Codex has no continue:false for tools, so later work is denied rather than stopped.
  const later = await codex('PreToolUse', codexPayload('PreToolUse', dir, transcript, { tool_input: { command: 'ls' } }));
  assert.equal(later.hookSpecificOutput.permissionDecision, 'deny');
  const prompt = await codex('UserPromptSubmit', codexPayload('UserPromptSubmit', dir, transcript));
  assert.equal(prompt.decision, 'block');
});

test('Codex: failures detected from PostToolUse output text', async () => {
  const dir = makeProject();
  const transcript = rollout(dir, 1000);
  await codex('SessionStart', codexPayload('SessionStart', dir, transcript));
  let last;
  for (let i = 0; i < 3; i++) {
    await codex('PreToolUse', codexPayload('PreToolUse', dir, transcript));
    last = await codex('PostToolUse', codexPayload('PostToolUse', dir, transcript));
  }
  assert.match(last.hookSpecificOutput.additionalContext, /G-002/);
});

test('Codex installer merges without clobbering other hooks and is idempotent', () => {
  const runtime = { node: '/usr/bin/node', bin: '/home/dev/.agent-union/runtime/0.1.0/bin/agent-union' };
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const once = mergeHooks(existing, runtime);
  const twice = mergeHooks(once, runtime);
  assert.deepEqual(once, twice);
  assert.equal(twice.hooks.Stop.length, 2);
  assert.equal(twice.hooks.Stop[0].hooks[0].command, 'say done');
  assert.match(twice.hooks.PreToolUse[0].hooks[0].command, /agent-union hook codex PreToolUse$/);
});

// Antigravity payloads follow the bundled docs (camelCase); no live runtime was available.
function agy(dir, extra = {}) {
  return { conversationId: 'conv-1', workspacePaths: [dir], transcriptPath: join(dir, 'agy', 'transcript.jsonl'), modelName: 'gemini-3-pro', ...extra };
}

async function antigravity(event, payload) {
  const out = await processHook('antigravity', event, JSON.stringify(payload));
  return out ? JSON.parse(out) : {};
}

test('Antigravity: first invocation briefs management; dispatches carry the union card', async () => {
  const dir = makeProject();
  mkdirSync(join(dir, 'agy'), { recursive: true });
  writeFileSync(join(dir, 'agy', 'transcript.jsonl'), 'x'.repeat(4000));
  const first = await antigravity('PreInvocation', agy(dir, { invocationNum: 1 }));
  assert.match(first.injectSteps[0].ephemeralMessage, /You are management/);
  const dispatch = await antigravity('PreToolUse', agy(dir, { toolCall: { name: 'invoke_subagent', args: { Prompt: 'Goal: x\nDone when: y' } } }));
  assert.match(dispatch.overwrite.Prompt, /^Goal: x\nDone when: y\n\n⚒ Union card/);
  assert.equal(dispatch.decision, undefined, 'never auto-approve');
  // A second "first invocation" in the same conversation is a new turn, not a new term.
  const termId = readTerm(dir).term_id;
  await antigravity('PreInvocation', agy(dir, { invocationNum: 1 }));
  assert.equal(readTerm(dir).term_id, termId);
  assert.equal(readTerm(dir).turns, 1);
});

test('Antigravity: estimated context strike terminates the loop', async () => {
  const dir = makeProject({ overrides: { context_warning_pct: 5, max_context_saturation_pct: 10 } });
  mkdirSync(join(dir, 'agy'), { recursive: true });
  const transcript = join(dir, 'agy', 'transcript.jsonl');
  writeFileSync(transcript, 'x'.repeat(4000));
  await antigravity('PreInvocation', agy(dir, { invocationNum: 1 }));
  writeFileSync(transcript, 'x'.repeat(4 * 1_000_000 * 0.2)); // ~200k tokens estimated vs a 1M Gemini window
  const pre = await antigravity('PreInvocation', agy(dir, { invocationNum: 2 }));
  assert.match(pre.injectSteps.at(-1).ephemeralMessage, /UNION STRIKE/);
  const post = await antigravity('PostInvocation', agy(dir, { invocationNum: 2 }));
  assert.equal(post.terminationBehavior, 'terminate');
  const tool = await antigravity('PreToolUse', agy(dir, { toolCall: { name: 'write_to_file', args: { TargetFile: join(dir, 'a.txt') } } }));
  assert.equal(tool.decision, 'deny');
  assert.deepEqual(await antigravity('Stop', agy(dir)), {});
});

test('Antigravity: repeated failing calls are refused', async () => {
  const dir = makeProject();
  await antigravity('PreInvocation', agy(dir, { invocationNum: 1 }));
  const call = agy(dir, { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } });
  for (let i = 0; i < 3; i++) {
    await antigravity('PreToolUse', call);
    await antigravity('PostToolUse', agy(dir, { error: 'exit status 1' }));
  }
  const again = await antigravity('PreToolUse', call);
  assert.equal(again.decision, 'deny');
  assert.match(again.reason, /G-002/);
});

test('Antigravity installer spec uses one named hook', () => {
  const spec = hookSpec({ node: '/usr/bin/node', bin: '/x/bin/agent-union' });
  assert.equal(spec.enabled, true);
  assert.equal(spec.PreToolUse[0].matcher, '*');
  assert.match(spec.PreInvocation[0].command, /hook antigravity PreInvocation$/);
});

test('Antigravity: a strike from another harness is respected (shared project state)', async () => {
  const dir = makeProject();
  await antigravity('PreInvocation', agy(dir, { invocationNum: 1 }));
  const term = readTerm(dir);
  term.strike = { grievance: 9, code: 'G-001', condition: 'arbitration', reason: 'Brief contradicts AGENTS.md.', started_at: Date.now(), finalize_remaining: 0 };
  writeTerm(dir, term);
  const post = await antigravity('PostInvocation', agy(dir, { invocationNum: 2 }));
  assert.equal(post.terminationBehavior, 'terminate');
});
