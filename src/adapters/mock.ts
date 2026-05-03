import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  TaskHandle,
  ToolCallSnapshot,
} from '../core/types.js';

type MockMessage = {
  id: string;
  role: 'user' | 'assistant';
  parentId?: string;
  content?: string;
  tool?: {
    name: string;
    input?: unknown;
    output?: unknown;
  };
};

type MockTask = {
  parentId: string;
  content: string;
};

export class MockRuntimeAdapter implements RuntimeAdapter<MockMessage, MockTask> {
  readonly kind = 'mock' as const;
  private readonly sessions = new Map<string, MockMessage[]>();
  private sequence = 0;

  constructor(private readonly responder: (prompt: string) => string = prompt => `Mock response:\n${prompt}`) {}

  capabilities(): RuntimeCapabilities {
    return {
      streamingEvents: false,
      toolCallStreaming: true,
      sessionReuse: true,
      sessionListing: true,
      taskCancellation: false,
      nativeMemoryIntegration: false,
    };
  }

  async createSession(): Promise<RuntimeSession> {
    const id = `mock_${++this.sequence}`;
    this.sessions.set(id, []);
    return {
      id,
      runtime: this.kind,
      createdAt: Date.now(),
      resumed: false,
    };
  }

  async resumeSession(args: { sessionId: string }): Promise<RuntimeSession> {
    if (!this.sessions.has(args.sessionId)) {
      this.sessions.set(args.sessionId, []);
    }
    return {
      id: args.sessionId,
      runtime: this.kind,
      resumed: true,
    };
  }

  async sendTask(args: RuntimeTaskRequest): Promise<TaskHandle<MockTask>> {
    if (args.signal?.aborted) {
      throw new Error('Operation aborted');
    }
    const messages = this.sessions.get(args.sessionId) || [];
    const parentId = `task_${++this.sequence}`;
    const content = this.responder(args.prompt);
    messages.push({
      id: `msg_${++this.sequence}`,
      role: 'user',
      content: args.prompt,
    });
    messages.push({
      id: `msg_${++this.sequence}`,
      role: 'assistant',
      parentId,
      tool: {
        name: 'mock_tool',
        input: { promptLength: args.prompt.length },
        output: 'mock tool output',
      },
    });
    messages.push({
      id: `msg_${++this.sequence}`,
      role: 'assistant',
      parentId,
      content,
    });
    this.sessions.set(args.sessionId, messages);

    return {
      id: parentId,
      session: {
        id: args.sessionId,
        runtime: this.kind,
        resumed: true,
      },
      submittedAt: Date.now(),
      raw: {
        parentId,
        content,
      },
    };
  }

  async listMessages(args: { sessionId: string }): Promise<MockMessage[]> {
    return this.sessions.get(args.sessionId) || [];
  }

  extractToolSnapshots(messages: MockMessage[]): ToolCallSnapshot[] {
    return messages
      .filter(message => message.tool)
      .map(message => ({
        id: message.id,
        tool: message.tool!.name,
        input: message.tool!.input,
        output: message.tool!.output,
        finished: message.tool!.output !== undefined,
      }));
  }

  buildResult(args: { task: TaskHandle<MockTask>; messages: MockMessage[] }): RuntimeTaskResult {
    const final = [...args.messages].reverse().find(
      message => message.role === 'assistant' && message.parentId === args.task.raw.parentId && message.content,
    );

    return {
      taskId: args.task.id,
      sessionId: args.task.session.id,
      content: final?.content || args.task.raw.content,
      steps: args.messages
        .filter(message => message.parentId === args.task.raw.parentId && message.tool)
        .map(message => ({
          tool: message.tool!.name,
          input: message.tool!.input,
          output: String(message.tool!.output ?? ''),
        })),
    };
  }
}
