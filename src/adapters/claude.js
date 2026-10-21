import { findProjectDir } from '../state.js';

const KINDS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  PostToolUseFailure: 'post-tool-failure',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
};

// Events whose hookSpecificOutput accepts additionalContext.
const CONTEXT_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop',
]);

export function normalize(payload, eventName, env = process.env) {
  const event = payload.hook_event_name || eventName;
  const cwd = payload.cwd || process.cwd();
  return {
    harness: 'claude',
    event,
    kind: KINDS[event] ?? 'other',
    sessionId: payload.session_id ?? null,
    cwd,
    projectDir: env.CLAUDE_PROJECT_DIR || findProjectDir(cwd),
    transcriptPath: payload.transcript_path ?? null,
    agentId: payload.agent_id ?? null,
    agentType: payload.agent_type ?? null,
    role: payload.agent_id || env.AGENT_UNION_ROLE === 'labor' ? 'labor' : 'management',
    source: payload.source ?? null,
    prompt: payload.prompt ?? null,
    toolName: payload.tool_name ?? null,
    toolInput: payload.tool_input ?? null,
    toolResponse: payload.tool_response ?? null,
    failed: event === 'PostToolUseFailure' ? true : event === 'PostToolUse' ? false : undefined,
    lastMessage: payload.last_assistant_message ?? null,
    stopHookActive: Boolean(payload.stop_hook_active),
    model: payload.model ?? null,
    envFile: event === 'SessionStart' ? env.CLAUDE_ENV_FILE ?? null : null,
  };
}

export function render(decision, eventName) {
  const out = {};
  const specific = { hookEventName: eventName };
  const context = decision.context.join('\n\n');

  if (decision.stop) {
    out.continue = false;
    out.stopReason = decision.stop;
    if (eventName === 'PreToolUse') {
      specific.permissionDecision = 'deny';
      specific.permissionDecisionReason = decision.stop;
    }
  }
  if (decision.deny && eventName === 'PreToolUse') {
    specific.permissionDecision = 'deny';
    specific.permissionDecisionReason = decision.deny;
  }
  if (decision.block && eventName === 'UserPromptSubmit') {
    out.decision = 'block';
    out.reason = decision.block;
  }
  if (context && CONTEXT_EVENTS.has(eventName) && !out.decision) specific.additionalContext = context;
  if (decision.systemMessage) out.systemMessage = decision.systemMessage;
  if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific;
  return Object.keys(out).length ? JSON.stringify(out) : '';
}
