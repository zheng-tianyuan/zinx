import type { ChatStore, RuntimeToolStep, SessionBinding } from '../core/types.js';

type StoredSession = {
  id: string;
  title?: string;
  binding: SessionBinding;
  status: 'active' | 'failed' | 'archived';
  metadata?: Record<string, unknown>;
};

type StoredMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolSteps?: RuntimeToolStep[];
  metadata?: Record<string, unknown>;
};

export class InMemoryChatStore implements ChatStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly messages = new Map<string, StoredMessage[]>();
  private sequence = 0;

  async ensureSession(args: {
    chatSessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const id = args.chatSessionId || `chat_${++this.sequence}`;
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        id,
        title: args.title,
        status: 'active',
        metadata: args.metadata,
        binding: {
          productSessionId: id,
        },
      });
      this.messages.set(id, []);
    }
    return { id };
  }

  async getSessionBinding(chatSessionId: string): Promise<SessionBinding | null> {
    return this.sessions.get(chatSessionId)?.binding || null;
  }

  async appendMessage(args: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    toolSteps?: RuntimeToolStep[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const id = `message_${++this.sequence}`;
    const list = this.messages.get(args.sessionId) || [];
    list.push({ id, ...args });
    this.messages.set(args.sessionId, list);
    return { id };
  }

  async updateBinding(args: {
    sessionId: string;
    runtimeKind?: SessionBinding['runtimeKind'];
    runtimeSessionId?: string;
    memoryProvider?: string;
    memorySessionId?: string;
    status?: 'active' | 'failed' | 'archived';
  }): Promise<void> {
    const session = this.sessions.get(args.sessionId);
    if (!session) return;
    session.status = args.status || session.status;
    session.binding = {
      productSessionId: args.sessionId,
      runtimeKind: args.runtimeKind ?? session.binding.runtimeKind,
      runtimeSessionId: args.runtimeSessionId ?? session.binding.runtimeSessionId,
      memoryProvider: args.memoryProvider ?? session.binding.memoryProvider,
      memorySessionId: args.memorySessionId ?? session.binding.memorySessionId,
    };
  }
}
