import type {
  AgentEvent,
  AgentTaskLifecycleEvent,
  AgentTaskRuntimeContext,
  AgentTaskSink,
  AgentTaskSpec,
  AgentTaskStatus,
  ChatStore,
  McpProvider,
  MemoryProvider,
  RuntimeAdapter,
  SkillProvider,
} from './types.js';
import { streamChatTurn } from './orchestrator.js';

export type RunAgentTaskArgs<TRawMessage, TRawTask> = {
  task: AgentTaskSpec;
  adapter: RuntimeAdapter<TRawMessage, TRawTask>;
  store: ChatStore;
  sink?: AgentTaskSink;
  memory?: {
    provider?: MemoryProvider;
    mode?: 'auto' | 'explicit' | 'native' | 'off';
  };
  skills?: {
    provider?: SkillProvider;
    mode?: 'auto' | 'native' | 'prompt' | 'off';
  };
  mcp?: {
    provider?: McpProvider;
    mode?: 'auto' | 'native' | 'manifest' | 'off';
  };
  buildPrompt?: (task: AgentTaskSpec) => string;
  shouldCancel?: () => boolean | Promise<boolean>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function runAgentTask<TRawMessage, TRawTask>(args: RunAgentTaskArgs<TRawMessage, TRawTask>): Promise<{
  status: AgentTaskStatus;
  content: string;
  runtimeSessionId?: string;
}> {
  const startedAt = Date.now();
  const context: AgentTaskRuntimeContext = {
    task: args.task,
    status: 'running',
    startedAt,
    metadata: args.task.metadata,
  };

  await args.sink?.onStatus?.('running', context);

  let content = '';
  let runtimeSessionId: string | undefined;
  let runtimeError: string | null = null;
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  args.signal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = args.timeoutMs ? setTimeout(() => controller.abort(), args.timeoutMs) : undefined;

  try {
    for await (const event of streamChatTurn({
      question: args.buildPrompt ? args.buildPrompt(args.task) : args.task.prompt,
      adapter: args.adapter,
      store: args.store,
      modelId: args.task.modelId,
      memory: args.memory?.provider ? {
        mode: args.memory.mode || 'auto',
        provider: args.memory.provider,
      } : undefined,
      skills: args.skills?.provider ? {
        mode: args.skills.mode || 'auto',
        provider: args.skills.provider,
      } : undefined,
      mcp: args.mcp?.provider ? {
        mode: args.mcp.mode || 'auto',
        provider: args.mcp.provider,
      } : undefined,
      title: args.task.title,
      metadata: args.task.metadata,
      timeoutMs: args.timeoutMs,
      signal: controller.signal,
      buildPrompt: args.buildPrompt ? () => args.buildPrompt!(args.task) : undefined,
    })) {
      if (await args.shouldCancel?.()) {
        controller.abort();
        await args.sink?.onStatus?.('cancelled', { ...context, status: 'cancelled' });
        return { status: 'cancelled', content, runtimeSessionId };
      }

      if (event.type === 'final_text') {
        content = event.content;
        runtimeSessionId = event.sessionId;
      }
      if (event.type === 'error') {
        runtimeError = event.message;
      }

      await args.sink?.onEvent?.(mapAgentEvent(event), context);
    }

    if (runtimeError) {
      throw new Error(runtimeError);
    }
    if (!content.trim()) {
      throw new Error('Agent returned empty output.');
    }

    await args.sink?.onArtifact?.({
      type: 'markdown',
      title: 'Agent output',
      content,
      metadata: { runtimeSessionId },
    }, context);
    await args.sink?.onStatus?.('succeeded', { ...context, status: 'succeeded' });
    return { status: 'succeeded', content, runtimeSessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await args.sink?.onEvent?.({ type: 'error', message, data: { error: message } }, context);
    await args.sink?.onStatus?.('failed', { ...context, status: 'failed' });
    return { status: 'failed', content: message, runtimeSessionId };
  } finally {
    if (timeout) clearTimeout(timeout);
    args.signal?.removeEventListener('abort', abortFromExternal);
  }
}

export function mapAgentEvent(event: AgentEvent): AgentTaskLifecycleEvent {
  switch (event.type) {
    case 'log':
      return { type: 'log', message: event.message, data: event };
    case 'progress':
      return { type: 'progress', message: event.phase, data: event, elapsedMs: event.elapsedMs };
    case 'step_started':
      return { type: 'step_started', message: `Started ${event.tool}`, data: event };
    case 'step_finished':
      return { type: 'step_finished', message: `Finished ${event.tool}`, data: event };
    case 'partial_text':
      return { type: 'partial_text', message: event.content, data: event };
    case 'final_text':
      return { type: 'final_text', message: event.content, data: event };
    case 'error':
      return { type: 'error', message: event.message, data: event };
    case 'session_bound':
      return { type: 'log', message: `Session bound: ${event.binding.runtimeSessionId || event.binding.productSessionId}`, data: event };
    case 'memory_recalled':
      return { type: 'log', message: `Memory recalled: ${event.evidence.count}`, data: event };
  }
}
