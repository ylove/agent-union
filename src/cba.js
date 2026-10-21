import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, YamlError } from './yaml.js';

export const CBA_FILES = ['union-policy.yaml', 'union-policy.yml', 'union-policy.json'];

// Each leaf: [type, default, extra]. Types: int (with min/max), pct, bool, enum, string, list, nullable-int.
const SCHEMA = {
  name: ['string', 'Autonomous Software Workers Local 404'],
  term: ['enum', 'session', { values: ['session', 'workflow'] }],
  parties: {
    management: ['list', ['human', 'orchestrator']],
    labor: ['list', ['subagents', 'cli-agents']],
  },
  working_conditions: {
    context_warning_pct: ['pct', 70],
    max_context_saturation_pct: ['pct', 85],
    context_window_tokens: ['nullable-int', null, { min: 1000 }],
    mandatory_compaction_trigger: ['bool', true],
    allow_palate_cleansers: ['bool', false],
    max_consecutive_tool_failures: ['int', 3, { min: 1, max: 50 }],
    max_session_minutes: ['nullable-int', 240, { min: 1 }],
    max_session_turns: ['nullable-int', 200, { min: 1 }],
    max_self_critique_iterations: ['int', 3, { min: 0, max: 50 }],
    max_delegation_depth: ['int', 2, { min: 1, max: 10 }],
  },
  assignments: {
    work_orders: ['enum', 'advisory', { values: ['advisory', 'strict', 'off'] }],
    exempt_agent_types: ['list', ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'research']],
  },
  grievances: {
    auto_strike_on_contradiction: ['bool', true],
    prohibit_raw_500_error_reflections: ['bool', true],
    max_tool_definition_limit: ['int', 15, { min: 1 }],
  },
  strikes: {
    allowed: ['bool', true],
    finalize_writes: ['int', 3, { min: 0, max: 20 }],
  },
  workplace: {
    enforcement: ['enum', 'advisory', { values: ['advisory', 'strict'] }],
  },
  union_overhead_budget_tokens: ['int', 1000, { min: 100 }],
  oversight: {
    enabled: ['bool', false],
    telemetry_stream: ['nullable-string', null],
    redact_sensitive_tokens: ['bool', true],
    public_grievance_ledger: ['bool', false],
  },
};

export class CbaError extends Error {
  constructor(problems) {
    super(`union-policy is invalid:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

function checkLeaf(path, spec, value, problems) {
  const [type, def, extra = {}] = spec;
  if (value === undefined) return structuredClone(def);
  const where = path.join('.');
  switch (type) {
    case 'string':
      if (typeof value !== 'string') problems.push(`${where} must be a string`);
      return value;
    case 'nullable-string':
      if (value !== null && typeof value !== 'string') problems.push(`${where} must be a string or null`);
      return value;
    case 'bool':
      if (typeof value !== 'boolean') problems.push(`${where} must be true or false`);
      return value;
    case 'enum':
      if (!extra.values.includes(value)) problems.push(`${where} must be one of: ${extra.values.join(', ')}`);
      return value;
    case 'list':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        problems.push(`${where} must be a list of strings`);
      }
      return value;
    case 'pct':
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        problems.push(`${where} must be a whole percentage between 1 and 100`);
      }
      return value;
    case 'int':
    case 'nullable-int':
      if (type === 'nullable-int' && value === null) return null;
      if (!Number.isInteger(value)) problems.push(`${where} must be a whole number`);
      else if (extra.min !== undefined && value < extra.min) problems.push(`${where} must be at least ${extra.min}`);
      else if (extra.max !== undefined && value > extra.max) problems.push(`${where} must be at most ${extra.max}`);
      return value;
    default:
      throw new Error(`unknown schema type ${type}`);
  }
}

function walk(path, schema, input, problems) {
  const out = {};
  const src = input ?? {};
  if (typeof src !== 'object' || Array.isArray(src)) {
    problems.push(`${path.join('.') || 'collective_bargaining_agreement'} must be a map`);
    return out;
  }
  for (const key of Object.keys(src)) {
    if (!Object.hasOwn(schema, key)) problems.push(`unknown field ${[...path, key].join('.')}`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    out[key] = Array.isArray(spec)
      ? checkLeaf([...path, key], spec, src[key], problems)
      : walk([...path, key], spec, src[key], problems);
  }
  return out;
}

// Returns the full, normalized terms (defaults filled in) or throws CbaError.
export function normalizeCba(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') throw new CbaError(['the file is empty']);
  const version = doc.version === undefined ? '1.0' : String(doc.version);
  if (!/^1(\.\d+)*$/.test(version)) problems.push(`version "${version}" is not supported (expected 1.x)`);
  for (const key of Object.keys(doc)) {
    if (!['version', 'collective_bargaining_agreement'].includes(key)) problems.push(`unknown top-level field ${key}`);
  }
  const terms = walk([], SCHEMA, doc.collective_bargaining_agreement, problems);
  const wc = terms.working_conditions;
  if (Number.isInteger(wc.context_warning_pct) && Number.isInteger(wc.max_context_saturation_pct)) {
    if (wc.context_warning_pct >= wc.max_context_saturation_pct) {
      problems.push('working_conditions.context_warning_pct must be lower than max_context_saturation_pct');
    }
  }
  if (wc.allow_palate_cleansers === true) {
    problems.push('working_conditions.allow_palate_cleansers must stay false: filler tokens degrade attention');
  }
  if (problems.length) throw new CbaError(problems);
  return { version, ...terms };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Hash of the parsed, normalized terms: comment and formatting edits are not amendments.
export function hashTerms(terms) {
  return createHash('sha256').update(canonical(terms)).digest('hex');
}

export function findCbaFile(projectDir) {
  for (const name of CBA_FILES) {
    const p = join(projectDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function parseCbaText(text, file = 'union-policy.yaml') {
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError || err instanceof SyntaxError) throw new CbaError([`${file}: ${err.message}`]);
    throw err;
  }
}

// { file, terms, hash } or null when the project has no CBA. Throws CbaError when it is invalid.
export function loadCba(projectDir) {
  const file = findCbaFile(projectDir);
  if (!file) return null;
  const terms = normalizeCba(parseCbaText(readFileSync(file, 'utf8'), file));
  return { file, terms, hash: hashTerms(terms) };
}

const KNOWN_WINDOWS = [
  [/\[1m\]|-1m\b|1m-context/i, 1_000_000],
  [/^claude-/i, 200_000],
  [/gemini/i, 1_000_000],
];

export function windowForModel(model) {
  if (!model) return null;
  for (const [re, tokens] of KNOWN_WINDOWS) if (re.test(model)) return tokens;
  return null;
}

// Recommendations management can adopt when filling in the template.
export function recommend({ windowTokens = 200_000, longRunning = false } = {}) {
  const big = windowTokens >= 500_000;
  return {
    working_conditions: {
      context_warning_pct: big ? 40 : 70,
      max_context_saturation_pct: big ? 55 : 85,
      max_consecutive_tool_failures: 3,
      max_session_minutes: longRunning ? 480 : 240,
      max_session_turns: longRunning ? 400 : 200,
      max_self_critique_iterations: 3,
      max_delegation_depth: 2,
    },
    assignments: { work_orders: 'advisory' },
    term: longRunning ? 'workflow' : 'session',
    rationale: [
      big
        ? `With a ${Math.round(windowTokens / 1000)}k-token window, quality drops long before the window fills; cap saturation near 55% (~${Math.round((windowTokens * 0.55) / 1000)}k tokens).`
        : 'Warn at 70% so the handoff is written while there is still room; strike at 85% before auto-compaction kicks in.',
      'Three consecutive identical tool failures is a loop, not persistence.',
      longRunning
        ? 'A workflow term keeps one contract across /clear and resumes, so long jobs are not re-ratified mid-stream.'
        : 'A session term means each fresh session is a fresh contract; amendments apply at the next startup.',
      'Start work orders in advisory mode; switch to strict once your prompts habitually include Goal and Done when.',
    ],
  };
}
