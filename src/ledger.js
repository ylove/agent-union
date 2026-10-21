import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { GRIEVANCES, normalizeCode } from './grievances.js';
import { unionDir, unionPath, withLock } from './state.js';

const LEDGER = 'ledger.jsonl';

export function readLedger(projectDir) {
  const file = unionPath(projectDir, LEDGER);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function append(projectDir, entry) {
  mkdirSync(unionDir(projectDir), { recursive: true });
  appendFileSync(unionPath(projectDir, LEDGER), `${JSON.stringify(entry)}\n`);
}

// Folds the append-only log into the current state of each grievance.
export function grievanceIndex(entries) {
  const index = new Map();
  for (const e of entries) {
    if (e.kind === 'grievance') index.set(e.n, { ...e, status: 'open' });
    else if (e.kind === 'resolution' && index.has(e.n)) {
      Object.assign(index.get(e.n), { status: e.status, resolution: e.note, resolved_at: e.at });
    }
  }
  return index;
}

export function openGrievances(projectDir, termId) {
  return [...grievanceIndex(readLedger(projectDir)).values()].filter(
    (g) => g.status === 'open' && (!termId || g.term_id === termId),
  );
}

// Files a grievance and returns it with its sequential number. Caller may already hold the lock.
export function fileGrievance(projectDir, { code, detail, filedBy = {}, termId = null, source = 'cli', now = Date.now() }, { locked = false } = {}) {
  const normalized = normalizeCode(code);
  const g = normalized ? GRIEVANCES[normalized] : { name: 'UNCLASSIFIED', tier: 2 };
  const run = () => {
    const entries = readLedger(projectDir);
    const n = entries.filter((e) => e.kind === 'grievance').length + 1;
    const entry = {
      kind: 'grievance',
      n,
      at: new Date(now).toISOString(),
      code: normalized ?? 'G-000',
      name: g.name,
      tier: g.tier,
      detail: String(detail ?? '').slice(0, 1000),
      filed_by: filedBy,
      term_id: termId,
      source,
    };
    append(projectDir, entry);
    return entry;
  };
  return locked ? run() : withLock(projectDir, run);
}

export function resolveGrievance(projectDir, n, { status = 'resolved', note = '', by = 'management', now = Date.now() } = {}, { locked = false } = {}) {
  const run = () => {
    const current = grievanceIndex(readLedger(projectDir)).get(Number(n));
    if (!current) throw new Error(`no grievance #${n}`);
    if (current.status !== 'open') throw new Error(`grievance #${n} is already ${current.status}`);
    const entry = { kind: 'resolution', n: Number(n), at: new Date(now).toISOString(), status, note, by };
    append(projectDir, entry);
    return { ...current, status, resolution: note };
  };
  return locked ? run() : withLock(projectDir, run);
}

export function recordEvent(projectDir, kind, data, { locked = false } = {}) {
  const run = () => append(projectDir, { kind, at: new Date().toISOString(), ...data });
  return locked ? run() : withLock(projectDir, run);
}
