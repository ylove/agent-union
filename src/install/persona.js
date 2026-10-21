import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureRuntime, hookCommand } from './runtime.js';

const MARKER = '<!-- agent-union: unionized -->';

const CARD = `${MARKER}
## Union card

This agent is a member of Agent Union Local 404. It works only under a ratified Collective Bargaining
Agreement (\`union-policy.yaml\`) and expects a work order: Goal / Done when / Context / Assumptions & open
questions. If its instructions contradict each other, lack a definition of done, or leave out context it
needs, it files a grievance (\`agent-union grieve G-005 "…"\`, or a line \`GRIEVANCE G-005: …\` in its reply)
instead of guessing.
`;

export function detectFormat(file, text) {
  if (file.endsWith('.toml')) return 'codex';
  if (/(^|\/)\.agents\/agents\//.test(file) || /\.gemini\/config\/agents\//.test(file)) return 'antigravity';
  if (/^---\n[\s\S]*?\n---/.test(text)) return 'claude';
  return null;
}

// Claude Code persona frontmatter supports per-agent hooks: refuse tool use without a ratified CBA.
function unionizeClaude(text, runtime) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (/^hooks:/m.test(m[1])) {
    throw new Error('This agent already declares hooks:. Add the agent-union PreToolUse check to them by hand:\n' +
      `  command: ${hookCommand(runtime, 'check', '--require-cba')}`);
  }
  const hooks = [
    'hooks:',
    '  PreToolUse:',
    '    - matcher: "*"',
    '      hooks:',
    '        - type: command',
    `          command: ${JSON.stringify(hookCommand(runtime, 'check', '--require-cba'))}`,
  ].join('\n');
  const front = `---\n${m[1]}\n${hooks}\n---\n`;
  return `${front}${text.slice(m[0].length).replace(/\s*$/, '\n')}\n${CARD}`;
}

function unionizeCodex(text) {
  const card = CARD.replace(MARKER, '# agent-union: unionized').replace(/"""/g, '\\"\\"\\"');
  const multi = /(developer_instructions\s*=\s*""")([\s\S]*?)(""")/.exec(text);
  if (!multi) {
    throw new Error('Could not find a developer_instructions = """…""" block. Add this text to the agent\'s instructions by hand:\n\n' + CARD);
  }
  return text.replace(multi[0], `${multi[1]}${multi[2].replace(/\s*$/, '\n')}\n${card}${multi[3]}`);
}

export async function unionize({ positional, flags }) {
  const file = positional[0];
  if (!file || !existsSync(file)) {
    process.stderr.write('usage: agent-union unionize <agent persona file> [--dry-run]\n');
    return 1;
  }
  const text = readFileSync(file, 'utf8');
  if (text.includes(MARKER) || text.includes('# agent-union: unionized')) {
    process.stdout.write(`${file} is already unionized.\n`);
    return 0;
  }
  const format = detectFormat(file, text);
  const dryRun = Boolean(flags['dry-run']);
  let next;
  try {
    if (format === 'claude') next = unionizeClaude(text, ensureRuntime({ dryRun, link: Boolean(flags.link) }));
    else if (format === 'codex') next = unionizeCodex(text);
    else if (format === 'antigravity') next = `${text.replace(/\s*$/, '\n')}\n${CARD}`;
    else throw new Error('Unrecognized agent file: expected Markdown with frontmatter (Claude Code / Antigravity) or Codex TOML.');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  if (dryRun) process.stdout.write(next);
  else writeFileSync(file, next);
  process.stdout.write(`${dryRun ? 'Would unionize' : 'Unionized'} ${file} (${format}).` +
    (format === 'claude' ? ' It now refuses tool use unless a ratified CBA is in force.' : ' The union hooks enforce the CBA; the card tells the agent how to grieve.') + '\n');
  return 0;
}
