/**
 * Tool registry.
 *
 * @see DESIGN.md § 2.4 / § 3.4 / decision 5 (`tool_*` emit prefix enforcement)
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolEventName,
  ToolRegistryLike,
  ToolResult,
  ToolSchema,
} from './types.js';

/**
 * Validate that `eventName` follows the `tool_*` namespace contract.
 *
 * Decision 5 (2026-05-02): SDK never silently auto-prefixes; violations throw.
 */
export function assertToolEventName(eventName: string): asserts eventName is ToolEventName {
  if (typeof eventName !== 'string' || !eventName.startsWith('tool_') || eventName.length <= 5) {
    throw new TypeError(
      `[t2a-core] custom tool event name must start with "tool_" and be non-empty, got "${eventName}". ` +
        `See DESIGN.md decision 5.`,
    );
  }
}

/**
 * In-memory tool registry. Cheap enough that even a pathological agent loop
 * with hundreds of tools still resolves in O(1).
 */
export class ToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   */
  register(def: ToolDefinition): void {
    if (!def?.schema?.name) {
      throw new TypeError('[t2a-core] ToolDefinition.schema.name is required');
    }
    if (typeof def.handler !== 'function') {
      throw new TypeError('[t2a-core] ToolDefinition.handler must be a function');
    }
    if (this.tools.has(def.schema.name)) {
      throw new Error(`[t2a-core] tool "${def.schema.name}" is already registered`);
    }
    this.tools.set(def.schema.name, def);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Returns the OpenAI `tools` array shape. Empty array if no tools registered.
   *
   * @see DESIGN.md § 10
   */
  toOpenAITools(): Array<{ readonly type: 'function'; readonly function: ToolSchema }> {
    return this.list().map((d) => ({ type: 'function' as const, function: d.schema }));
  }

  /**
   * Invoke a registered handler. Handler-thrown exceptions are caught and
   * surfaced as `ToolResult { ok: false, error }` so the agent loop can keep
   * going (DESIGN § 9.2).
   *
   * Unknown tool names produce a non-throwing `{ ok: false }` so the LLM can
   * self-correct on the next loop iteration.
   */
  async invoke(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return { ok: false, error: `unknown tool: ${name}` };
    }
    try {
      const result = await def.handler(args, ctx);
      return result;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
