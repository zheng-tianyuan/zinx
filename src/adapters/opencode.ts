import type {
  MemoryRecallEvidence,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  TaskHandle,
  ToolCallSnapshot,
} from '../core/types.js';

export type OpenCodePart = {
  type: string;
  text?: string;
  tool?: string;
  state?: {
    input?: unknown;
    output?: unknown;
  };
};

export type OpenCodeMessage = {
  info: {
    id: string;
    role: 'user' | 'assistant';
    parentID?: string;
  };
  parts: OpenCodePart[];
};

type OpenCodeTaskRaw = {
  parentID: string;
  parts: OpenCodePart[];
};

export type OpenCodeAdapterConfig = {
  baseUrl: string;
  directory: string;
  providerId: string;
  defaultModelId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  readNativeMemoryEvidence?: (args: {
    sessionId: string;
    taskId: string;
    query: string;
    startedAt: number;
    messages: OpenCodeMessage[];
  }) => Promise<MemoryRecallEvidence | null>;
};

function buildUrl(baseUrl: string, pathname: string, directory: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  const url = new URL(`${normalized}${pathname}`);
  url.searchParams.set('directory', directory);
  return url.toString();
}

async function requestJson<T>(args: {
  fetchImpl: typeof fetch;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    const response = await args.fetchImpl(args.url, {
      ...args.init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(args.init?.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `OpenCode request failed with status ${response.status}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function collectText(parts: OpenCodePart[]): string {
  return parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

function normalizeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export class OpenCodeRuntimeAdapter implements RuntimeAdapter<OpenCodeMessage, OpenCodeTaskRaw> {
  readonly kind = 'opencode' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenCodeAdapterConfig) {
    this.fetchImpl = config.fetchImpl || fetch;
    this.timeoutMs = config.timeoutMs ?? 600_000;
  }

  capabilities(): RuntimeCapabilities {
    return {
      streamingEvents: false,
      toolCallStreaming: true,
      sessionReuse: true,
      sessionListing: true,
      taskCancellation: false,
      nativeMemoryIntegration: true,
      nativeSkillIntegration: true,
      nativeMcpIntegration: true,
    };
  }

  async createSession(args: { title: string }): Promise<RuntimeSession> {
    const payload = await requestJson<{ id: string }>({
      fetchImpl: this.fetchImpl,
      url: buildUrl(this.config.baseUrl, '/session', this.config.directory),
      init: {
        method: 'POST',
        body: JSON.stringify({ title: args.title }),
      },
      timeoutMs: Math.min(this.timeoutMs, 120_000),
    });

    return {
      id: payload.id,
      runtime: this.kind,
      createdAt: Date.now(),
      resumed: false,
    };
  }

  async resumeSession(args: { sessionId: string }): Promise<RuntimeSession> {
    return {
      id: args.sessionId,
      runtime: this.kind,
      resumed: true,
    };
  }

  async sendTask(args: RuntimeTaskRequest): Promise<TaskHandle<OpenCodeTaskRaw>> {
    const payload = await requestJson<{ info?: { parentID?: string }; parts?: OpenCodePart[] }>({
      fetchImpl: this.fetchImpl,
      url: buildUrl(this.config.baseUrl, `/session/${args.sessionId}/message`, this.config.directory),
      init: {
        method: 'POST',
        body: JSON.stringify({
          model: {
            providerID: this.config.providerId,
            modelID: args.modelId || this.config.defaultModelId,
          },
          parts: [{ type: 'text', text: args.prompt }],
        }),
      },
      timeoutMs: this.timeoutMs,
    });

    if (!payload.info?.parentID) {
      throw new Error('OpenCode message response missing parentID');
    }

    return {
      id: payload.info.parentID,
      session: {
        id: args.sessionId,
        runtime: this.kind,
        resumed: true,
      },
      submittedAt: Date.now(),
      raw: {
        parentID: payload.info.parentID,
        parts: payload.parts || [],
      },
    };
  }

  async listMessages(args: { sessionId: string }): Promise<OpenCodeMessage[]> {
    return requestJson<OpenCodeMessage[]>({
      fetchImpl: this.fetchImpl,
      url: buildUrl(this.config.baseUrl, `/session/${args.sessionId}/message`, this.config.directory),
      timeoutMs: Math.min(this.timeoutMs, 120_000),
    });
  }

  extractToolSnapshots(messages: OpenCodeMessage[]): ToolCallSnapshot[] {
    return messages
      .filter(message => message.info.role === 'assistant')
      .flatMap(message => message.parts.map((part, index) => ({ message, part, index })))
      .filter(({ part }) => part.type === 'tool' && typeof part.tool === 'string')
      .map(({ message, part, index }) => ({
        id: `${message.info.id}:${index}`,
        tool: part.tool as string,
        input: part.state?.input,
        output: part.state?.output,
        finished: Boolean(part.state && 'output' in part.state && part.state.output !== undefined),
      }));
  }

  buildResult(args: {
    task: TaskHandle<OpenCodeTaskRaw>;
    messages: OpenCodeMessage[];
  }): RuntimeTaskResult {
    const assistantMessages = args.messages.filter(
      message => message.info.role === 'assistant' && message.info.parentID === args.task.raw.parentID,
    );

    let content = collectText(args.task.raw.parts);
    for (let index = assistantMessages.length - 1; index >= 0; index -= 1) {
      const text = collectText(assistantMessages[index].parts);
      if (text) {
        content = text;
        break;
      }
    }

    return {
      taskId: args.task.id,
      sessionId: args.task.session.id,
      content,
      steps: assistantMessages.flatMap(message => message.parts
        .filter(part => part.type === 'tool' && typeof part.tool === 'string')
        .map(part => ({
          tool: part.tool as string,
          input: part.state?.input,
          output: normalizeToolOutput(part.state?.output),
        }))),
    };
  }

  async readNativeMemoryEvidence(args: {
    sessionId: string;
    task: TaskHandle<OpenCodeTaskRaw>;
    messages: OpenCodeMessage[];
    query: string;
    startedAt: number;
  }): Promise<MemoryRecallEvidence | null> {
    if (!this.config.readNativeMemoryEvidence) return null;
    return this.config.readNativeMemoryEvidence({
      sessionId: args.sessionId,
      taskId: args.task.id,
      query: args.query,
      startedAt: args.startedAt,
      messages: args.messages,
    });
  }

  async runTaskOnce(args: {
    sessionId?: string;
    title: string;
    modelId?: string;
    prompt: string;
  }): Promise<RuntimeTaskResult> {
    const session = args.sessionId
      ? await this.resumeSession({ sessionId: args.sessionId })
      : await this.createSession({ title: args.title });
    const task = await this.sendTask({
      sessionId: session.id,
      modelId: args.modelId,
      prompt: args.prompt,
    });
    const messages = await this.listMessages({ sessionId: session.id });
    return this.buildResult({ task, messages });
  }
}
