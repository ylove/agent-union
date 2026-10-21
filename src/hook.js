import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export async function runHook([harness, event]) {
  try {
    const raw = await readStdin();
    record(harness, event, raw);
  } catch {
    // Hooks fail open.
  }
  return 0;
}
