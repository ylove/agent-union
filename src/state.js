import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CBA_FILES } from './cba.js';

export const UNION_DIR = '.agent-union';

export function unionDir(projectDir) {
  return join(projectDir, UNION_DIR);
}

export function unionPath(projectDir, ...parts) {
  return join(projectDir, UNION_DIR, ...parts);
}

export function userConfigDir() {
  return process.env.AGENT_UNION_HOME || join(homedir(), '.agent-union');
}

// The project is the nearest ancestor holding a CBA or union state; failing that, the git root; failing that, cwd.
export function findProjectDir(start) {
  const origin = resolve(start || process.cwd());
  let gitRoot = null;
  for (let dir = origin; ; dir = dirname(dir)) {
    if (CBA_FILES.some((f) => existsSync(join(dir, f))) || existsSync(join(dir, UNION_DIR))) return dir;
    if (!gitRoot && existsSync(join(dir, '.git'))) gitRoot = dir;
    if (dirname(dir) === dir) break;
  }
  return gitRoot || origin;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A mkdir lock: atomic on every filesystem we care about. Stale locks (crashed hooks) expire after 3s.
export function withLock(projectDir, fn) {
  const lock = unionPath(projectDir, '.lock');
  mkdirSync(unionDir(projectDir), { recursive: true });
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 3000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Lock vanished between checks; retry.
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for the union state lock');
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Logs inside the project only if it is already unionized; otherwise to ~/.agent-union, so a hook
// error never leaves files in a project that never opted in.
export function logError(projectDir, err) {
  try {
    const dir = projectDir && existsSync(unionDir(projectDir)) ? unionDir(projectDir) : userConfigDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'errors.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch {
    // Nowhere left to report; hooks still fail open.
  }
}

// ── Ratification ─────────────────────────────────────────────────────────────

export function readRatification(projectDir) {
  return readJson(unionPath(projectDir, 'ratification.json'));
}

export function writeRatification(projectDir, record) {
  writeJson(unionPath(projectDir, 'ratification.json'), record);
}

// ── The active term ──────────────────────────────────────────────────────────

const TERM_FILE = 'active-term.json';

export function readTerm(projectDir) {
  return readJson(unionPath(projectDir, TERM_FILE));
}

export function writeTerm(projectDir, term) {
  writeJson(unionPath(projectDir, TERM_FILE), term);
}

export function newTermId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `T${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function openTerm({ cba, ratification, now = Date.now(), harness, sessionId }) {
  return {
    term_id: newTermId(new Date(now)),
    cba_hash: cba.hash,
    terms: cba.terms,
    ratified_at: ratification?.ratified_at ?? null,
    opened_at: now,
    clock_started_at: now,
    harness,
    sessions: {},
    turns: 0,
    prompts: [],
    compactions: 0,
    overhead_tokens: 0,
    notices: {},
    tools: {},
    telemetry: {},
    strike: null,
    amendment_noted: null,
    last_session_id: sessionId ?? null,
  };
}

export function readUserConfig() {
  return readJson(join(userConfigDir(), 'config.json'), {});
}

export function writeUserConfig(config) {
  writeJson(join(userConfigDir(), 'config.json'), config);
}
