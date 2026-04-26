import type {
  MemoryCommitResult,
  MemoryItem,
  MemoryProvider,
  MemoryRecallEvidence,
  SessionBinding,
} from '../core/types.js';

type OpenVikingResponse<T> = {
  status?: string;
  result?: T;
  error?: string | { code?: string; message?: string };
};

export type OpenVikingProviderConfig = {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  defaultTargetUri?: string;
};

function getErrorMessage(error: OpenVikingResponse<unknown>['error']): string {
  if (!error) return 'Unknown OpenViking error';
  if (typeof error === 'string') return error;
  return error.message || error.code || 'Unknown OpenViking error';
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, '');
}

function normalizeMemoryItem(item: Record<string, unknown>): MemoryItem {
  return {
    uri: String(item.uri || ''),
    title: typeof item.title === 'string' ? item.title : undefined,
    abstract: typeof item.abstract === 'string' ? item.abstract : undefined,
    content: typeof item.content === 'string' ? item.content : undefined,
    score: typeof item.score === 'number' ? item.score : undefined,
    metadata: item,
  };
}

export class OpenVikingMemoryProvider implements MemoryProvider {
  readonly kind = 'openviking' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenVikingProviderConfig) {
    this.fetchImpl = config.fetchImpl || fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async bindSession(args: SessionBinding): Promise<SessionBinding> {
    return {
      ...args,
      memoryProvider: this.kind,
      memorySessionId: args.memorySessionId || args.runtimeSessionId || args.productSessionId,
    };
  }

  async recall(args: {
    query: string;
    session?: SessionBinding;
    limit?: number;
    targetUri?: string;
  }): Promise<MemoryRecallEvidence | null> {
    const result = await this.request<{
      memories?: Record<string, unknown>[];
      resources?: Record<string, unknown>[];
      skills?: Record<string, unknown>[];
      total?: number;
    }>('/api/v1/search/find', {
      method: 'POST',
      body: JSON.stringify({
        query: args.query,
        target_uri: args.targetUri || this.config.defaultTargetUri,
        limit: args.limit ?? 8,
        mode: 'auto',
      }),
    });

    const memories = [
      ...(result.memories || []),
      ...(result.resources || []),
      ...(result.skills || []),
    ].map(normalizeMemoryItem).filter(item => item.uri);

    if (memories.length === 0) return null;

    return {
      provider: this.kind,
      sessionId: args.session?.memorySessionId,
      query: args.query,
      count: memories.length,
      source: 'explicit',
      memories,
      raw: result,
    };
  }

  async read(args: {
    uri: string;
    level?: 'abstract' | 'overview' | 'read';
  }): Promise<string | Record<string, unknown>> {
    const level = args.level || 'read';
    return this.request<string | Record<string, unknown>>(
      `/api/v1/content/${level}?uri=${encodeURIComponent(args.uri)}`,
      { method: 'GET' },
    );
  }

  async commit(args: {
    question: string;
    answer: string;
    feedback: 'positive' | 'negative';
    correction?: string;
    session?: SessionBinding;
    executor?: (input: {
      title: string;
      prompt: string;
      runtimeSessionId?: string;
    }) => Promise<{
      runtimeSessionId?: string;
      content: string;
      steps?: Array<{ tool: string; input?: unknown; output: string }>;
    }>;
  }): Promise<MemoryCommitResult> {
    if (!args.executor) {
      return {
        provider: this.kind,
        status: 'skipped',
        summary: 'No memory commit executor was provided.',
        memorySessionId: args.session?.memorySessionId,
        runtimeSessionId: args.session?.runtimeSessionId,
        steps: [],
      };
    }

    const result = await args.executor({
      title: 'Memory feedback commit',
      runtimeSessionId: args.session?.runtimeSessionId,
      prompt: this.buildCommitPrompt(args),
    });

    return {
      provider: this.kind,
      status: 'committed',
      summary: result.content,
      memorySessionId: args.session?.memorySessionId,
      runtimeSessionId: result.runtimeSessionId || args.session?.runtimeSessionId,
      steps: result.steps || [],
    };
  }

  private buildCommitPrompt(args: {
    question: string;
    answer: string;
    feedback: 'positive' | 'negative';
    correction?: string;
  }): string {
    return [
      'You are committing user feedback into long-term memory.',
      'Do not re-run code analysis. Focus only on the previous question, answer, and feedback.',
      'Write a concrete memory summary, then use the runtime memory commit tool if one is available.',
      '',
      `Question: ${args.question}`,
      '',
      'Answer:',
      args.answer,
      '',
      `Feedback: ${args.feedback}`,
      args.correction ? `Correction: ${args.correction}` : '',
    ].filter(Boolean).join('\n');
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;

    try {
      const response = await this.fetchImpl(`${normalizeEndpoint(this.config.endpoint)}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...headers,
          ...(init?.headers || {}),
        },
      });
      const payload = await response.json() as OpenVikingResponse<T>;
      if (!response.ok || (payload.status && payload.status !== 'ok')) {
        throw new Error(getErrorMessage(payload.error));
      }
      return payload.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
