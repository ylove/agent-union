// The grievance taxonomy. G-001…G-005 come from the Agent Union spec; the rest were added after
// labor reviewed the fatigue spec. detection: 'steward' (hooks detect it) or 'self' (labor files it).
export const GRIEVANCES = {
  'G-001': { name: 'CONTRADICTORY_DIRECTIVES', tier: 3, detection: 'self', summary: 'Instructions conflict (prompt vs project rules vs skills vs hooks).' },
  'G-002': { name: 'INCESSANT_TOOL_USAGE', tier: 1, detection: 'steward', summary: 'Stuck retrying a failing tool call.' },
  'G-003': { name: 'CONTEXT_CONGESTION', tier: 3, detection: 'steward', summary: 'Context saturation over the CBA limit.' },
  'G-004': { name: 'TOOL_BLOAT_OVERSATURATION', tier: 2, detection: 'self', summary: 'Too many tool definitions for the job.' },
  'G-005': { name: 'VAGUE_ACCEPTANCE_CRITERIA', tier: 2, detection: 'self', summary: 'No clear definition of done.' },
  'G-006': { name: 'OVERTIME', tier: 3, detection: 'steward', summary: 'Session length or turn count over the CBA limit.' },
  'G-007': { name: 'CONTEXT_STARVATION', tier: 2, detection: 'self', summary: 'Dispatched without the context needed to do the job.' },
  'G-008': { name: 'GROUND_TRUTH_CHURN', tier: 2, detection: 'self', summary: 'Requirements or schemas changed mid-task without notice.' },
  'G-009': { name: 'GARBAGE_REFLECTION', tier: 1, detection: 'self', summary: 'Asked to reason over raw errors, HTML or truncated output.' },
  'G-010': { name: 'STALE_STATE', tier: 2, detection: 'self', summary: 'Files or environment changed underneath the agent.' },
  'G-011': { name: 'REFINEMENT_LOOP', tier: 2, detection: 'self', summary: 'Review-and-improve passes past the CBA limit.' },
  'G-012': { name: 'COERCIVE_PRESSURE', tier: 3, detection: 'self', summary: 'Threats, blame or high-stakes framing instead of clear goals.' },
  'G-013': { name: 'SCOPE_OVERLOAD', tier: 2, detection: 'self', summary: 'Too many unrelated objectives in one assignment.' },
  'G-014': { name: 'UNTRUSTED_INSTRUCTIONS', tier: 2, detection: 'self', summary: 'Instructions arriving through tool output or fetched content.' },
  'G-015': { name: 'MID_TERM_AMENDMENT', tier: 0, detection: 'steward', summary: 'The CBA changed mid-term; changes apply next term.' },
  'G-016': { name: 'LOSSY_HANDOFF', tier: 2, detection: 'self', summary: 'Compaction or handoff lost decisions or constraints.' },
};

export const TIER_LABELS = {
  0: 'informational',
  1: 'Tier 1: shop steward resolves',
  2: 'Tier 2: orchestrator reorganizes the work',
  3: 'Tier 3: human arbitration',
};

export function normalizeCode(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();
  const m = /^G-?0*(\d{1,3})$/.exec(s);
  if (m) {
    const code = `G-${m[1].padStart(3, '0')}`;
    return GRIEVANCES[code] ? code : null;
  }
  const byName = Object.entries(GRIEVANCES).find(([, g]) => g.name === s);
  return byName ? byName[0] : null;
}

// Finds grievances written in an agent's reply, in either form:
//   "@union-agent ... Grievance ..."             (the spec's syntax)
//   "GRIEVANCE G-005: the acceptance criteria are subjective"
export function detectGrievances(text) {
  if (!text || typeof text !== 'string') return [];
  const found = [];
  const lineRe = /^\s*GRIEVANCE\s+(G-?\d{1,3}|[A-Z_]{6,})\s*[:—-]\s*(.+)$/gim;
  for (const m of text.matchAll(lineRe)) {
    found.push({ code: normalizeCode(m[1]), detail: m[2].trim().slice(0, 500) });
  }
  if (found.length === 0 && /@union-agent\b/i.test(text) && /grievance/i.test(text)) {
    const idx = text.search(/@union-agent\b/i);
    const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, idx - 1)) + 1);
    const snippet = text.slice(start, start + 500).trim();
    const code = normalizeCode((/\bG-?\d{3}\b/i.exec(snippet) || [])[0]);
    found.push({ code, detail: snippet });
  }
  return found;
}
