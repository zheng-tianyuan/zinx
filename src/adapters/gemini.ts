import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTaskRequest,
  RuntimeTaskResult,
  RuntimeToolStep,
  TaskHandle,
  ToolCallSnapshot,
} from '../core/types.js';

export type GeminiAdapterConfig = {
  executable?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  customArgs?: string[];
  timeoutMs?: number;
  yolo?: boolean;
};

export type GeminiMessage =
  | { type: 'status'; id: string; status: string; timestamp: number }
  | { type: 'text'; id: string; taskId: string; content: string; timestamp: number }
  | { type: 'tool_use'; id: string; taskId: string; tool: string; input?: unknown; timestamp: number }
  | { type: 'tool_result'; id: string; taskId: string; output?: unknown; timestamp: number }
  | { type: 'error'; id: string; taskId: string; content: string; timestamp: number };

export type GeminiTaskRaw = {
  taskId: string;
  requestedSessionId: string;
  actualSessionId?: string;
  content: string;
  steps: RuntimeToolStep[];
  rawEvents: unknown[];
};

type GeminiStreamEvent = {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  output?: unknown;
  message?: string;
  status?: string;
  error?: {
    message?: string;
  };
};

const blockedArgsWithValue = new Set(['-p', '--prompt', '-o', '--output-format', '-m', '--model', '-r', '--resume']);
const blockedStandaloneArgs = new Set(['--yolo']);

export class GeminiRuntimeAdapter implements RuntimeAdapter<GeminiMessage, GeminiTaskRaw> {
  readonly kind = 'gemini' as const;
  private readonly sessions = new Map<string, GeminiMessage[]>();
  private readonly running = new Map<string, ChildProcess>();
  private sequence = 0;

  constructor(private readonly config: GeminiAdapterConfig = {}) {}

  capabilities(): RuntimeCapabilities {
    return {
      streamingEvents: true,
      toolCallStreaming: true,
      sessionReuse: true,
      sessionListing: false,
      taskCancellation: true,
      nativeMemoryIntegration: false,
      nativeSkillIntegration: false,
      nativeMcpIntegration: false,
    };
  }

  async createSession(args: { title: string; metadata?: Record<string, unknown> }): Promise<RuntimeSession> {
    const id = `gemini_${Date.now()}_${++this.sequence}`;
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

  async sendTask(args: RuntimeTaskRequest): Promise<TaskHandle<GeminiTaskRaw>> {
    const taskId = `gemini_task_${Date.now()}_${++this.sequence}`;
    const messages = this.messagesFor(args.sessionId);
    const rawEvents: unknown[] = [];
    const toolInputs = new Map<string, { tool: string; input?: unknown }>();
    const steps: RuntimeToolStep[] = [];
    let actualSessionId: string | undefined;
    let content = '';
    let stderr = '';

    const child = spawn(this.config.executable || 'gemini', this.buildArgs(args), {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running.set(taskId, child);

    const timeout = this.config.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), this.config.timeoutMs)
      : null;

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const reader = createInterface({ input: child.stdout! });
    reader.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const event = parseJsonLine(trimmed);
      if (!event) return;
      rawEvents.push(event);

      if (event.type === 'init' && event.session_id) {
        actualSessionId = event.session_id;
        this.aliasSession(args.sessionId, actualSessionId);
        messages.push({
          type: 'status',
          id: `${taskId}:status`,
          status: 'running',
          timestamp: Date.now(),
        });
      }

      if (event.type === 'message' && event.role === 'assistant' && event.content) {
        content += event.content;
        messages.push({
          type: 'text',
          id: `${taskId}:text:${messages.length}`,
          taskId,
          content: event.content,
          timestamp: Date.now(),
        });
      }

      if (event.type === 'tool_use' && event.tool_id) {
        const tool = event.tool_name || 'tool';
        const input = normalizeGeminiParameters(event.parameters);
        toolInputs.set(event.tool_id, { tool, input });
        messages.push({
          type: 'tool_use',
          id: event.tool_id,
          taskId,
          tool,
          input,
          timestamp: Date.now(),
        });
      }

      if (event.type === 'tool_result' && event.tool_id) {
        const toolInput = toolInputs.get(event.tool_id);
        steps.push({
          tool: toolInput?.tool || 'tool',
          input: toolInput?.input,
          output: formatOutput(event.output),
        });
        messages.push({
          type: 'tool_result',
          id: event.tool_id,
          taskId,
          output: event.output,
          timestamp: Date.now(),
        });
      }

      if (event.type === 'error') {
        messages.push({
          type: 'error',
          id: `${taskId}:error:${messages.length}`,
          taskId,
          content: event.message || event.error?.message || 'Gemini runtime error',
          timestamp: Date.now(),
        });
      }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
      this.running.delete(taskId);
      reader.close();
    });

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `gemini exited with code ${exitCode ?? 'unknown'}`);
    }

    const raw: GeminiTaskRaw = {
      taskId,
      requestedSessionId: args.sessionId,
      actualSessionId,
      content,
      steps,
      rawEvents,
    };

    return {
      id: taskId,
      session: {
        id: actualSessionId || args.sessionId,
        runtime: this.kind,
        resumed: true,
      },
      submittedAt: Date.now(),
      raw,
    };
  }

  async listMessages(args: { sessionId: string }): Promise<GeminiMessage[]> {
    return this.messagesFor(args.sessionId);
  }

  extractToolSnapshots(messages: GeminiMessage[]): ToolCallSnapshot[] {
    const snapshots = new Map<string, ToolCallSnapshot>();
    for (const message of messages) {
      if (message.type === 'tool_use') {
        snapshots.set(message.id, {
          id: message.id,
          tool: message.tool,
          input: message.input,
          finished: false,
        });
      }
      if (message.type === 'tool_result') {
        const existing = snapshots.get(message.id);
        snapshots.set(message.id, {
          id: message.id,
          tool: existing?.tool || 'tool',
          input: existing?.input,
          output: message.output,
          finished: true,
        });
      }
    }
    return [...snapshots.values()];
  }

  buildResult(args: { task: TaskHandle<GeminiTaskRaw>; messages: GeminiMessage[] }): RuntimeTaskResult {
    return {
      taskId: args.task.id,
      sessionId: args.task.raw.actualSessionId || args.task.session.id,
      content: args.task.raw.content,
      steps: args.task.raw.steps,
      raw: args.task.raw,
    };
  }

  async cancelTask(args: { sessionId: string; taskId: string }): Promise<void> {
    this.running.get(args.taskId)?.kill('SIGTERM');
  }

  private messagesFor(sessionId: string): GeminiMessage[] {
    const messages = this.sessions.get(sessionId);
    if (messages) return messages;
    const created: GeminiMessage[] = [];
    this.sessions.set(sessionId, created);
    return created;
  }

  private aliasSession(requestedSessionId: string, actualSessionId: string) {
    if (requestedSessionId === actualSessionId) return;
    const messages = this.messagesFor(requestedSessionId);
    this.sessions.set(actualSessionId, messages);
  }

  private buildArgs(args: RuntimeTaskRequest): string[] {
    const argv = [
      '-p',
      args.prompt,
      '-o',
      'stream-json',
    ];

    if (this.config.yolo !== false) {
      argv.push('--yolo');
    }
    if (args.modelId) {
      argv.push('-m', args.modelId);
    }
    if (args.sessionId && !args.sessionId.startsWith('gemini_')) {
      argv.push('-r', args.sessionId);
    }

    argv.push(...filterCustomArgs(this.config.customArgs || []));
    return argv;
  }
}

function parseJsonLine(line: string): GeminiStreamEvent | null {
  try {
    return JSON.parse(line) as GeminiStreamEvent;
  } catch {
    return null;
  }
}

function normalizeGeminiParameters(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function filterCustomArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (blockedStandaloneArgs.has(arg)) continue;
    if (blockedArgsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}
