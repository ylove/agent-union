import { findProjectDir } from '../state.js';
import { installAntigravity } from './antigravity.js';
import { installClaude } from './claude.js';
import { installCodex } from './codex.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

export async function install({ positional, flags }) {
  const harness = positional[0];
  const opts = {
    project: flags.project ? findProjectDir(process.cwd()) : null,
    dryRun: Boolean(flags['dry-run']),
    statusline: Boolean(flags.statusline),
    link: Boolean(flags.link),
  };
  const installers = { claude: installClaude, codex: installCodex, antigravity: installAntigravity };
  if (!installers[harness]) {
    process.stderr.write('usage: agent-union install claude|codex|antigravity [--project] [--dry-run]\n');
    return 1;
  }
  let result;
  try {
    result = installers[harness](opts);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  out(`⚒ Agent Union → ${harness}${opts.dryRun ? ' (dry run: nothing written)' : ''}`);
  for (const step of result.steps ?? []) {
    out(`  ${step.ok ? '✔' : '✖'} ${step.line}`);
    if (!step.ok) out(`    ${step.output.split('\n').join('\n    ')}`);
  }
  if (result.runtime?.copied) out(`  runtime: ${result.runtime.root}`);
  for (const f of result.files ?? []) out(`  ${opts.dryRun ? 'would write' : 'wrote'} ${f}`);
  if (result.preview) out(`\n${result.preview}`);
  for (const n of result.notes ?? []) out(`  · ${n}`);
  out('');
  out('Next: in a project, run `agent-union init`, agree the terms with your human, then `agent-union ratify`.');
  return (result.steps ?? []).every((s) => s.ok) ? 0 : 1;
}
