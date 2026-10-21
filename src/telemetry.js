import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { windowForModel } from './cba.js';
import { readJson, unionPath } from './state.js';

const TAIL_BYTES = 256 * 1024;
const DEFAULT_WINDOW = 200_000;
const SNAPSHOT_MAX_AGE_MS = 120_000;

// Reads at most `max` bytes from the end of a file, dropping the first partial line.
export function readTail(file, max = TAIL_BYTES) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, size };
  } finally {
    closeSync(fd);
  }
}

function contentChars(message) {
  const c = message?.content;
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const part of c) {
    if (typeof part?.text === 'string') n += part.text.length;
    if (typeof part?.content === 'string') n += part.content.length;
    if (Array.isArray(part?.content)) for (const p of part.content) if (typeof p?.text === 'string') n += p.text.length;
    if (part?.input) n += JSON.stringify(part.input).length;
  }
  return n;
}

// Claude Code transcript: the last assistant entry's usage is the context at that request; tool results
// written after it are not counted yet, so estimate them at ~4 characters per token.
export function claudeUsage(text, { sidechain = false } = {}) {
  const lines = text.split('\n').filter(Boolean);
  let pending = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!sidechain && entry.isSidechain) continue;
    const usage = entry.type === 'assistant' ? entry.message?.usage : null;
    if (usage) {
      const tokens =
        (usage.input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.output_tokens || 0);
      return { tokens: tokens + Math.round(pending / 4), model: entry.message?.model ?? null, estimated: pending > 0 };
    }
    if (entry.type === 'user') pending += contentChars(entry.message);
  }
  return null;
}

// Codex rollout: token_count events carry the last request's usage and the model's context window.
export function codexUsage(text) {
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const info = entry.payload?.info;
      if (entry.payload?.type !== 'token_count' || !info?.last_token_usage) continue;
      const last = info.last_token_usage;
      return {
        tokens: (last.input_tokens || 0) + (last.output_tokens || 0),
        window: info.model_context_window || null,
        estimated: false,
      };
    } catch {
      // Keep scanning older lines.
    }
  }
  return null;
}

// Subagent transcripts live next to the session transcript: <session>/subagents/agent-<id>.jsonl
export function subagentTranscript(transcriptPath, sessionId, agentId) {
  if (!transcriptPath || !agentId) return null;
  const sid = sessionId || basename(transcriptPath, '.jsonl');
  return join(dirname(transcriptPath), sid, 'subagents', `agent-${agentId}.jsonl`);
}

export function subagentDepth(transcriptPath, sessionId, agentId) {
  const file = subagentTranscript(transcriptPath, sessionId, agentId);
  if (!file) return null;
  return readJson(file.replace(/\.jsonl$/, '.meta.json'))?.spawnDepth ?? null;
}

// A statusline snapshot (written by `agent-union statusline`) is exact; prefer it while fresh.
function statuslineSnapshot(projectDir, sessionId, now) {
  const snap = readJson(unionPath(projectDir, 'statusline.json'));
  if (!snap || snap.session_id !== sessionId || now - snap.at > SNAPSHOT_MAX_AGE_MS) return null;
  if (typeof snap.used_percentage !== 'number') return null;
  return {
    pct: snap.used_percentage,
    tokens: snap.tokens ?? null,
    window: snap.context_window_size ?? null,
    source: 'statusline',
    estimated: false,
  };
}

/**
 * Current context usage for one agent. `cache` is a per-agent object persisted in term state that remembers
 * the model and window between calls. Returns { pct, tokens, window, source, estimated } or null.
 */
export function measureContext({ harness, projectDir, transcriptPath, sessionId, agentId, windowOverride, cache = {}, now = Date.now() }) {
  if (!agentId && harness !== 'codex') {
    const snap = statuslineSnapshot(projectDir, sessionId, now);
    if (snap) return snap;
  }
  const file = agentId ? subagentTranscript(transcriptPath, sessionId, agentId) : transcriptPath;
  if (!file || !existsSync(file)) return null;
  const size = statSync(file).size;

  // Usage sits in the last few lines, so a small tail is almost always enough; widen it only if needed.
  let reading = null;
  for (const max of [64 * 1024, TAIL_BYTES * 4]) {
    const { text } = readTail(file, max);
    if (harness === 'codex') reading = codexUsage(text);
    else if (harness === 'claude') reading = claudeUsage(text, { sidechain: Boolean(agentId) });
    if (reading || max >= size) break;
  }
  if (!reading) {
    // Claude transcripts also store raw request bodies and Codex rollouts store events, so their size says
    // little about context; with no usage recorded yet, report nothing rather than a wild guess.
    if (harness === 'claude' || harness === 'codex') return null;
    reading = { tokens: Math.round(size / 4), model: null, estimated: true };
  }
  // The model and window rarely appear; remember them between calls.
  if (reading.model) cache.model = reading.model;
  if (reading.window) cache.window = reading.window;
  reading.model ??= cache.model ?? null;
  reading.window ??= cache.window ?? null;

  const window = windowOverride || reading.window || windowForModel(reading.model) || DEFAULT_WINDOW;
  return {
    pct: Math.round((reading.tokens / window) * 1000) / 10,
    tokens: reading.tokens,
    window,
    source: harness === 'codex' ? 'rollout' : harness === 'claude' ? 'transcript' : 'size-estimate',
    estimated: Boolean(reading.estimated) || (!windowOverride && !reading.window && !windowForModel(reading.model)),
  };
}
