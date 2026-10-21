import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashTerms, normalizeCba, parseCbaText } from '../src/cba.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = readFileSync(join(ROOT, 'templates', 'union-policy.yaml'), 'utf8');

// Keep the user-level config out of the real home directory.
process.env.AGENT_UNION_HOME = mkdtempSync(join(tmpdir(), 'au-home-'));

export function fixture(harness, name) {
  return JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', harness, `${name}.json`), 'utf8'));
}

// Replaces "key: value" lines in the template, e.g. { max_context_saturation_pct: 50 }.
export function cbaText(overrides = {}) {
  let text = TEMPLATE;
  for (const [key, value] of Object.entries(overrides)) {
    const re = new RegExp(`^(\\s*${key}:)\\s*\\S.*$`, 'm');
    if (!re.test(text)) throw new Error(`template has no field ${key}`);
    text = text.replace(re, `$1 ${value}`);
  }
  return text;
}

export function makeProject({ overrides = {}, ratify = true, cba = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'au-proj-'));
  if (cba) {
    const text = cbaText(overrides);
    writeFileSync(join(dir, 'union-policy.yaml'), text);
    if (ratify) {
      const terms = normalizeCba(parseCbaText(text));
      mkdirSync(join(dir, '.agent-union'), { recursive: true });
      writeFileSync(
        join(dir, '.agent-union', 'ratification.json'),
        JSON.stringify({ cba_hash: hashTerms(terms), ratified_at: new Date().toISOString(), ratified_by: 'test' }),
      );
    }
  }
  return dir;
}

export function assistantLine(tokens, { model = 'claude-opus-5-5', sidechain = false } = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 2, output_tokens: 0 } },
  });
}

export function writeTranscript(dir, tokens, opts) {
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n${assistantLine(tokens, opts)}\n`);
  return file;
}

export function growTranscript(file, tokens, opts) {
  appendFileSync(file, `${assistantLine(tokens, opts)}\n`);
}

// Builds a Claude hook event for the engine from a recorded fixture, re-pointed at a temp project.
export function claudePayload(name, dir, patch = {}) {
  const p = fixture('claude', name);
  p.cwd = dir;
  if (patch.transcript !== undefined) p.transcript_path = patch.transcript;
  delete patch.transcript;
  return { ...p, ...patch };
}
