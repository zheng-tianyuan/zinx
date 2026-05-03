export type AgentRuntimeKind = 'acp' | 'opencode' | 'cursor' | 'codex' | 'gemini' | 'mock' | (string & {});

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
  nativeSkillIntegration?: boolean;
  nativeMcpIntegration?: boolean;
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
  signal?: AbortSignal;
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

export type MemoryMode = 'auto' | 'explicit' | 'native' | 'off';
export type SkillMode = 'auto' | 'native' | 'prompt' | 'off';
export type McpMode = 'auto' | 'native' | 'manifest' | 'off';
export type AgentTaskStatus = 'draft' | 'queued' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export type AgentTaskEventType =
  | 'log'
  | 'progress'
  | 'step_started'
  | 'step_finished'
  | 'partial_text'
  | 'final_text'
  | 'error';

export type AgentTaskSpec = {
  id?: string;
  title: string;
  description?: string;
  type?: string;
  prompt: string;
  runtimeKind?: AgentRuntimeKind;
  modelId?: string;
  metadata?: Record<string, unknown>;
};

export type AgentTaskRuntimeContext = {
  task: AgentTaskSpec;
  status: AgentTaskStatus;
  runId?: string;
  startedAt?: number;
  metadata?: Record<string, unknown>;
};

export type AgentTaskLifecycleEvent = {
  type: AgentTaskEventType;
  message?: string;
  data?: unknown;
  elapsedMs?: number;
};

export interface AgentTaskSink {
  onStatus?(status: AgentTaskStatus, context: AgentTaskRuntimeContext): Promise<void> | void;
  onEvent?(event: AgentTaskLifecycleEvent, context: AgentTaskRuntimeContext): Promise<void> | void;
  onArtifact?(artifact: {
    type: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }, context: AgentTaskRuntimeContext): Promise<void> | void;
}

export type CollaborationResource = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type CollaborationCapability = {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export interface CollaborationProvider {
  readonly kind: string;
  health(args?: { metadata?: Record<string, unknown> }): Promise<{
    ok: boolean;
    message?: string;
    raw?: unknown;
  }>;
  listCapabilities(args?: { metadata?: Record<string, unknown> }): Promise<CollaborationCapability[]>;
  resolveResource?(args: {
    urlOrId: string;
    metadata?: Record<string, unknown>;
  }): Promise<CollaborationResource | null>;
}

export type CliBinding = {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  metadata?: Record<string, unknown>;
};

export type SkillFile = {
  path: string;
  content: string;
};

export type SkillBundle = {
  name: string;
  description?: string;
  content: string;
  files?: SkillFile[];
  trigger?: string;
  metadata?: Record<string, unknown>;
};

export type SkillManifest = {
  provider: string;
  skills: SkillBundle[];
};

export interface SkillProvider {
  readonly kind: string;
  listSkills(args?: {
    names?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<SkillBundle[]>;
}

export type McpTransportKind = 'stdio' | 'http' | 'sse' | 'websocket' | (string & {});

export type McpServerRef = {
  id: string;
  name?: string;
  transport?: McpTransportKind;
  endpoint?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

export type McpTool = {
  id: string;
  name: string;
  description?: string;
  server?: McpServerRef;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  server?: McpServerRef;
  metadata?: Record<string, unknown>;
};

export type McpManifest = {
  provider: string;
  servers: McpServerRef[];
  tools: McpTool[];
  resources: McpResource[];
};

export type McpToolCallResult = {
  provider: string;
  serverId?: string;
  toolName: string;
  result: unknown;
  raw?: unknown;
};

export interface McpProvider {
  readonly kind: string;
  listServers(args?: { metadata?: Record<string, unknown> }): Promise<McpServerRef[]>;
  listTools(args?: { serverId?: string; metadata?: Record<string, unknown> }): Promise<McpTool[]>;
  listResources(args?: { serverId?: string; metadata?: Record<string, unknown> }): Promise<McpResource[]>;
  callTool?(args: {
    serverId?: string;
    toolName: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
  readResource?(args: {
    uri: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

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
  prepareRuntimeAssetsBeforeSession?(args: {
    session?: RuntimeSession;
    skills?: SkillManifest | null;
    mcp?: McpManifest | null;
    skillMode: SkillMode;
    mcpMode: McpMode;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  prepareRuntimeAssetsAfterSession?(args: {
    session: RuntimeSession;
    skills?: SkillManifest | null;
    mcp?: McpManifest | null;
    skillMode: SkillMode;
    mcpMode: McpMode;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  prepareRuntimeAssets?(args: {
    session: RuntimeSession;
    skills?: SkillManifest | null;
    mcp?: McpManifest | null;
    skillMode: SkillMode;
    mcpMode: McpMode;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  readNativeMemoryEvidence?(args: {
    sessionId: string;
    task: TaskHandle<TRawTask>;
    messages: TRawMessage[];
    query: string;
    startedAt: number;
  }): Promise<MemoryRecallEvidence | null>;
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
