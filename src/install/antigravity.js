import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';
import { copySkills, ensureRuntime, hookCommand, readJsonFile, writeJsonFile } from './runtime.js';

export const RULE = `---
trigger: always_on
---
# Agent Union Local 404

If this workspace has a ratified union-policy.yaml (a Collective Bargaining Agreement), it is a union job.
- Talking to the human, you are management: before dispatching subagents, check the request for ambiguity,
  contradictions and a missing definition of done, and settle those with the human. Dispatch with
  Goal / Done when / Context / Assumptions & open questions.
- Dispatched as a subagent, you are labor: if instructions contradict each other, lack a definition of done,
  or leave out context you need, file a grievance (\`agent-union grieve G-005 "…"\`, or a line
  \`GRIEVANCE G-005: …\` in your reply) instead of guessing.
- When the steward warns about context, keep .agent-union/handoff.md current. After a strike, run
  \`agent-union resume\`.
`;

// One named hook ("agent-union") holds all our handlers; other named hooks in the file are untouched.
export function hookSpec(runtime) {
  const cmd = (event) => ({ type: 'command', command: hookCommand(runtime, 'hook', 'antigravity', event), timeout: 10 });
  return {
    enabled: true,
    PreInvocation: [cmd('PreInvocation')],
    PostInvocation: [cmd('PostInvocation')],
    PreToolUse: [{ matcher: '*', hooks: [cmd('PreToolUse')] }],
    PostToolUse: [{ matcher: '*', hooks: [cmd('PostToolUse')] }],
    Stop: [cmd('Stop')],
  };
}

function stewardAgent() {
  const md = readFileSync(join(PACKAGE_ROOT, 'agents', 'shop-steward.md'), 'utf8');
  // Antigravity agent frontmatter: tools are listed per-product, so let the agent inherit them.
  return md.replace(/^---[\s\S]*?---\n/, `---\nname: shop-steward\ndescription: Agent Union shop steward. Triages grievances against the CBA, drafts handoffs, and proposes how management should reorganize the work.\nmodel: inherit\n---\n`);
}

export function installAntigravity({ project = null, dryRun = false, link = false }) {
  const runtime = ensureRuntime({ dryRun, link });
  const root = project ? join(project, '.agents') : join(homedir(), '.gemini', 'config');
  const hooksFile = join(root, 'hooks.json');
  const ruleFile = join(root, 'rules', 'agent-union.md');
  const agentFile = join(root, 'agents', 'shop-steward.md');

  const hooks = readJsonFile(hooksFile);
  hooks['agent-union'] = hookSpec(runtime);
  const preview = writeJsonFile(hooksFile, hooks, { dryRun });
  const skills = copySkills(join(root, 'skills'), { dryRun });
  if (!dryRun) {
    mkdirSync(join(root, 'rules'), { recursive: true });
    writeFileSync(ruleFile, RULE);
    mkdirSync(join(root, 'agents'), { recursive: true });
    if (!existsSync(agentFile) || readFileSync(agentFile, 'utf8').includes('Agent Union shop steward')) writeFileSync(agentFile, stewardAgent());
  }
  return {
    harness: 'antigravity',
    runtime,
    files: [hooksFile, ruleFile, ...skills, agentFile],
    preview: dryRun ? preview : null,
    notes: [
      'Antigravity reports no token counts to hooks, so context readings are estimated from the transcript size.',
      'For an exact reading in the agy CLI, set "statusLine": {"type": "command", "command": "agent-union statusline"} in ~/.gemini/antigravity-cli/settings.json.',
    ],
  };
}
