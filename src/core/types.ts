export type AgentRuntimeKind = 'opencode' | 'cursor' | 'codex' | 'mock' | (string & {});

export type RuntimeSession = {
  id: string;
  runtime: AgentRuntimeKind;
  createdAt?: number;
  resumed?: boolean;
};

export type SessionBinding = {
  productSessionId: string;
  runtimeKind?: AgentRuntimeKind;
  runtimeSessionId?: string;
  memoryProvider?: string;
  memorySessionId?: string;
};

export type RuntimeCapabilities = {
  streamingEvents: boolean;
  toolCallStreaming: boolean;
  sessionReuse: boolean;
  sessionListing: boolean;
  taskCancellation: boolean;
  nativeMemoryIntegration: boolean;
};

export type RuntimeToolStep = {
  tool: string;
  input?: unknown;
  output: string;
};

export type ToolCallSnapshot = {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  finished: boolean;
};

export type RuntimeTaskRequest = {
  sessionId: string;
  modelId?: string;
  prompt: string;
  metadata?: Record<string, unknown>;
};

export type TaskHandle<TRawTask = unknown> = {
  id: string;
  session: RuntimeSession;
  submittedAt: number;
  raw: TRawTask;
};

export type RuntimeTaskResult = {
  taskId: string;
  sessionId: string;
  content: string;
  steps: RuntimeToolStep[];
  raw?: unknown;
};

export type MemoryItem = {
  uri: string;
  title?: string;
  abstract?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type MemoryRecallEvidence = {
  provider: string;
  sessionId?: string;
  query: string;
  count: number;
  source: 'explicit' | 'native' | 'log' | (string & {});
  memories: MemoryItem[];
  raw?: unknown;
};

export type AgentEvent =
  | { type: 'session_bound'; binding: SessionBinding }
  | { type: 'log'; message: string }
  | { type: 'progress'; phase: string; elapsedMs?: number }
  | { type: 'memory_recalled'; evidence: MemoryRecallEvidence }
  | { type: 'step_started'; stepId: string; tool: string; input?: unknown }
  | { type: 'step_finished'; stepId: string; tool: string; output: string }
  | { type: 'partial_text'; content: string }
  | { type: 'final_text'; content: string; sessionId: string; chatSessionId?: string; messageId?: string }
  | { type: 'error'; message: string };

export interface RuntimeAdapter<TRawMessage = unknown, TRawTask = unknown> {
  readonly kind: AgentRuntimeKind;
  capabilities(): RuntimeCapabilities;
  createSession(args: { title: string; metadata?: Record<string, unknown> }): Promise<RuntimeSession>;
  resumeSession(args: { sessionId: string }): Promise<RuntimeSession>;
  sendTask(args: RuntimeTaskRequest): Promise<TaskHandle<TRawTask>>;
  listMessages(args: { sessionId: string }): Promise<TRawMessage[]>;
  extractToolSnapshots(messages: TRawMessage[]): ToolCallSnapshot[];
  buildResult(args: { task: TaskHandle<TRawTask>; messages: TRawMessage[] }): RuntimeTaskResult;
  cancelTask?(args: { sessionId: string; taskId: string }): Promise<void>;
}

export interface MemoryProvider {
  readonly kind: string;
  bindSession(args: SessionBinding): Promise<SessionBinding>;
  recall(args: {
    query: string;
    session?: SessionBinding;
    limit?: number;
    targetUri?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryRecallEvidence | null>;
  read(args: { uri: string; level?: 'abstract' | 'overview' | 'read' }): Promise<string | Record<string, unknown>>;
  commit(args: {
    question: string;
    answer: string;
    feedback: 'positive' | 'negative';
    correction?: string;
    session?: SessionBinding;
    executor?: MemoryCommitExecutor;
    metadata?: Record<string, unknown>;
  }): Promise<MemoryCommitResult>;
}

export type MemoryCommitExecutor = (args: {
  title: string;
  prompt: string;
  runtimeSessionId?: string;
}) => Promise<{
  runtimeSessionId?: string;
  content: string;
  steps?: RuntimeToolStep[];
}>;

export type MemoryCommitResult = {
  provider: string;
  status: 'committed' | 'queued' | 'skipped';
  summary: string;
  runtimeSessionId?: string;
  memorySessionId?: string;
  steps: RuntimeToolStep[];
  raw?: unknown;
};

export interface ChatStore {
  ensureSession(args: {
    chatSessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  getSessionBinding(chatSessionId: string): Promise<SessionBinding | null>;
  appendMessage(args: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    toolSteps?: RuntimeToolStep[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  updateBinding(args: {
    sessionId: string;
    runtimeKind?: AgentRuntimeKind;
    runtimeSessionId?: string;
    memoryProvider?: string;
    memorySessionId?: string;
    status?: 'active' | 'failed' | 'archived';
  }): Promise<void>;
}
