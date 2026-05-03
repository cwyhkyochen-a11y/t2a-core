/**
 * @t2a/core public entry point.
 *
 * @packageDocumentation
 */

export * from './types.js';
export { EventBus } from './event-bus.js';
export { ToolRegistry, assertToolEventName } from './tool-registry.js';
export { buildLLMMessages, defaultSystemEventTemplate } from './message-builder.js';
export type { BuildLLMMessagesOptions } from './types.js';
export { DefaultInterludeProvider } from './interlude-provider.js';
export { AgentLoop } from './agent-loop.js';
export type { AgentLoopContext } from './agent-loop.js';
export { Session } from './session.js';
export { OpenAILLMClient } from './llm-openai.js';
export type { OpenAILLMClientOptions } from './llm-openai.js';
export { SQLiteStorage, defaultTokenCounter } from './storage-sqlite.js';
export type {
  SQLiteStorageOptions,
  TokenCounter,
  BetterSqliteDatabaseLike,
} from './storage-sqlite.js';
