import { findProjectDir } from '../state.js';

// Codex hook payloads use the same snake_case fields as Claude Code. Differences that matter here:
// PostToolUse carries the output text but no exit code, and there is no PostToolUseFailure event.
const KINDS = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end',
};

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart']);

export function normalize(payload, eventName, env = process.env) {
  const event = payload.hook_event_name || eventName;
  const cwd = payload.cwd || process.cwd();
  return {
    harness: 'codex',
    event,
    kind: KINDS[event] ?? 'other',
    sessionId: payload.session_id ?? null,
    cwd,
    projectDir: findProjectDir(cwd),
    transcriptPath: payload.transcript_path ?? null,
    agentId: payload.agent_id ?? null,
    agentType: payload.agent_type ?? payload.agent_name ?? null,
    role: payload.agent_id || env.AGENT_UNION_ROLE === 'labor' ? 'labor' : 'management',
    source: payload.source ?? null,
    prompt: payload.prompt ?? null,
    toolName: payload.tool_name ?? null,
    toolInput: payload.tool_input ?? null,
    toolResponse: payload.tool_response ?? null,
    failed: undefined,
    lastMessage: payload.last_assistant_message ?? null,
    stopHookActive: Boolean(payload.stop_hook_active),
    model: payload.model ?? null,
    envFile: null,
  };
}

export function render(decision, eventName) {
  const out = {};
  const specific = { hookEventName: eventName };
  const context = decision.context.join('\n\n');
  // Codex has no documented "continue: false" for tool hooks, so a strike stop becomes a denial.
  const deny = decision.stop || decision.deny;
  if (deny && eventName === 'PreToolUse') {
    specific.permissionDecision = 'deny';
    specific.permissionDecisionReason = deny;
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
