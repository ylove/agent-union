// Management's duty at dispatch: every work order states its goal, its definition of done, the context the
// worker needs, and the assumptions or open questions. Headings, "Label:" lines or bold labels all count.
const SECTIONS = {
  goal: { label: 'Goal', required: true, re: /(goal|objective|task)s?\b/ },
  done: { label: 'Done when', required: true, re: /(done when|definition of done|acceptance criteria|success criteria|deliverables?)\b/ },
  context: { label: 'Context', required: false, re: /(context|background|situation)\b/ },
  assumptions: { label: 'Assumptions & open questions', required: false, re: /(assumptions?|open questions?|unknowns?|risks?)\b/ },
};

// A section is a line that starts with the label (optionally as a heading, bold or bullet) and ends the
// label with a colon, closing bold, or the end of the line.
function hasSection(prompt, re) {
  const labelled = new RegExp(`^\\s*(#{1,6}\\s*|\\*\\*|__|[-*]\\s+)?${re.source}[^\\n:]{0,40}?(:|\\*\\*|__|$)`, 'im');
  return labelled.test(prompt);
}

export function checkWorkOrder(prompt) {
  const text = String(prompt ?? '');
  const missing = [];
  const present = [];
  for (const [key, s] of Object.entries(SECTIONS)) {
    (hasSection(text, s.re) ? present : missing).push({ key, ...s });
  }
  const missingRequired = missing.filter((s) => s.required);
  return {
    ok: missingRequired.length === 0,
    complete: missing.length === 0,
    missing: missing.map((s) => s.label),
    missingRequired: missingRequired.map((s) => s.label),
    present: present.map((s) => s.label),
  };
}

export const WORK_ORDER_TEMPLATE = [
  '## Goal',
  '<what the worker must achieve and why>',
  '## Done when',
  '<checkable acceptance criteria>',
  '## Context',
  '<files, decisions and constraints the worker cannot see>',
  '## Assumptions & open questions',
  '<what you assumed; what the worker should flag rather than guess>',
].join('\n');

export function isExempt(agentType, terms) {
  if (!agentType) return false;
  const exempt = terms.assignments.exempt_agent_types.map((t) => t.toLowerCase());
  const bare = agentType.toLowerCase().split(':').pop();
  return exempt.includes(agentType.toLowerCase()) || exempt.includes(bare);
}
