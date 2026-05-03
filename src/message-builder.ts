/**
 * StoredMessage[] → OpenAI-protocol messages converter.
 *
 * `system_event` rows are degraded to a `user` role with `[SYSTEM EVENT from <source>] ...`
 * prefix (DESIGN § 6 / decision plan A).
 *
 * Plan C adds optional timestamp injection and history tool_calls degradation.
 *
 * @see DESIGN.md § 6 / Appendix B
 */

import type {
  AssistantMessage,
  BuildLLMMessagesOptions,
  MultiPart,
  OpenAIMessage,
  StoredMessage,
  SystemEventInjectionConfig,
  SystemEventMessage,
  ToolCall,
} from './types.js';

/**
 * Default `system_event` injection template.
 *
 * @see DESIGN.md § 6.1
 */
export function defaultSystemEventTemplate(e: SystemEventMessage): string {
  const lines = [
    `[SYSTEM EVENT from ${e.source}]`,
    '这是系统主动告知的事实，不是用户输入。请以助手身份组织一段简短回应。',
    `payload: ${safeStringify(e.payload)}`,
  ];
  if (e.defaultResponse) lines.push(`default_response: ${e.defaultResponse}`);
  return lines.join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ─── Timestamp helpers ───────────────────────────────────────────────────────

function formatTimestamp(createdAt: number, offsetMinutes: number): string {
  // Determine if ms or seconds (threshold: 10 billion → ms)
  const ms = createdAt > 1e10 ? createdAt : createdAt * 1000;
  const localMs = ms + offsetMinutes * 60_000;
  const d = new Date(localMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function prependTimestamp(
  content: string | readonly MultiPart[] | null,
  ts: string,
): string | MultiPart[] {
  if (content === null) return `${ts} `;
  if (typeof content === 'string') return `${ts} ${content}`;
  // MultiPart array — prepend to first text part
  const parts = (content as readonly MultiPart[]).map((p, i) => {
    if (i === 0 && p.type === 'text') {
      return { type: 'text' as const, text: `${ts} ${p.text}` };
    }
    return { ...p };
  });
  return parts as MultiPart[];
}

// ─── Degradation helpers ─────────────────────────────────────────────────────

function degradeToolCalls(toolCalls: readonly ToolCall[]): string {
  return toolCalls
    .map((tc) => `[called ${tc.function.name}(${truncate(tc.function.arguments, 200)})]`)
    .join('\n');
}

function degradeAssistant(msg: AssistantMessage, ts: string): OpenAIMessage {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    parts.push(degradeToolCalls(msg.toolCalls));
  }
  let text = parts.join('\n');
  if (msg.interrupted) text += '（已中断）';
  return { role: 'assistant', content: `${ts} ${text}` };
}

function degradeToolResult(
  toolCallId: string,
  content: string,
  ts: string,
  toolCallMap: Map<string, string>,
): OpenAIMessage {
  const name = toolCallMap.get(toolCallId) ?? 'unknown';
  return {
    role: 'user',
    content: `${ts} [system: tool ${name} returned] ${truncate(content, 300)}`,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Build the OpenAI-protocol message list for a single LLM call.
 */
export function buildLLMMessages(
  stored: readonly StoredMessage[],
  systemPrompt: string,
  injection: SystemEventInjectionConfig = { template: defaultSystemEventTemplate },
  options?: BuildLLMMessagesOptions,
): OpenAIMessage[] {
  const degrade = options?.degradeHistoryTools ?? false;

  if (!degrade) {
    return buildLegacy(stored, systemPrompt, injection);
  }

  const offsetMin = options?.timezoneOffsetMinutes ?? 480;

  // Find boundary: last user or system_event index in stored
  let boundary = -1;
  for (let i = stored.length - 1; i >= 0; i--) {
    const r = stored[i]!;
    if (r.role === 'user' || r.role === 'system_event') {
      boundary = i;
      break;
    }
  }

  // Build toolCallId → name map for history region
  const toolCallMap = new Map<string, string>();
  for (let i = 0; i < boundary; i++) {
    const m = stored[i]!;
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) {
        toolCallMap.set(tc.id, tc.function.name);
      }
    }
  }

  const out: OpenAIMessage[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }

  for (let i = 0; i < stored.length; i++) {
    const msg = stored[i]!;
    const ts = formatTimestamp(msg.createdAt, offsetMin);
    const isHistory = i < boundary;

    switch (msg.role) {
      case 'user': {
        const content = prependTimestamp(msg.content, ts);
        out.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        if (isHistory && msg.toolCalls && msg.toolCalls.length > 0) {
          out.push(degradeAssistant(msg, ts));
        } else if (msg.toolCalls && msg.toolCalls.length > 0) {
          // Current round — keep native, only add ts to text content
          out.push({
            role: 'assistant',
            content: msg.content ? `${ts} ${msg.content}` : msg.content,
            tool_calls: msg.toolCalls,
          });
        } else {
          // Pure text assistant
          out.push({
            role: 'assistant',
            content: msg.content ? `${ts} ${msg.content}` : msg.content,
          });
        }
        break;
      }
      case 'tool': {
        if (isHistory) {
          out.push(degradeToolResult(msg.toolCallId, msg.content, ts, toolCallMap));
        } else {
          // Current round — keep native
          out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
        }
        break;
      }
      case 'system_event': {
        const rendered = injection.template(msg);
        const content = prependTimestamp(
          typeof rendered === 'string' ? rendered : rendered,
          ts,
        );
        out.push({ role: 'user', content });
        break;
      }
    }
  }

  return out;
}

// ─── Legacy (non-degraded) path ──────────────────────────────────────────────

function buildLegacy(
  stored: readonly StoredMessage[],
  systemPrompt: string,
  injection: SystemEventInjectionConfig,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of stored) {
    switch (msg.role) {
      case 'user':
        out.push({ role: 'user', content: msg.content });
        break;
      case 'assistant':
        out.push(buildAssistantLegacy(msg));
        break;
      case 'tool':
        out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
        break;
      case 'system_event': {
        const rendered = injection.template(msg);
        const content: string | readonly MultiPart[] =
          typeof rendered === 'string' ? rendered : rendered;
        out.push({ role: 'user', content });
        break;
      }
    }
  }
  return out;
}

function buildAssistantLegacy(msg: AssistantMessage): OpenAIMessage {
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: msg.content,
      tool_calls: msg.toolCalls,
    };
  }
  return {
    role: 'assistant',
    content: msg.content,
  };
}
