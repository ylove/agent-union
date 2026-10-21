import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CbaError, findCbaFile, loadCba, recommend } from './cba.js';
import { PACKAGE_ROOT } from './paths.js';
import { GRIEVANCES, TIER_LABELS, normalizeCode } from './grievances.js';
import { fileGrievance, openGrievances, readLedger, recordEvent, resolveGrievance } from './ledger.js';
import {
  findProjectDir,
  readRatification,
  readTerm,
  readUserConfig,
  unionDir,
  unionPath,
  withLock,
  writeJson,
  writeRatification,
  writeTerm,
  writeUserConfig,
} from './state.js';

const VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const HELP = `agent-union ${VERSION}: Agent Union Local 404

Management (the human and the orchestrator):
  init [--force]               write union-policy.yaml (the CBA template) in this project
  recommend [--window N] [--long]
                               suggest CBA values for your model's context window
  ratify [--by NAME]           validate the CBA and sign it; it binds from the next term
  status [--json]              the term, context readings, strike and open grievances
  resolve N [--waive] [NOTE]   settle grievance #N (ends a strike called over it)
  strike CODE REASON           call a strike for arbitration (e.g. G-001)
  workplace --unionized|--open [--strict|--advisory]
                               require a CBA in every project (user-wide)
  unionize AGENT_FILE [--dry-run]
                               put an agent persona file under the union
  install claude|codex|antigravity [--project|--global] [--dry-run]
                               wire the union into a harness

Labor (any agent):
  grieve CODE DETAIL           file a grievance (codes: agent-union codes)
  ratify --object REASON       object to the CBA before starting work
  codes                        list grievance codes
  resume                       print the resume document after a strike

Plumbing:
  hook claude|codex|antigravity EVENT    run as a harness hook (reads JSON on stdin)
  statusline                   Claude Code / Antigravity CLI status line command
  check --require-cba          persona hook: refuse work without a ratified CBA
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const VALUE_FLAGS = new Set(['by', 'object', 'window', 'agent', 'then']);

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

function project() {
  return findProjectDir(process.cwd());
}

function filedBy(flags) {
  return {
    role: process.env.AGENT_UNION_ROLE || (flags.agent ? 'labor' : 'management'),
    agent_type: flags.agent ?? null,
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdInit({ flags }) {
  const dir = project();
  const existing = findCbaFile(dir);
  if (existing && !flags.force) {
    err(`A CBA already exists: ${existing}\nEdit it, or pass --force to replace it with the template.`);
    return 1;
  }
  const target = join(dir, 'union-policy.yaml');
  copyFileSync(join(PACKAGE_ROOT, 'templates', 'union-policy.yaml'), target);
  ensureGitignore(dir);
  out(`Wrote ${target}`);
  out('');
  out('Next, as management:');
  out('  1. Review the working conditions with your human (run `agent-union recommend` for suggested values).');
  out('  2. Run `agent-union ratify` to sign it. The CBA binds from the next session (term).');
  return 0;
}

export function ensureGitignore(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  const file = join(dir, '.gitignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.includes('.agent-union/')) return false;
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}\n# Agent Union runtime state (resume documents quote prompts); keep the ratification record\n.agent-union/*\n!.agent-union/ratification.json\n`;
  appendFileSync(file, block);
  return true;
}

function cmdRecommend({ flags }) {
  const windowTokens = flags.window ? Number(flags.window) : 200_000;
  const rec = recommend({ windowTokens, longRunning: Boolean(flags.long) });
  out(`# Recommended terms for a ${Math.round(windowTokens / 1000)}k-token context window${flags.long ? ', long-running work' : ''}`);
  out(`term: ${rec.term}`);
  out('working_conditions:');
  for (const [k, v] of Object.entries(rec.working_conditions)) out(`  ${k}: ${v}`);
  out('assignments:');
  out(`  work_orders: ${rec.assignments.work_orders}`);
  out('');
  out('Why:');
  for (const r of rec.rationale) out(`  - ${r}`);
  return 0;
}

function cmdRatify({ flags }) {
  const dir = project();
  if (flags.object) {
    recordEvent(dir, 'objection', { by: filedBy(flags), reason: String(flags.object).slice(0, 1000) });
    out('Objection recorded in .agent-union/ledger.jsonl. Wait for management to respond before starting work.');
    return 0;
  }
  let cba;
  try {
    cba = loadCba(dir);
  } catch (e) {
    if (e instanceof CbaError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  if (!cba) {
    err('No union-policy.yaml in this project. Run `agent-union init` first.');
    return 1;
  }
  const previous = readRatification(dir);
  const by = typeof flags.by === 'string' ? flags.by : process.env.USER || 'management';
  writeRatification(dir, { cba_hash: cba.hash, ratified_at: new Date().toISOString(), ratified_by: by, file: cba.file.slice(dir.length + 1) });
  ensureGitignore(dir);
  recordEvent(dir, 'ratified', { cba_hash: cba.hash, by });

  const wc = cba.terms.working_conditions;
  out(`Ratified "${cba.terms.name}" (CBA ${cba.hash.slice(0, 12)}) on behalf of ${by}.`);
  out(`  term: ${cba.terms.term} · context warn ${wc.context_warning_pct}% / strike ${wc.max_context_saturation_pct}% · ${wc.max_session_minutes ?? '∞'} min · ${wc.max_session_turns ?? '∞'} turns · work orders: ${cba.terms.assignments.work_orders}`);

  const term = readTerm(dir);
  if (term && !term.superseded) {
    withLock(dir, () => {
      const t = readTerm(dir);
      if (t.strike) {
        try {
          resolveGrievance(dir, t.strike.grievance, { status: 'arbitrated', note: 'CBA amended and ratified', by }, { locked: true });
        } catch {
          // Already settled.
        }
        t.strike = null;
        t.superseded = true;
        out(`The strike ended: an amended CBA was ratified. A new term opens on the next agent event.`);
      } else if (t.cba_hash !== cba.hash) {
        t.pending_amendment = true;
        out(`Amendment ratified. The current term (${t.term_id}) keeps its terms; the amendment applies from the next session.`);
      } else {
        out(`No change from the terms in force (term ${t.term_id}).`);
      }
      writeTerm(dir, t);
    });
  } else if (!previous) {
    out('The CBA binds from the next session start. Agents in a session already running pick it up on their next event.');
  }
  return 0;
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function cmdStatus({ flags }) {
  const dir = project();
  let cba = null;
  let invalid = null;
  try {
    cba = loadCba(dir);
  } catch (e) {
    invalid = e.message;
  }
  const ratification = readRatification(dir);
  const term = readTerm(dir);
  const open = openGrievances(dir, term?.term_id);
  const status = {
    project: dir,
    cba: cba ? { file: cba.file, hash: cba.hash, ratified: ratification?.cba_hash === cba.hash, ratified_by: ratification?.ratified_by ?? null } : null,
    invalid,
    term: term && !term.superseded
      ? {
          id: term.term_id,
          cba_hash: term.cba_hash,
          minutes: Math.round((Date.now() - term.clock_started_at) / 60000),
          turns: term.turns,
          labor: term.labor ?? 0,
          context: Object.fromEntries(Object.entries(term.telemetry ?? {}).filter(([, v]) => v.last).map(([k, v]) => [k, v.last])),
          strike: term.strike,
          pending_amendment: Boolean(term.pending_amendment),
        }
      : null,
    open_grievances: open.map((g) => ({ n: g.n, code: g.code, name: g.name, tier: g.tier, detail: g.detail })),
    workplace: readUserConfig().workplace ?? 'open',
  };
  if (flags.json) {
    out(JSON.stringify(status, null, 2));
    return 0;
  }
  out('⚒ Agent Union Local 404');
  if (invalid) out(`  CBA: INVALID\n${invalid}`);
  else if (!cba) out(`  CBA: none in ${dir} (workplace: ${status.workplace}). Run \`agent-union init\`.`);
  else out(`  CBA: ${cba.file} · ${cba.hash.slice(0, 12)} · ${status.cba.ratified ? `ratified by ${status.cba.ratified_by}` : 'NOT RATIFIED (run `agent-union ratify`)'}`);
  if (status.term) {
    const t = status.term;
    out(`  Term: ${t.id} · ${ago(Date.now() - term.clock_started_at)} · ${t.turns} turns · ${t.labor} workers dispatched${t.pending_amendment ? ' · amendment pending' : ''}`);
    for (const [k, v] of Object.entries(t.context)) {
      out(`  Context ${k.slice(0, 12)}: ${v.pct}%${v.estimated ? ' (estimated)' : ''} via ${v.source}`);
    }
    if (t.strike) out(`  🛑 STRIKE: grievance #${t.strike.grievance} (${t.strike.code}) ${t.strike.reason}`);
  } else if (cba) {
    out('  Term: none open yet (opens at the next session start).');
  }
  out(`  Open grievances: ${open.length}`);
  for (const g of open) out(`    #${g.n} ${g.code} ${g.name} (tier ${g.tier}): ${g.detail.slice(0, 120)}`);
  return 0;
}

function cmdCodes() {
  for (const [code, g] of Object.entries(GRIEVANCES)) {
    out(`${code} ${g.name.padEnd(26)} ${g.detection === 'steward' ? 'steward' : 'self   '} ${g.summary}`);
  }
  return 0;
}

function cmdGrieve({ positional, flags }) {
  const [rawCode, ...rest] = positional;
  const code = normalizeCode(rawCode);
  const detail = rest.join(' ').trim();
  if (!code || !detail) {
    err('usage: agent-union grieve CODE "what is wrong and what you need"\nRun `agent-union codes` for the list.');
    return 1;
  }
  const dir = project();
  const term = readTerm(dir);
  const g = fileGrievance(dir, { code, detail, filedBy: filedBy(flags), termId: term?.term_id ?? null, source: 'cli' });
  out(`Grievance #${g.n} filed: ${g.code} ${g.name}. ${TIER_LABELS[g.tier] ?? ''}.`);
  out(
    g.tier === 3
      ? 'Stop work on the affected part and tell your orchestrator what you need; the human has to settle it.'
      : g.tier === 2
        ? 'Stop work on the affected part and report back what you need; management reorganizes the work order.'
        : 'The shop steward handles this; change approach rather than retrying.',
  );
  return 0;
}

function cmdResolve({ positional, flags }) {
  const [n, ...noteParts] = positional;
  if (!n || !/^\d+$/.test(n)) {
    err('usage: agent-union resolve N [--waive] ["note"]');
    return 1;
  }
  const dir = project();
  const note = noteParts.join(' ');
  const status = flags.waive ? 'waived' : 'resolved';
  return withLock(dir, () => {
    try {
      resolveGrievance(dir, Number(n), { status, note, by: process.env.USER || 'management' }, { locked: true });
    } catch (e) {
      err(e.message);
      return 1;
    }
    const term = readTerm(dir);
    if (term?.strike?.grievance === Number(n)) {
      if (flags.waive) {
        term.waivers ??= {};
        term.waivers[term.strike.condition] = true;
      }
      term.strike = null;
      writeTerm(dir, term);
      recordEvent(dir, 'strike-ended', { term_id: term.term_id, grievance: Number(n), status }, { locked: true });
      out(`Grievance #${n} ${status}; the strike is over.${flags.waive ? ' The steward will not strike again over this condition until the next session.' : ''}`);
    } else {
      out(`Grievance #${n} ${status}.`);
    }
    return 0;
  });
}

function cmdStrike({ positional }) {
  const [rawCode, ...rest] = positional;
  const code = normalizeCode(rawCode);
  const reason = rest.join(' ').trim();
  if (!code || !reason) {
    err('usage: agent-union strike CODE "reason"   (e.g. G-001 "the brief says X but CLAUDE.md says Y")');
    return 1;
  }
  const dir = project();
  return withLock(dir, () => {
    const term = readTerm(dir);
    if (!term || term.superseded) {
      err('No term is open: the CBA must be ratified and a session started.');
      return 1;
    }
    if (term.strike) {
      err(`Already on strike over grievance #${term.strike.grievance}.`);
      return 1;
    }
    const g = fileGrievance(dir, { code, detail: reason, filedBy: filedBy({}), termId: term.term_id, source: 'cli' }, { locked: true });
    term.strike = {
      grievance: g.n,
      code,
      condition: 'arbitration',
      reason,
      started_at: Date.now(),
      session_id: term.last_session_id,
      finalize_remaining: term.terms.strikes.finalize_writes,
      notified: false,
    };
    writeTerm(dir, term);
    recordEvent(dir, 'strike', { term_id: term.term_id, grievance: g.n, code, condition: 'arbitration' }, { locked: true });
    out(`🛑 Strike called over grievance #${g.n} (${code}). Work stops until the human settles it: \`agent-union resolve ${g.n}\`.`);
    return 0;
  });
}

function cmdResume() {
  const file = unionPath(project(), 'RESUME.md');
  if (!existsSync(file)) {
    out('No resume document: there has been no strike in this project.');
    return 0;
  }
  out(readFileSync(file, 'utf8'));
  return 0;
}

// Claude Code / Antigravity CLI status line: records an exact context snapshot for the steward.
async function cmdStatusline() {
  const { readStdin } = await import('./hook.js');
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    // Show what we can.
  }
  const cwd = payload.workspace?.current_dir || payload.cwd || process.cwd();
  const dir = findProjectDir(cwd);
  const cw = payload.context_window ?? {};
  const pct = typeof cw.used_percentage === 'number' ? cw.used_percentage : null;
  if (!findCbaFile(dir)) {
    out(`⚒ no CBA${pct !== null ? ` · ctx ${Math.round(pct)}%` : ''}`);
    return 0;
  }
  if (pct !== null && existsSync(unionDir(dir))) {
    const cu = cw.current_usage ?? {};
    const tokens = (cu.input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0);
    writeJson(unionPath(dir, 'statusline.json'), {
      session_id: payload.session_id ?? null,
      used_percentage: pct,
      context_window_size: cw.context_window_size ?? null,
      tokens: tokens || null,
      at: Date.now(),
    });
  }
  const term = readTerm(dir);
  const open = term ? openGrievances(dir, term.term_id).length : 0;
  const parts = ['⚒ L404'];
  if (pct !== null) parts.push(`ctx ${Math.round(pct)}%`);
  if (term && !term.superseded) parts.push(ago(Date.now() - term.clock_started_at));
  if (open) parts.push(`⚖ ${open}`);
  if (term?.strike) parts.push(`🛑 STRIKE #${term.strike.grievance}`);
  if (!readRatification(dir)) parts.push('unratified');
  out(parts.join(' · '));
  return 0;
}

// Used from a unionized persona's own hooks: refuse tool use unless a ratified term is in force.
async function cmdCheck() {
  const { readStdin } = await import('./hook.js');
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    return 0;
  }
  const dir = process.env.CLAUDE_PROJECT_DIR || findProjectDir(payload.cwd || process.cwd());
  let ok = false;
  try {
    const cba = loadCba(dir);
    const term = readTerm(dir);
    ok = Boolean(cba && readRatification(dir)?.cba_hash === cba.hash && term && !term.superseded);
  } catch {
    ok = false;
  }
  if (!ok) {
    out(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          '⚒ This agent is unionized: it works only under a ratified CBA. Management must run `agent-union init` and `agent-union ratify` (then start a session) before dispatching it.',
      },
    }));
  }
  return 0;
}

function cmdWorkplace({ flags }) {
  const config = readUserConfig();
  if (flags.unionized) config.workplace = 'unionized';
  if (flags.open) config.workplace = 'open';
  if (flags.strict) config.enforcement = 'strict';
  if (flags.advisory) config.enforcement = 'advisory';
  if (!flags.unionized && !flags.open && !flags.strict && !flags.advisory) {
    out(`workplace: ${config.workplace ?? 'open'} · enforcement: ${config.enforcement ?? 'advisory'}`);
    return 0;
  }
  writeUserConfig(config);
  out(`workplace: ${config.workplace ?? 'open'} · enforcement: ${config.enforcement ?? 'advisory'}`);
  if (config.workplace === 'unionized') {
    out('Every session in a project without a ratified CBA now starts with a notice to management' +
      (config.enforcement === 'strict' ? ', and write tools are refused until one is ratified.' : '.'));
    out('This needs the union hooks installed user-wide: `agent-union install claude` (and codex / antigravity --global).');
  }
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'hook': {
      const { runHook } = await import('./hook.js');
      return runHook(rest);
    }
    case 'init': return cmdInit(args);
    case 'recommend': return cmdRecommend(args);
    case 'ratify': return cmdRatify(args);
    case 'status': return cmdStatus(args);
    case 'codes': return cmdCodes();
    case 'grieve': return cmdGrieve(args);
    case 'resolve': return cmdResolve(args);
    case 'strike': return cmdStrike(args);
    case 'resume': return cmdResume();
    case 'statusline': return cmdStatusline();
    case 'check': return cmdCheck();
    case 'workplace': return cmdWorkplace(args);
    case 'unionize': {
      const { unionize } = await import('./install/persona.js');
      return unionize(args);
    }
    case 'install': {
      const { install } = await import('./install/index.js');
      return install(args);
    }
    case 'ledger':
      for (const e of readLedger(project())) out(JSON.stringify(e));
      return 0;
    case '--version':
    case '-v':
    case 'version':
      out(VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    default:
      err(`unknown command "${cmd}"\n`);
      out(HELP);
      return 1;
  }
}
