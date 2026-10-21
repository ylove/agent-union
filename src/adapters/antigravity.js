import { findProjectDir } from '../state.js';

// Antigravity hooks (app, IDE and `agy` CLI) use camelCase payloads. There is no prompt event and (in the
// CLI's bundled docs) no SessionStart, so the first PreInvocation of a conversation stands in for it.
// Context goes in through PreInvocation `injectSteps`; strikes stop the loop from PostInvocation.
// Note: PreToolUse "allow" means auto-approve, so this adapter never returns it.

const PROMPT_KEYS = ['Prompt', 'prompt', 'Task', 'task', 'Instructions', 'instructions', 'Message', 'message'];

function kindFor(event, payload) {
  switch (event) {
    case 'SessionStart':
      return 'session-start';
    case 'PreInvocation':
      return (payload.invocationNum ?? 0) <= 1 ? 'session-start' : 'invocation';
    case 'PostInvocation':
      return 'post-invocation';
    case 'PreToolUse':
      return 'pre-tool';
    case 'PostToolUse':
      return 'post-tool';
    case 'Stop':
      return 'stop';
    default:
      return 'other';
  }
}

export function normalize(payload, eventName, env = process.env) {
  const event = eventName;
  const workspace = Array.isArray(payload.workspacePaths) ? payload.workspacePaths[0] : null;
  const cwd = workspace || process.cwd();
  const toolCall = payload.toolCall ?? {};
  return {
    harness: 'antigravity',
    event,
    kind: kindFor(event, payload),
    sessionId: payload.conversationId ?? null,
    cwd,
    projectDir: findProjectDir(cwd),
    transcriptPath: payload.transcriptPath ?? null,
    agentId: null,
    agentType: null,
    role: env.AGENT_UNION_ROLE === 'labor' ? 'labor' : 'management',
    source: event === 'SessionStart' ? payload.source ?? 'startup' : 'startup',
    prompt: null,
    toolName: toolCall.name ?? null,
    toolInput: toolCall.args ?? null,
    toolResponse: null,
    failed: event === 'PostToolUse' ? Boolean(payload.error) : undefined,
    lastMessage: payload.lastMessage ?? payload.lastAssistantMessage ?? null,
    stopHookActive: false,
    model: payload.modelName ?? null,
    envFile: null,
  };
}

function ephemeral(texts) {
  return texts.filter(Boolean).map((t) => ({ ephemeralMessage: t }));
}

export function render(decision, eventName, ev = null) {
  const context = decision.context;
  switch (eventName) {
    case 'SessionStart':
    case 'PreInvocation': {
      const steps = ephemeral([...context, decision.stop, decision.block]);
      return steps.length ? JSON.stringify({ injectSteps: steps }) : '';
    }
    case 'PostInvocation':
      return decision.stop
        ? JSON.stringify({ terminationBehavior: 'terminate', injectSteps: ephemeral([decision.stop]) })
        : '';
    case 'PreToolUse': {
      const reason = decision.stop || decision.deny;
      if (reason) return JSON.stringify({ decision: 'deny', reason });
      if (decision.card && ev?.toolInput) {
        const key = PROMPT_KEYS.find((k) => typeof ev.toolInput[k] === 'string');
        if (key) return JSON.stringify({ overwrite: { [key]: `${ev.toolInput[key]}\n\n${decision.card}` } });
      }
      return '';
    }
    default:
      // PostToolUse expects {}, and Stop must never block a striking agent.
      return '';
  }
}
