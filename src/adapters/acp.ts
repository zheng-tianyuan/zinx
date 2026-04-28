import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  McpManifest,
  McpServerRef,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  RuntimeToolStep,
  SkillManifest,
  SkillMode,
  McpMode,
  TaskHandle,
  ToolCallSnapshot,
} from '../core/types.js';

type JsonRpcId = string | number;

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

export type AcpRuntimeAdapterConfig = {
  kind?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  protocolVersion?: number;
  timeoutMs?: number;
  permissionMode?: 'allow' | 'deny';
  clientName?: string;
  clientVersion?: string;
  clientCapabilities?: {
    fs?: {
      readTextFile?: boolean;
      writeTextFile?: boolean;
    };
    terminal?: boolean;
  };
};

export type AcpSessionUpdate = {
  sessionId: string;
  update: Record<string, any>;
  timestamp: number;
};

export type AcpTaskRaw = {
  taskId: string;
  sessionId: string;
  content: string;
  steps: RuntimeToolStep[];
  updates: AcpSessionUpdate[];
  stopReason?: string;
  rawResult?: unknown;
};

type TerminalRecord = {
  id: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  wait: Promise<{ exitCode: number | null; signal: string | null }>;
};

class AcpJsonRpcConnection {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private readonly terminals = new Map<string, TerminalRecord>();
  private terminalSequence = 0;

  constructor(
    private readonly config: AcpRuntimeAdapterConfig,
    private readonly onNotification: (message: JsonRpcMessage) => void,
  ) {}

  async start() {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.once('exit', () => {
      this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('ACP agent process exited'));
      }
      this.pending.clear();
    });
    child.stderr?.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) this.onNotification({ method: 'zinx/stderr', params: { text } });
    });

    const reader = createInterface({ input: child.stdout! });
    reader.on('line', line => this.handleLine(line));
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = this.config.timeoutMs || 600_000): Promise<T> {
    await this.start();
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
    });
    this.write(message);
    return result;
  }

  async notify(method: string, params?: unknown) {
    await this.start();
    this.write({ jsonrpc: '2.0', method, params });
  }

  close() {
    for (const terminal of this.terminals.values()) {
      terminal.child.kill('SIGTERM');
    }
    this.terminals.clear();
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private write(message: JsonRpcMessage) {
    if (!this.child?.stdin) throw new Error('ACP agent process is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.onNotification({ method: 'zinx/stdout', params: { text: trimmed } });
      return;
    }

    if (message.id !== undefined && !message.method) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `ACP error ${message.error.code || ''}`.trim()));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleClientRequest(message);
      return;
    }

    this.onNotification(message);
  }

  private async handleClientRequest(message: JsonRpcMessage) {
    try {
      const result = await this.dispatchClientMethod(message.method!, message.params || {});
      this.write({ jsonrpc: '2.0', id: message.id!, result });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id: message.id!,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatchClientMethod(method: string, params: any) {
    switch (method) {
      case 'fs/read_text_file':
        return this.readTextFile(params);
      case 'fs/write_text_file':
        return this.writeTextFile(params);
      case 'terminal/create':
        return this.createTerminal(params);
      case 'terminal/output':
        return this.terminalOutput(params);
      case 'terminal/wait_for_exit':
        return this.waitForTerminalExit(params);
      case 'terminal/kill':
        return this.killTerminal(params);
      case 'terminal/release':
        return this.releaseTerminal(params);
      case 'session/request_permission':
        return this.requestPermission(params);
      default:
        throw new Error(`Unsupported ACP client method: ${method}`);
    }
  }

  private async readTextFile(params: any) {
    const filePath = String(params.path);
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const startLine = Math.max(Number(params.line ?? params.startLine ?? 1), 1);
    const limit = Number(params.limit ?? params.lineLimit ?? 0);
    const selected = limit > 0
      ? lines.slice(startLine - 1, startLine - 1 + limit)
      : lines.slice(startLine - 1);
    return { content: selected.join('\n') };
  }

  private async writeTextFile(params: any) {
    const filePath = String(params.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(params.content ?? params.text ?? ''), 'utf-8');
    return {};
  }

  private createTerminal(params: any) {
    const id = `terminal_${++this.terminalSequence}`;
    const env = Array.isArray(params.env)
      ? Object.fromEntries(params.env.map((item: any) => [String(item.name), String(item.value)]))
      : params.env || {};
    const child = spawn(String(params.command), Array.isArray(params.args) ? params.args.map(String) : [], {
      cwd: params.cwd || this.config.cwd,
      env: { ...process.env, ...env },
      shell: false,
    });
    const terminal: TerminalRecord = {
      id,
      child,
      output: '',
      truncated: false,
      outputByteLimit: Number(params.outputByteLimit || 1024 * 1024),
      exitStatus: null,
      wait: new Promise(resolve => {
        child.once('close', (exitCode, signal) => {
          const status = { exitCode, signal };
          terminal.exitStatus = status;
          resolve(status);
        });
      }),
    };
    const collect = (chunk: Buffer | string) => {
      terminal.output += String(chunk);
      if (terminal.output.length > terminal.outputByteLimit) {
        terminal.truncated = true;
        terminal.output = terminal.output.slice(-terminal.outputByteLimit);
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  private terminalOutput(params: any) {
    const terminal = this.requireTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus,
    };
  }

  private async waitForTerminalExit(params: any) {
    const terminal = this.requireTerminal(params.terminalId);
    return terminal.exitStatus || await terminal.wait;
  }

  private killTerminal(params: any) {
    const terminal = this.requireTerminal(params.terminalId);
    terminal.child.kill('SIGTERM');
    return {};
  }

  private releaseTerminal(params: any) {
    const terminal = this.requireTerminal(params.terminalId);
    if (!terminal.exitStatus) terminal.child.kill('SIGTERM');
    this.terminals.delete(terminal.id);
    return {};
  }

  private requestPermission(params: any) {
    if (this.config.permissionMode === 'deny') {
      return { outcome: { outcome: 'cancelled' } };
    }
    const option = Array.isArray(params.options) ? params.options[0] : null;
    return { outcome: { outcome: 'selected', optionId: option?.optionId || option?.id || 'allow' } };
  }

  private requireTerminal(id: string): TerminalRecord {
    const terminal = this.terminals.get(String(id));
    if (!terminal) throw new Error(`Terminal not found: ${id}`);
    return terminal;
  }
}

export class AcpRuntimeAdapter implements RuntimeAdapter<AcpSessionUpdate, AcpTaskRaw> {
  readonly kind: string;
  private readonly connection: AcpJsonRpcConnection;
  private initialized: Promise<unknown> | null = null;
  private readonly sessions = new Map<string, AcpSessionUpdate[]>();
  private readonly runningTasks = new Map<string, string>();
  private sequence = 0;
  private mcpManifest: McpManifest | null = null;

  constructor(private readonly config: AcpRuntimeAdapterConfig) {
    this.kind = config.kind || 'acp';
    this.connection = new AcpJsonRpcConnection(config, message => this.handleNotification(message));
  }

  capabilities(): RuntimeCapabilities {
    return {
      streamingEvents: true,
      toolCallStreaming: true,
      sessionReuse: true,
      sessionListing: true,
      taskCancellation: true,
      nativeMemoryIntegration: false,
      nativeSkillIntegration: false,
      nativeMcpIntegration: true,
    };
  }

  async createSession(args: { title: string; metadata?: Record<string, unknown> }): Promise<RuntimeSession> {
    await this.initialize();
    const result = await this.connection.request<{ sessionId: string }>('session/new', {
      cwd: this.config.cwd || process.cwd(),
      mcpServers: this.mcpServers(),
      _meta: {
        title: args.title,
        ...args.metadata,
      },
    }, Math.min(this.config.timeoutMs || 600_000, 120_000));
    this.sessions.set(result.sessionId, []);
    return {
      id: result.sessionId,
      runtime: this.kind,
      createdAt: Date.now(),
      resumed: false,
    };
  }

  async resumeSession(args: { sessionId: string }): Promise<RuntimeSession> {
    await this.initialize();
    try {
      await this.connection.request('session/resume', {
        sessionId: args.sessionId,
        cwd: this.config.cwd || process.cwd(),
        mcpServers: this.mcpServers(),
      }, Math.min(this.config.timeoutMs || 600_000, 120_000));
    } catch {
      await this.connection.request('session/load', {
        sessionId: args.sessionId,
        cwd: this.config.cwd || process.cwd(),
        mcpServers: this.mcpServers(),
      }, Math.min(this.config.timeoutMs || 600_000, 120_000));
    }
    if (!this.sessions.has(args.sessionId)) this.sessions.set(args.sessionId, []);
    return {
      id: args.sessionId,
      runtime: this.kind,
      resumed: true,
    };
  }

  async sendTask(args: RuntimeTaskRequest): Promise<TaskHandle<AcpTaskRaw>> {
    await this.initialize();
    const taskId = `acp_task_${Date.now()}_${++this.sequence}`;
    const startIndex = this.messagesFor(args.sessionId).length;
    this.runningTasks.set(taskId, args.sessionId);
    const result = await this.connection.request<{ stopReason?: string }>('session/prompt', {
      sessionId: args.sessionId,
      prompt: [{ type: 'text', text: args.prompt }],
      _meta: args.metadata,
    }).finally(() => {
      this.runningTasks.delete(taskId);
    });
    const updates = this.messagesFor(args.sessionId).slice(startIndex);
    const raw: AcpTaskRaw = {
      taskId,
      sessionId: args.sessionId,
      content: collectAcpText(updates),
      steps: collectAcpSteps(updates),
      updates,
      stopReason: result?.stopReason,
      rawResult: result,
    };
    return {
      id: taskId,
      session: {
        id: args.sessionId,
        runtime: this.kind,
        resumed: true,
      },
      submittedAt: Date.now(),
      raw,
    };
  }

  async listMessages(args: { sessionId: string }): Promise<AcpSessionUpdate[]> {
    return this.messagesFor(args.sessionId);
  }

  extractToolSnapshots(messages: AcpSessionUpdate[]): ToolCallSnapshot[] {
    const snapshots = new Map<string, ToolCallSnapshot>();
    for (const message of messages) {
      const update = message.update;
      const kind = update.sessionUpdate;
      if (kind === 'tool_call') {
        snapshots.set(String(update.toolCallId), {
          id: String(update.toolCallId),
          tool: update.title || update.kind || 'tool',
          input: update,
          finished: update.status === 'completed' || update.status === 'failed',
        });
      }
      if (kind === 'tool_call_update') {
        const id = String(update.toolCallId);
        const existing = snapshots.get(id);
        snapshots.set(id, {
          id,
          tool: existing?.tool || 'tool',
          input: existing?.input,
          output: update.content || update,
          finished: update.status === 'completed' || update.status === 'failed',
        });
      }
    }
    return [...snapshots.values()];
  }

  buildResult(args: { task: TaskHandle<AcpTaskRaw>; messages: AcpSessionUpdate[] }): RuntimeTaskResult {
    return {
      taskId: args.task.id,
      sessionId: args.task.session.id,
      content: args.task.raw.content || collectAcpText(args.task.raw.updates),
      steps: args.task.raw.steps.length ? args.task.raw.steps : collectAcpSteps(args.task.raw.updates),
      raw: args.task.raw,
    };
  }

  async prepareRuntimeAssets(args: {
    session: RuntimeSession;
    skills?: SkillManifest | null;
    mcp?: McpManifest | null;
    skillMode: SkillMode;
    mcpMode: McpMode;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    this.mcpManifest = args.mcp || null;
  }

  async cancelTask(args: { sessionId: string; taskId: string }): Promise<void> {
    await this.connection.notify('session/cancel', { sessionId: args.sessionId });
  }

  async close(): Promise<void> {
    this.connection.close();
  }

  private async initialize() {
    if (!this.initialized) {
      this.initialized = this.connection.request('initialize', {
        protocolVersion: this.config.protocolVersion || 1,
        clientCapabilities: this.config.clientCapabilities || {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: this.config.clientName || 'zinx',
          version: this.config.clientVersion || '0.1.0',
        },
      }, Math.min(this.config.timeoutMs || 600_000, 120_000));
    }
    return this.initialized;
  }

  private handleNotification(message: JsonRpcMessage) {
    if (message.method !== 'session/update') return;
    const sessionId = String(message.params?.sessionId || '');
    if (!sessionId) return;
    this.messagesFor(sessionId).push({
      sessionId,
      update: message.params.update || {},
      timestamp: Date.now(),
    });
  }

  private messagesFor(sessionId: string): AcpSessionUpdate[] {
    const messages = this.sessions.get(sessionId);
    if (messages) return messages;
    const created: AcpSessionUpdate[] = [];
    this.sessions.set(sessionId, created);
    return created;
  }

  private mcpServers() {
    return (this.mcpManifest?.servers || []).map(server => toAcpMcpServer(server));
  }
}

function toAcpMcpServer(server: McpServerRef) {
  if (server.transport === 'http') {
    return {
      type: 'http',
      name: server.name || server.id,
      url: server.endpoint,
      headers: envObjectToArray(server.env),
    };
  }
  if (server.transport === 'sse') {
    return {
      type: 'sse',
      name: server.name || server.id,
      url: server.endpoint,
      headers: envObjectToArray(server.env),
    };
  }
  return {
    name: server.name || server.id,
    command: server.command,
    args: server.args || [],
    env: envObjectToArray(server.env),
  };
}

function envObjectToArray(env?: Record<string, string>) {
  return Object.entries(env || {}).map(([name, value]) => ({ name, value }));
}

function collectAcpText(updates: AcpSessionUpdate[]) {
  return updates
    .filter(item => item.update.sessionUpdate === 'agent_message_chunk')
    .map(item => contentToText(item.update.content))
    .filter(Boolean)
    .join('')
    .trim();
}

function collectAcpSteps(updates: AcpSessionUpdate[]): RuntimeToolStep[] {
  const calls = new Map<string, { tool: string; input?: unknown; output?: string }>();
  for (const item of updates) {
    const update = item.update;
    if (update.sessionUpdate === 'tool_call') {
      calls.set(String(update.toolCallId), {
        tool: update.title || update.kind || 'tool',
        input: update,
      });
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const id = String(update.toolCallId);
      const existing = calls.get(id) || { tool: 'tool' };
      calls.set(id, {
        ...existing,
        output: contentToText(update.content) || formatUnknown(update.content || update),
      });
    }
  }
  return [...calls.values()].map(call => ({
    tool: call.tool,
    input: call.input,
    output: call.output || '',
  }));
}

function contentToText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).join('');
  if (typeof content === 'object') {
    const value = content as Record<string, any>;
    if (value.type === 'text' && typeof value.text === 'string') return value.text;
    if (value.type === 'content') return contentToText(value.content);
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return '';
}

function formatUnknown(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
