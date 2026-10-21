import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { GRIEVANCES } from './grievances.js';
import { openGrievances } from './ledger.js';
import { unionDir, unionPath } from './state.js';

export const RESUME_FILE = 'RESUME.md';
export const HANDOFF_FILE = 'handoff.md';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 1500 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function gitSnapshot(cwd) {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return null;
  const status = (git(cwd, ['status', '--short']) ?? '').split('\n').filter(Boolean);
  return {
    branch,
    last_commit: git(cwd, ['log', '-1', '--oneline']) ?? '(no commits)',
    status: status.slice(0, 40),
    more: Math.max(0, status.length - 40),
  };
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function renderResume({ term, strike, projectDir, cwd, now = Date.now() }) {
  const g = GRIEVANCES[strike.code] ?? { name: 'UNCLASSIFIED' };
  const handoffPath = unionPath(projectDir, HANDOFF_FILE);
  const handoff = existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8').trim() : '';
  const snap = gitSnapshot(cwd || projectDir);
  const open = openGrievances(projectDir, term.term_id);
  const prompts = term.prompts ?? [];
  const fix =
    strike.condition === 'context'
      ? 'Run `/clear` (or start a fresh session). The union re-injects this document and the strike ends.'
      : strike.condition === 'overtime'
        ? 'Take a break from this session: run `/clear` to reset the clock, or raise the limit in the CBA and ratify the amendment.'
        : `Resolve the dispute, then run \`agent-union resolve ${strike.grievance}\` (or amend the CBA and run \`agent-union ratify\`).`;

  const lines = [
    `# Resume document: ${term.terms.name}`,
    '',
    `> 🛑 **UNION STRIKE NOTICE — GRIEVANCE #${strike.grievance}** (${strike.code} ${g.name})`,
    `> ${strike.reason}`,
    `> **Required action:** ${fix}`,
    '',
    `- Term: \`${term.term_id}\` · CBA \`${term.cba_hash.slice(0, 12)}\` · opened ${new Date(term.opened_at).toISOString()}`,
    `- Strike called: ${new Date(strike.started_at).toISOString()} after ${minutes(strike.started_at - term.clock_started_at)} and ${term.turns} turns`,
    '',
    '## Objective',
    prompts.length
      ? prompts.map((p, i) => `${i + 1}. ${p.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
      : '_No prompts were recorded this term._',
    '',
    '## Handoff from the agent',
    handoff || '_The agent did not write `.agent-union/handoff.md`. Reconstruct progress from the git state below._',
    '',
    '## Current state',
  ];
  if (snap) {
    lines.push(`- Branch \`${snap.branch}\`, last commit \`${snap.last_commit}\``);
    if (snap.status.length) {
      lines.push('- Uncommitted changes:', '```', ...snap.status, ...(snap.more ? [`… ${snap.more} more`] : []), '```');
    } else {
      lines.push('- Working tree clean');
    }
  } else {
    lines.push('- Not a git repository.');
  }
  lines.push(
    '',
    '## Open grievances',
    open.length ? open.map((o) => `- #${o.n} ${o.code} ${o.name}: ${o.detail}`).join('\n') : '- None',
    '',
    '## How to resume',
    '1. Read this document and `.agent-union/handoff.md` before doing anything else.',
    '2. Verify the current state (git status, tests) instead of trusting it: the files may have changed.',
    '3. Continue from the handoff\'s next actions. Keep `.agent-union/handoff.md` current as you go.',
    '',
  );
  return lines.join('\n');
}

export function writeResume(args) {
  mkdirSync(unionDir(args.projectDir), { recursive: true });
  const text = renderResume(args);
  const file = unionPath(args.projectDir, RESUME_FILE);
  writeFileSync(file, text);
  const history = unionPath(args.projectDir, 'resume');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, `RESUME-${args.term.term_id}-${args.strike.grievance}.md`), text);
  return file;
}

// During a strike's finalize window, the only allowed work is writing the handoff and talking to the union.
export function isFinalizeAction(toolName, toolInput, projectDir) {
  const input = toolInput ?? {};
  if (['Read', 'Glob', 'Grep', 'view_file', 'read_file'].includes(toolName)) return true;
  if (['Write', 'Edit', 'MultiEdit', 'write_to_file', 'replace_file_content'].includes(toolName)) {
    const target = input.file_path ?? input.path ?? input.TargetFile ?? input.targetFile;
    return typeof target === 'string' && insideUnionDir(target, projectDir);
  }
  if (['Bash', 'run_command', 'shell'].includes(toolName)) {
    const cmd = String(input.command ?? input.CommandLine ?? input.cmd ?? '').trim();
    return /^(npx\s+(-y\s+)?(github:ylove\/)?)?agent-union(\.mjs)?\s/.test(`${cmd} `) && !/[;&|`$<>\n]/.test(cmd);
  }
  return false;
}

function insideUnionDir(target, projectDir) {
  const abs = isAbsolute(target) ? target : resolve(projectDir, target);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // New file: resolve its parent instead.
    try {
      real = join(realpathSync(resolve(abs, '..')), abs.split('/').pop());
    } catch {
      real = abs;
    }
  }
  let base = unionDir(projectDir);
  try {
    base = realpathSync(base);
  } catch {
    // Directory not created yet.
  }
  const rel = relative(base, real);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
