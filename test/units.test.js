import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeUsage, codexUsage, measureContext } from '../src/telemetry.js';
import { detectGrievances, normalizeCode } from '../src/grievances.js';
import { checkWorkOrder, isExempt } from '../src/workorder.js';
import { fileGrievance, grievanceIndex, readLedger } from '../src/ledger.js';
import { isFinalizeAction } from '../src/strike.js';
import { looksLikeFailure } from '../src/engine.js';
import { normalizeCba } from '../src/cba.js';
import { ROOT, assistantLine, claudePayload, makeProject, writeTranscript } from './helpers.js';

test('Claude usage: last main-chain assistant entry plus pending tool output', () => {
  const lines = [
    assistantLine(50_000),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999_999 } } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(4000) }] } }),
  ].join('\n');
  const r = claudeUsage(lines);
  assert.equal(r.tokens, 51_000);
  assert.equal(r.estimated, true);
  assert.equal(r.model, 'claude-opus-5-5');
});

test('Codex usage: last token_count event with its context window', () => {
  const ev = (input) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: 10 }, model_context_window: 475_000 } } });
  const r = codexUsage([ev(1000), ev(237_490), JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })].join('\n'));
  assert.deepEqual(r, { tokens: 237_500, window: 475_000, estimated: false });
});

test('measureContext: window override and model map', () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 100_000);
  assert.equal(measureContext({ harness: 'claude', projectDir: dir, transcriptPath: transcript, sessionId: 's' }).pct, 50);
  assert.equal(measureContext({ harness: 'claude', projectDir: dir, transcriptPath: transcript, sessionId: 's', windowOverride: 1_000_000 }).pct, 10);
  const big = writeTranscript(dir, 100_000, { model: 'claude-opus-5-5[1m]' });
  assert.equal(measureContext({ harness: 'claude', projectDir: dir, transcriptPath: big, sessionId: 's' }).pct, 10);
});

test('measureContext prefers a fresh statusline snapshot for the same session', () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 100_000);
  writeFileSync(join(dir, '.agent-union', 'statusline.json'), JSON.stringify({ session_id: 's', used_percentage: 73, context_window_size: 200_000, at: Date.now() }));
  const r = measureContext({ harness: 'claude', projectDir: dir, transcriptPath: transcript, sessionId: 's' });
  assert.equal(r.pct, 73);
  assert.equal(r.source, 'statusline');
  assert.equal(measureContext({ harness: 'claude', projectDir: dir, transcriptPath: transcript, sessionId: 'other' }).pct, 50);
});

test('grievance text detection: the spec syntax and the GRIEVANCE line', () => {
  const spec = detectGrievances('Instruction says X but guideline says Z. I can\'t work like this. @union-agent This is unacceptable. Grievance #123 filed.');
  assert.equal(spec.length, 1);
  assert.equal(spec[0].code, null);
  const lines = detectGrievances('Done.\nGRIEVANCE G-1: brief says concise, CLAUDE.md says verbose\ngrievance vague_acceptance_criteria — "make it nice"');
  assert.deepEqual(lines.map((l) => l.code), ['G-001', 'G-005']);
  assert.deepEqual(detectGrievances('We discussed the union-agent idea.'), []);
  assert.equal(normalizeCode('g-16'), 'G-016');
  assert.equal(normalizeCode('G-099'), null);
});

test('work-order checker', () => {
  assert.equal(checkWorkOrder('Run ls and reply DONE.').ok, false);
  const full = checkWorkOrder('**Goal:** ship it\n**Done when:** tests pass\nContext: see README\n- Assumptions: none');
  assert.equal(full.complete, true);
  assert.equal(checkWorkOrder('Task: fix bug\nAcceptance criteria: test passes').ok, true);
  const terms = normalizeCba({ collective_bargaining_agreement: {} });
  assert.equal(isExempt('Explore', terms), true);
  assert.equal(isExempt('some-plugin:Plan', terms), true);
  assert.equal(isExempt('general-purpose', terms), false);
});

test('finalize actions are limited to the union directory and union commands', () => {
  const dir = makeProject();
  assert.equal(isFinalizeAction('Write', { file_path: join(dir, '.agent-union', 'handoff.md') }, dir), true);
  assert.equal(isFinalizeAction('Write', { file_path: join(dir, '.agent-union', '..', 'src.js') }, dir), false);
  assert.equal(isFinalizeAction('Edit', { file_path: join(dir, 'README.md') }, dir), false);
  assert.equal(isFinalizeAction('Bash', { command: 'agent-union status' }, dir), true);
  assert.equal(isFinalizeAction('Bash', { command: 'agent-union status; rm -rf x' }, dir), false);
});

test('Codex failure heuristic', () => {
  assert.equal(looksLikeFailure('cat: does-not-exist.txt: No such file or directory\n'), true);
  assert.equal(looksLikeFailure('a.txt\nb.txt\n'), false);
});

test('ledger numbering stays sequential under parallel writers', async () => {
  const dir = makeProject();
  const script = `import { fileGrievance } from ${JSON.stringify(join(ROOT, 'src', 'ledger.js'))}; for (let i = 0; i < 5; i++) fileGrievance(process.argv[1], { code: 'G-005', detail: 'p' + i });`;
  await Promise.all(
    Array.from({ length: 4 }, () => new Promise((res, rej) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, dir]);
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`writer exited ${c}`))));
    })),
  );
  fileGrievance(dir, { code: 'G-001', detail: 'last' });
  const numbers = readLedger(dir).filter((e) => e.kind === 'grievance').map((e) => e.n).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(grievanceIndex(readLedger(dir)).size, 21);
});

test('a hook process stays fast (p95 under 150 ms including node startup)', async () => {
  const dir = makeProject();
  const transcript = writeTranscript(dir, 1000);
  const payload = JSON.stringify(claudePayload('PreToolUse-bash', dir, { transcript }));
  const times = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    await new Promise((res) => {
      const p = spawn(process.execPath, [join(ROOT, 'bin', 'agent-union'), 'hook', 'claude', 'PreToolUse'], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
      p.stdin.end(payload);
      p.on('exit', res);
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  assert.ok(p95 < 150, `p95 was ${Math.round(p95)} ms`);
});
