import type {
  AppendMessageInput,
  ChatChunk,
  ChatStreamInput,
  LLMClient,
  Storage,
  StoredMessage,
  StoredMessageWithId,
} from '../src/types.js';

export class MemoryStorage implements Storage {
  private rows: StoredMessageWithId[] = [];
  private nextId = 1;

  async appendMessage(_sessionId: string, msg: AppendMessageInput): Promise<StoredMessageWithId> {
    const stored = {
      ...(msg as object),
      createdAt: msg.createdAt ?? Date.now(),
      id: this.nextId++,
    } as StoredMessageWithId;
    this.rows.push(stored);
    return stored;
  }

  async loadMessages(_sessionId: string): Promise<StoredMessageWithId[]> {
    return [...this.rows];
  }

  async countTokens(_sessionId: string): Promise<number> {
    // Cheap approximation: 4 chars/token over JSON.
    return Math.ceil(JSON.stringify(this.rows).length / 4);
  }

  all(): StoredMessage[] {
    return [...this.rows];
  }

  reset(): void {
    this.rows = [];
    this.nextId = 1;
  }
}

/** Build a stub LLM that emits a scripted stream. */
export function scriptedLLM(scripts: ChatChunk[][]): LLMClient {
  let call = 0;
  return {
    chatStream(_input: ChatStreamInput): AsyncIterable<ChatChunk> {
      const chunks = scripts[call++] ?? [{ type: 'finish', reason: 'stop' }];
      return (async function* () {
        for (const c of chunks) {
          yield c;
        }
      })();
    },
  };
}

export const finishStop: ChatChunk = { type: 'finish', reason: 'stop' };
