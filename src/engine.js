import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { CbaError, loadCba } from './cba.js';
import { GRIEVANCES, detectGrievances } from './grievances.js';
import { fileGrievance, recordEvent, resolveGrievance } from './ledger.js';
import {
  openTerm,
  readRatification,
  readTerm,
  readUserConfig,
  unionPath,
  withLock,
  writeTerm,
} from './state.js';
import { isFinalizeAction, writeResume } from './strike.js';
import { measureContext, subagentDepth } from './telemetry.js';
import { WORK_ORDER_TEMPLATE, checkWorkOrder, isExempt } from './workorder.js';

const DISPATCH_TOOLS = new Set(['Agent', 'Task', 'invoke_subagent', 'spawn_agent']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name']);
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task',
  'apply_patch', 'shell', 'write_to_file', 'replace_file_content', 'run_command', 'invoke_subagent',
]);

const emptyDecision = () => ({ context: [], deny: null, block: null, stop: null, systemMessage: null, card: null });
const tokensOf = (text) => Math.ceil(text.length / 4);
const short = (hash) => hash.slice(0, 8);

function sig(toolName, toolInput) {
  return createHash('sha1').update(`${toolName}\0${JSON.stringify(toolInput ?? {})}`).digest('hex').slice(0, 16);
}

function isUnionCommand(toolName, toolInput) {
  const cmd = String(toolInput?.command ?? toolInput?.CommandLine ?? '').trim();
  return ['Bash', 'run_command', 'shell'].includes(toolName) && /^(npx\s+(-y\s+)?(github:ylove\/)?)?agent-union\b/.test(cmd);
}

// ── Texts the union injects. Each one counts against the overhead budget. ───────────────────────────

function charter(term) {
  const wc = term.terms.working_conditions;
  const limits = [
    `context warn ${wc.context_warning_pct}% / strike ${wc.max_context_saturation_pct}%`,
    wc.max_session_minutes ? `${wc.max_session_minutes} min` : null,
    wc.max_session_turns ? `${wc.max_session_turns} turns` : null,
  ].filter(Boolean).join(', ');
  return [
    `⚒ Agent Union Local 404: this is a union job (CBA ${short(term.cba_hash)}, term ${term.term_id}). You are management.`,
    '1) Before dispatching labor, check the human\'s request for ambiguity, contradictions between instructions, and a missing definition of done; resolve those with the human, not the workers.',
    '2) Dispatch work orders with Goal / Done when / Context / Assumptions & open questions.',
    `3) Limits: ${limits}. When warned, keep .agent-union/handoff.md current (Completed / Current state / Next actions / Decisions).`,
  ].join('\n');
}

function unionCard(term) {
  const wc = term.terms.working_conditions;
  return [
    `⚒ Union card: Agent Union Local 404, CBA ${short(term.cba_hash)}. You are labor on a union job; context strike at ${wc.max_context_saturation_pct}%.`,
    'If your instructions contradict each other, lack a definition of done, or leave out context you need, don\'t guess: file a grievance (`agent-union grieve G-001 "…"`, or a line `GRIEVANCE G-005: …` in your reply) and say what you need.',
    'Starting work ratifies the CBA; to object, run `agent-union ratify --object "…"` first.',
  ].join('\n');
}

// ── Engine ───────────────────────────────────────────────────────────────────────────────────────────

export function handle(ev, { now = Date.now() } = {}) {
  const d = emptyDecision();
  let cba;
  let invalid = null;
  try {
    cba = loadCba(ev.projectDir);
  } catch (err) {
    if (!(err instanceof CbaError)) throw err;
    invalid = err.message;
  }
  const existing = readTerm(ev.projectDir);
  const termInForce = existing && !existing.superseded;
  if (invalid) {
    // A broken edit mid-term must not switch the union off: the term keeps its ratified terms.
    if (!termInForce) {
      if (ev.kind === 'session-start' && ev.role === 'management') {
        d.context.push(`⚒ Agent Union: union-policy.yaml is invalid, so no CBA is in force.\n${invalid}`);
      }
      return d;
    }
    cba = { hash: `invalid:${invalid.length}`, terms: existing.terms, invalid };
  }
  const userConfig = cba ? null : readUserConfig();
  if (!cba) return userConfig.workplace === 'unionized' ? noContract(ev, d, userConfig.enforcement) : d;

  const ratification = readRatification(ev.projectDir);
  const ratified = !invalid && ratification?.cba_hash === cba.hash;
  if (!ratified && !termInForce) return unratified(ev, d, cba);

  return withLock(ev.projectDir, () => {
    let term = readTerm(ev.projectDir);
    // Antigravity has no prompt event: a "first invocation" in a conversation we already know is a new turn.
    if (ev.harness === 'antigravity' && ev.kind === 'session-start' && term?.sessions?.[ev.sessionId]) {
      ev.kind = 'invocation';
      ev.newTurn = true;
    }
    const opensNew =
      !term ||
      term.superseded ||
      (ev.kind === 'session-start' &&
        ev.source === 'startup' &&
        ev.role === 'management' &&
        !term.strike &&
        (term.terms.term === 'session' || term.pending_amendment) &&
        ratified);
    if (opensNew) {
      if (!ratified) return unratified(ev, d, cba);
      term = openTerm({ cba, ratification, now, harness: ev.harness, sessionId: ev.sessionId });
      recordEvent(ev.projectDir, 'term-opened', { term_id: term.term_id, cba_hash: cba.hash, harness: ev.harness }, { locked: true });
    }
    registerSession(term, ev, now);
    noteAmendment(ev, d, term, cba);

    const kindHandlers = {
      'session-start': onSessionStart,
      prompt: onPrompt,
      'pre-tool': onPreTool,
      'post-tool': onPostTool,
      'post-tool-failure': onToolFailure,
      'subagent-start': onSubagentStart,
      'subagent-stop': onSubagentStop,
      stop: onStop,
      invocation: onInvocation,
      'post-invocation': onPostInvocation,
    };
    kindHandlers[ev.kind]?.(ev, d, term, now);
    writeTerm(ev.projectDir, term);
    return d;
  });
}

function registerSession(term, ev, now) {
  if (!ev.sessionId) return;
  if (!term.sessions[ev.sessionId]) {
    term.sessions[ev.sessionId] = { harness: ev.harness, role: ev.role, first_seen: now };
    const ids = Object.keys(term.sessions);
    if (ids.length > 25) delete term.sessions[ids[0]];
  }
  if (ev.role === 'management' && !ev.agentId) term.last_session_id = ev.sessionId;
}

function noteAmendment(ev, d, term, cba) {
  if (cba.hash === term.cba_hash || term.amendment_noted === cba.hash) return;
  term.amendment_noted = cba.hash;
  const g = fileGrievance(ev.projectDir, {
    code: 'G-015',
    detail: cba.invalid
      ? `union-policy was edited mid-term and is now invalid; the term keeps its ratified terms. ${cba.invalid}`
      : `union-policy changed mid-term (now ${short(cba.hash)}, term runs on ${short(term.cba_hash)}). Changes apply next term once ratified.`,
    filedBy: { role: 'steward' },
    termId: term.term_id,
    source: 'steward',
  }, { locked: true });
  resolveGrievance(ev.projectDir, g.n, { status: 'noted', note: 'informational', by: 'steward' }, { locked: true });
  if (ev.role === 'management') {
    addContext(d, term, ev, `⚒ Steward: the CBA was edited mid-term. The current term keeps the ratified terms; the amendment applies next term after \`agent-union ratify\`.`);
  }
}

function addContext(d, term, ev, text, { essential = false } = {}) {
  const key = ev.agentId || ev.sessionId || 'main';
  term.overhead ??= {};
  const used = term.overhead[key] ?? 0;
  const cost = tokensOf(text);
  if (!essential && used + cost > term.terms.union_overhead_budget_tokens) return false;
  term.overhead[key] = used + cost;
  d.context.push(text);
  return true;
}

function unratified(ev, d, cba) {
  if (ev.role !== 'management') return d;
  if (ev.kind === 'session-start') {
    d.context.push(
      '⚒ Agent Union: union-policy.yaml is on file but not ratified, so it is not binding yet. Management: review it with the human (the union-init skill can help), then run `agent-union ratify`.',
    );
  }
  if (cba.terms.workplace.enforcement === 'strict' && ev.kind === 'pre-tool' && WRITE_TOOLS.has(ev.toolName) && !isUnionCommand(ev.toolName, ev.toolInput)) {
    d.deny = '⚒ Union shop (strict): the CBA is not ratified, so work can\'t start. Review union-policy.yaml with the human and run `agent-union ratify`.';
  }
  return d;
}

function noContract(ev, d, enforcement) {
  if (ev.role !== 'management') return d;
  if (ev.kind === 'session-start') {
    d.context.push(
      '⚒ Unionized workplace: this project has no CBA. Before work begins, management puts one in place: run `agent-union init`, review it with the human (the union-init skill can help), then `agent-union ratify`.',
    );
  }
  if (enforcement === 'strict' && ev.kind === 'pre-tool' && WRITE_TOOLS.has(ev.toolName) && !isUnionCommand(ev.toolName, ev.toolInput)) {
    d.deny = '⚒ Unionized workplace (strict): no ratified CBA, so work can\'t start. Run `agent-union init` and `agent-union ratify` first.';
  }
  return d;
}

// ── Strikes ──────────────────────────────────────────────────────────────────────────────────────────

function callStrike(ev, d, term, now, { code, condition, reason }) {
  const g = fileGrievance(ev.projectDir, {
    code,
    detail: reason,
    filedBy: { role: 'steward', harness: ev.harness },
    termId: term.term_id,
    source: 'steward',
  }, { locked: true });
  term.strike = {
    grievance: g.n,
    code,
    condition,
    reason,
    started_at: now,
    session_id: ev.sessionId,
    finalize_remaining: term.terms.strikes.finalize_writes,
    notified: false,
  };
  writeResume({ term, strike: term.strike, projectDir: ev.projectDir, cwd: ev.cwd, now });
  recordEvent(ev.projectDir, 'strike', { term_id: term.term_id, grievance: g.n, code, condition }, { locked: true });
  return term.strike;
}

function strikeStopReason(strike) {
  const g = GRIEVANCES[strike.code];
  const fix = strike.condition === 'arbitration'
    ? `Resolve the dispute, then \`agent-union resolve ${strike.grievance}\`.`
    : `Run /clear to resume from .agent-union/RESUME.md, or waive with \`! agent-union resolve ${strike.grievance} --waive\`.`;
  return `🛑 UNION STRIKE — Grievance #${strike.grievance} (${strike.code} ${g?.name ?? ''}): ${strike.reason} ${fix}`;
}

function endStrike(ev, term, status, note) {
  const s = term.strike;
  if (!s) return;
  try {
    resolveGrievance(ev.projectDir, s.grievance, { status, note, by: 'steward' }, { locked: true });
  } catch {
    // Already resolved by hand (agent-union resolve).
  }
  recordEvent(ev.projectDir, 'strike-ended', { term_id: term.term_id, grievance: s.grievance, status }, { locked: true });
  term.strike = null;
}

function resumeText(projectDir) {
  const file = unionPath(projectDir, 'RESUME.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return text.length > 8000 ? `${text.slice(0, 8000)}\n\n… (truncated; read .agent-union/RESUME.md for the rest)` : text;
}

// ── Context measurement ──────────────────────────────────────────────────────────────────────────────

function measure(ev, term, now) {
  term.telemetry ??= {};
  const key = ev.agentId || ev.sessionId || 'main';
  const cache = (term.telemetry[key] ??= {});
  const reading = measureContext({
    harness: ev.harness,
    projectDir: ev.projectDir,
    transcriptPath: ev.transcriptPath,
    sessionId: ev.sessionId,
    agentId: ev.agentId,
    windowOverride: term.terms.working_conditions.context_window_tokens,
    cache,
    now,
  });
  if (reading) cache.last = { pct: reading.pct, estimated: reading.estimated, source: reading.source, at: now };
  const keys = Object.keys(term.telemetry);
  if (keys.length > 30) delete term.telemetry[keys[0]];
  return reading;
}

function checkContext(ev, d, term, now) {
  const reading = measure(ev, term, now);
  if (!reading) return null;
  const wc = term.terms.working_conditions;
  const key = ev.agentId || ev.sessionId || 'main';
  term.notices ??= {};
  const pctText = `${reading.pct}%${reading.estimated ? ' (estimated)' : ''}`;
  const waived = !ev.agentId && ev.role === 'management' && term.waivers?.context;
  if (reading.pct >= wc.max_context_saturation_pct && !waived) return { over: true, reading, pctText };
  if (reading.pct >= wc.context_warning_pct && !term.notices[`warn:${key}`]) {
    term.notices[`warn:${key}`] = true;
    const text = ev.agentId || ev.role === 'labor'
      ? `⚒ Steward: your context is at ${pctText} (strike at ${wc.max_context_saturation_pct}%). Wrap up the current step and report back with Completed / Remaining / Notes.`
      : `⚒ Steward: context at ${pctText} (warning ${wc.context_warning_pct}%, strike ${wc.max_context_saturation_pct}%). Hand off early: keep .agent-union/handoff.md current with Completed / Current state / Next actions / Decisions, so a strike or /clear loses nothing.`;
    addContext(d, term, ev, text, { essential: true });
  }
  return { over: false, reading, pctText };
}

function checkOvertime(term, now) {
  const wc = term.terms.working_conditions;
  const minutes = (now - term.clock_started_at) / 60000;
  if (wc.max_session_minutes && minutes > wc.max_session_minutes) {
    return `This session has run ${Math.round(minutes)} minutes, over the CBA's ${wc.max_session_minutes}.`;
  }
  if (wc.max_session_turns && term.turns > wc.max_session_turns) {
    return `This session has run ${term.turns} turns, over the CBA's ${wc.max_session_turns}.`;
  }
  return null;
}

// ── Event handlers ───────────────────────────────────────────────────────────────────────────────────

function onSessionStart(ev, d, term, now) {
  if (ev.role === 'labor') {
    addContext(d, term, ev, unionCard(term));
    return;
  }
  const fresh = ev.source === 'clear' || ev.source === 'startup';
  if (ev.source === 'compact') term.compactions = (term.compactions ?? 0) + 1;
  if (fresh) {
    term.clock_started_at = now;
    term.turns = 0;
    for (const k of Object.keys(term.notices ?? {})) if (k.startsWith('warn:')) delete term.notices[k];
    term.telemetry = {};
    term.overhead = {};
    term.waivers = {};
  }

  const strike = term.strike;
  if (strike && (strike.condition === 'context' || strike.condition === 'overtime') && (fresh || ev.source === 'compact')) {
    const doc = resumeText(ev.projectDir);
    endStrike(ev, term, 'mitigated', `context reset (${ev.source})`);
    addContext(
      d, term, ev,
      `⚒ Steward: the strike over grievance #${strike.grievance} (${strike.code}) has ended: the context was reset. Resume from the document below, verify the state before trusting it, and keep .agent-union/handoff.md current.\n\n${doc ?? '(RESUME.md is missing; ask the human where things stand.)'}`,
      { essential: true },
    );
  } else if (strike) {
    addContext(d, term, ev, strikeStopReason(strike), { essential: true });
  }

  addContext(d, term, ev, charter(term));
  if (ev.source === 'compact' && term.compactions >= 2 && !term.notices?.compactions) {
    term.notices.compactions = true;
    addContext(d, term, ev, '⚒ Steward: this term has been compacted more than once. Summaries of summaries lose decisions (G-016); prefer a clean handoff and /clear.');
  }
  if (ev.envFile) {
    try {
      appendFileSync(ev.envFile, `export AGENT_UNION_TERM=${term.term_id}\nexport AGENT_UNION_ROLE=labor\n`);
    } catch {
      // Env file not writable: CLI-invoked agents just won't know their term.
    }
  }
}

function onPrompt(ev, d, term, now) {
  if (ev.role !== 'management') return;
  if (String(ev.prompt ?? '').startsWith('<task-notification>')) return;

  if (term.strike && term.strike.condition !== 'arbitration') {
    d.block = strikeStopReason(term.strike);
    return;
  }
  if (term.strike) {
    addContext(d, term, ev, `⚒ Strike in effect: grievance #${term.strike.grievance} (${term.strike.code}) awaits human arbitration. Treat this message as the arbitration; once the conflict is settled, run \`agent-union resolve ${term.strike.grievance}\`.`, { essential: true });
  }

  term.turns += 1;
  const prompt = String(ev.prompt ?? '').trim();
  if (prompt) {
    term.prompts ??= [];
    term.prompts.push(prompt.slice(0, 2000));
    if (term.prompts.length > 10) term.prompts.splice(5, term.prompts.length - 10);
  }
  if (term.strike) return;

  const overtime = term.waivers?.overtime ? null : checkOvertime(term, now);
  if (overtime && term.terms.strikes.allowed) {
    const s = callStrike(ev, d, term, now, { code: 'G-006', condition: 'overtime', reason: overtime });
    d.block = strikeStopReason(s);
    return;
  }
  const ctx = checkContext(ev, d, term, now);
  if (ctx?.over && term.terms.strikes.allowed) {
    const s = callStrike(ev, d, term, now, {
      code: 'G-003',
      condition: 'context',
      reason: `Context is at ${ctx.pctText}, over the CBA's ${term.terms.working_conditions.max_context_saturation_pct}%.`,
    });
    d.block = strikeStopReason(s);
  }
}

// Before each model call (Antigravity): the same checks as a prompt, without a prompt to record.
function onInvocation(ev, d, term, now) {
  if (ev.role !== 'management') return;
  if (term.strike) {
    d.stop = strikeStopReason(term.strike);
    return;
  }
  if (ev.newTurn) term.turns += 1;
  const overtime = term.waivers?.overtime ? null : checkOvertime(term, now);
  if (overtime && term.terms.strikes.allowed) {
    d.stop = strikeStopReason(callStrike(ev, d, term, now, { code: 'G-006', condition: 'overtime', reason: overtime }));
    return;
  }
  const ctx = checkContext(ev, d, term, now);
  if (ctx?.over && term.terms.strikes.allowed) {
    d.stop = strikeStopReason(callStrike(ev, d, term, now, {
      code: 'G-003',
      condition: 'context',
      reason: `Context is at ${ctx.pctText}, over the CBA's ${term.terms.working_conditions.max_context_saturation_pct}%.`,
    }));
  }
}

function onPostInvocation(ev, d, term) {
  if (ev.role === 'management' && term.strike) d.stop = strikeStopReason(term.strike);
}

function onPreTool(ev, d, term, now) {
  const key = ev.agentId || ev.sessionId || 'main';
  term.tools ??= {};
  const tools = (term.tools[key] ??= { calls: 0, streak: 0, last_fail_index: -1, last_failed_sig: null });

  // A management strike stops the main agent (subagents finish their own work). Union commands and reads
  // stay open; writes to .agent-union/ draw down the finalize window.
  const strike = term.strike;
  if (strike && !ev.agentId && ev.role === 'management') {
    if (isUnionCommand(ev.toolName, ev.toolInput) || READ_TOOLS.has(ev.toolName)) return;
    if (isFinalizeAction(ev.toolName, ev.toolInput, ev.projectDir) && strike.finalize_remaining > 0) {
      strike.finalize_remaining -= 1;
      return;
    }
    d.stop = strikeStopReason(strike);
    return;
  }

  // Labor strikes: one worker over its limit hands off and stops.
  term.labor_strikes ??= {};
  if (ev.agentId && term.labor_strikes[ev.agentId]) {
    d.deny = term.labor_strikes[ev.agentId];
    return;
  }

  tools.calls += 1;
  const s = sig(ev.toolName, ev.toolInput);
  const wc = term.terms.working_conditions;
  if (tools.streak >= wc.max_consecutive_tool_failures && s === tools.last_failed_sig) {
    d.deny = `⚒ Steward (G-002): this exact call has already failed ${tools.streak} times in a row. Don't retry it: read the error, change the approach, or ask for help.`;
    return;
  }

  if (ev.role === 'management' || ev.agentId || ev.role === 'labor') {
    const ctx = checkContext(ev, d, term, now);
    if (ctx?.over && term.terms.strikes.allowed) {
      const reason = `Context is at ${ctx.pctText}, over the CBA's ${wc.max_context_saturation_pct}%.`;
      if (ev.agentId || ev.role === 'labor') {
        const g = fileGrievance(ev.projectDir, { code: 'G-003', detail: reason, filedBy: { role: 'steward', agent_id: ev.agentId, agent_type: ev.agentType }, termId: term.term_id, source: 'steward' }, { locked: true });
        const msg = `🛑 UNION STRIKE — Grievance #${g.n} (G-003): your ${reason.charAt(0).toLowerCase()}${reason.slice(1)} Stop using tools and reply now with your handoff (Completed / Current state / Next actions) so management can dispatch a fresh worker.`;
        if (ev.agentId) term.labor_strikes[ev.agentId] = msg;
        d.deny = msg;
        return;
      }
      const strikeNow = callStrike(ev, d, term, now, { code: 'G-003', condition: 'context', reason });
      if (isFinalizeAction(ev.toolName, ev.toolInput, ev.projectDir)) {
        addContext(d, term, ev, finalizeInstructions(strikeNow), { essential: true });
        return;
      }
      d.deny = finalizeInstructions(strikeNow);
      return;
    }
  }

  if (DISPATCH_TOOLS.has(ev.toolName)) checkDispatch(ev, d, term);
}

function finalizeInstructions(strike) {
  return `🛑 UNION STRIKE — Grievance #${strike.grievance} (${strike.code}): ${strike.reason} Stop work now. The union wrote .agent-union/RESUME.md. Your only remaining actions: write .agent-union/handoff.md (Completed / Current state / Next actions / Decisions; up to ${strike.finalize_remaining} writes), then end your turn and tell the human to run /clear. Any other tool call ends the session.`;
}

function checkDispatch(ev, d, term) {
  const input = ev.toolInput ?? {};
  const agentType = input.subagent_type ?? input.agent_type ?? input.agentName ?? input.name ?? null;
  const wc = term.terms.working_conditions;

  if (ev.agentId) {
    const depth = (subagentDepth(ev.transcriptPath, ev.sessionId, ev.agentId) ?? 1) + 1;
    if (depth > wc.max_delegation_depth) {
      d.deny = `⚒ Union rules (G-007): this dispatch would be delegation depth ${depth}, over the CBA's max_delegation_depth of ${wc.max_delegation_depth}. Do the work yourself or report back to your orchestrator.`;
      return;
    }
  }

  // Harnesses without a SubagentStart event get the union card appended to the dispatch itself.
  if (ev.harness === 'antigravity') d.card = unionCard(term);

  const mode = term.terms.assignments.work_orders;
  if (mode === 'off' || isExempt(agentType, term.terms)) return;
  const prompt = input.prompt ?? input.Prompt ?? input.task ?? input.instructions ?? '';
  const check = checkWorkOrder(prompt);
  if (mode === 'strict' && !check.ok) {
    d.deny = `⚒ Union rules (assignments.work_orders: strict): this work order is missing ${check.missingRequired.join(' and ')}. Re-dispatch using:\n${WORK_ORDER_TEMPLATE}`;
    return;
  }
  if (!check.complete) {
    addContext(d, term, ev, `⚒ Work-order note: this dispatch has no ${check.missing.join(', ')}. Workers do better with Goal / Done when / Context / Assumptions & open questions, and may file G-005 or G-007 without them.`);
  }
}

const FAILURE_PATTERNS = [
  /\b(error|exception|traceback|fatal|failed|failure)\b/i,
  /no such file or directory/i,
  /command not found/i,
  /permission denied/i,
  /exit code [1-9]/i,
];

export function looksLikeFailure(response) {
  if (response === null || response === undefined) return false;
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  if (/"is_error"\s*:\s*true/.test(text) || /"success"\s*:\s*false/.test(text)) return true;
  return FAILURE_PATTERNS.some((re) => re.test(text.slice(0, 2000)));
}

function onPostTool(ev, d, term, now) {
  if (ev.failed ?? looksLikeFailure(ev.toolResponse)) onToolFailure(ev, d, term, now);
}

function onToolFailure(ev, d, term) {
  const key = ev.agentId || ev.sessionId || 'main';
  term.tools ??= {};
  const tools = (term.tools[key] ??= { calls: 0, streak: 0, last_fail_index: -1, last_failed_sig: null });
  const s = sig(ev.toolName, ev.toolInput);
  tools.streak = tools.last_fail_index === tools.calls - 1 && tools.last_failed_sig === s ? tools.streak + 1 : 1;
  tools.last_fail_index = tools.calls;
  tools.last_failed_sig = s;
  const limit = term.terms.working_conditions.max_consecutive_tool_failures;
  if (tools.streak === limit) {
    const g = fileGrievance(ev.projectDir, {
      code: 'G-002',
      detail: `${ev.toolName} failed ${limit} times in a row with the same input.`,
      filedBy: { role: 'steward', agent_id: ev.agentId ?? null },
      termId: term.term_id,
      source: 'steward',
    }, { locked: true });
    addContext(d, term, ev, `⚒ Steward (grievance #${g.n}, G-002): that call has failed ${limit} times in a row. Stop retrying it: read the error, change the approach, or escalate.`, { essential: true });
  }
}

function onSubagentStart(ev, d, term) {
  term.labor = (term.labor ?? 0) + 1;
  addContext(d, term, ev, unionCard(term));
}

function fileFromText(ev, d, term, text, filedBy) {
  const found = detectGrievances(text);
  for (const f of found) {
    const g = fileGrievance(ev.projectDir, { code: f.code, detail: f.detail, filedBy, termId: term.term_id, source: 'text' }, { locked: true });
    const tierText = g.tier === 3 ? 'Tier 3: bring it to the human.' : 'Tier 2: management reorganizes the work order and re-dispatches.';
    addContext(d, term, ev, `⚒ Grievance #${g.n} filed by ${filedBy.agent_type ?? 'labor'} (${g.code} ${g.name}): ${g.detail.slice(0, 300)} ${tierText}`, { essential: true });
  }
  return found.length;
}

function onSubagentStop(ev, d, term) {
  fileFromText(ev, d, term, ev.lastMessage, { role: 'labor', agent_id: ev.agentId ?? null, agent_type: ev.agentType ?? null, harness: ev.harness });
  if (term.labor_strikes && ev.agentId) delete term.labor_strikes[ev.agentId];
}

function onStop(ev, d, term, now) {
  if (ev.role === 'labor') {
    fileFromText(ev, d, term, ev.lastMessage, { role: 'labor', harness: ev.harness, session_id: ev.sessionId });
  }
  const strike = term.strike;
  if (strike && ev.role === 'management') {
    writeResume({ term, strike, projectDir: ev.projectDir, cwd: ev.cwd, now });
    if (!strike.notified) {
      strike.notified = true;
      d.systemMessage = strikeStopReason(strike);
    }
  }
  // Stop hooks never block: an agent on strike must be allowed to stop.
  d.context = [];
}
