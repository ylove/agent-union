import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntime, hookCommand, readJsonFile, writeJsonFile } from './runtime.js';

function claude(args, { dryRun }) {
  const line = `claude ${args.join(' ')}`;
  if (dryRun) return { line, ok: true, output: '(dry run)' };
  const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 120_000 });
  if (r.error?.code === 'ENOENT') return { line, ok: false, output: 'the `claude` command was not found' };
  return { line, ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

// Claude Code gets the real plugin from this repo's marketplace; nothing is copied by hand.
export function installClaude({ project = null, dryRun = false, statusline = false, link = false }) {
  const scope = project ? 'project' : 'user';
  const steps = [
    claude(['plugin', 'marketplace', 'add', 'ylove/agent-union', '--scope', scope], { dryRun }),
    claude(['plugin', 'install', 'agent-union@agent-union', '--scope', scope], { dryRun }),
  ];
  const notes = [];
  const files = [];
  if (statusline) {
    const runtime = ensureRuntime({ dryRun, link });
    const settingsFile = join(homedir(), '.claude', 'settings.json');
    const settings = readJsonFile(settingsFile);
    if (settings.statusLine) {
      notes.push(`You already have a statusLine (${JSON.stringify(settings.statusLine.command ?? settings.statusLine)}). To give the steward exact context readings, call \`agent-union statusline\` from it.`);
    } else {
      settings.statusLine = { type: 'command', command: hookCommand(runtime, 'statusline'), padding: 0 };
      writeJsonFile(settingsFile, settings, { dryRun });
      files.push(settingsFile);
      notes.push('Status line set: the steward now gets exact context percentages.');
    }
  } else {
    notes.push('Optional: `agent-union install claude --statusline` gives the steward exact context readings.');
  }
  notes.push('Restart Claude Code (or run /reload-plugins) to load the union hooks.');
  return { harness: 'claude', steps, files, notes };
}
