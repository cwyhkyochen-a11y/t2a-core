/**
 * StoredMessage[] → OpenAI-protocol messages converter.
 *
 * `system_event` rows are degraded to a `user` role with `[SYSTEM EVENT from <source>] ...`
 * prefix (DESIGN § 6 / decision plan A).
 *
 * @see DESIGN.md § 6 / Appendix B
 */

import type {
  AssistantMessage,
  MultiPart,
  OpenAIMessage,
  StoredMessage,
  SystemEventInjectionConfig,
  SystemEventMessage,
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

/**
 * Build the OpenAI-protocol message list for a single LLM call.
 *
 * - `assistant.content` is preserved as `null` when only `tool_calls` are present.
 * - `system_event` is degraded to a `user` message; if the template returns a
 *   `MultiPart[]`, we keep it as multi-modal user content.
 * - The injection prefix is always `[SYSTEM EVENT from ${source}]` (test-asserted exact match).
 */
export function buildLLMMessages(
  stored: readonly StoredMessage[],
  systemPrompt: string,
  injection: SystemEventInjectionConfig = { template: defaultSystemEventTemplate },
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
        out.push(buildAssistant(msg));
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

function buildAssistant(msg: AssistantMessage): OpenAIMessage {
  // Preserve content=null when only tool_calls present (DESIGN § 2.1 / OpenAI protocol).
  // T2: interrupted assistant messages are passed to LLM as-is (OpenAI allows partial).
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
