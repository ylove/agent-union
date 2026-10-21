import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle } from './engine.js';
import { findProjectDir, logError } from './state.js';

const ADAPTERS = {
  claude: () => import('./adapters/claude.js'),
  codex: () => import('./adapters/codex.js'),
  antigravity: () => import('./adapters/antigravity.js'),
};

export async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Saves the raw payload when AGENT_UNION_RECORD names a directory. Used to capture fixtures.
function record(harness, event, raw) {
  const dir = process.env.AGENT_UNION_RECORD;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  writeFileSync(join(dir, `${harness}-${event}-${stamp}-${rand}.json`), raw);
}

// Runs one hook event end to end. Never throws and always exits 0: a broken union must not stop work.
export async function processHook(harness, eventName, raw, env = process.env) {
  let projectDir = null;
  try {
    const load = ADAPTERS[harness];
    if (!load) return '';
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const adapter = await load();
    const ev = adapter.normalize(payload, eventName, env);
    projectDir = ev.projectDir;
    const decision = handle(ev);
    return adapter.render(decision, ev.event, ev);
  } catch (err) {
    logError(projectDir || findProjectDir(process.cwd()), err);
    return '';
  }
}

export async function runHook([harness, eventName]) {
  try {
    const raw = await readStdin();
    record(harness, eventName, raw);
    const out = await processHook(harness, eventName, raw);
    if (out) process.stdout.write(out);
  } catch {
    // Fail open.
  }
  return 0;
}
