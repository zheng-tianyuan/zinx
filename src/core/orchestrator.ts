import type {
  AgentEvent,
  AgentRuntimeKind,
  ChatStore,
  McpManifest,
  McpMode,
  McpProvider,
  MemoryMode,
  MemoryProvider,
  MemoryRecallEvidence,
  RuntimeAdapter,
  SessionBinding,
  SkillManifest,
  SkillMode,
  SkillProvider,
  ToolCallSnapshot,
} from './types.js';
import { buildMcpManifest, renderMcpManifestForPrompt } from './mcp.js';
import { buildSkillManifest, renderSkillManifestForPrompt } from './skills.js';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function makeBinding(args: {
  chatSessionId: string;
  runtimeKind: AgentRuntimeKind;
  runtimeSessionId: string;
  memoryProvider?: string;
  memorySessionId?: string;
}): SessionBinding {
  return {
    productSessionId: args.chatSessionId,
    runtimeKind: args.runtimeKind,
    runtimeSessionId: args.runtimeSessionId,
    memoryProvider: args.memoryProvider,
    memorySessionId: args.memorySessionId,
  };
}

function diffToolEvents(args: {
  snapshots: ToolCallSnapshot[];
  seenStarts: Set<string>;
  seenEnds: Set<string>;
  outputLimit: number;
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const snapshot of args.snapshots) {
    if (!args.seenStarts.has(snapshot.id)) {
      args.seenStarts.add(snapshot.id);
      events.push({
        type: 'step_started',
        stepId: snapshot.id,
        tool: snapshot.tool,
        input: snapshot.input,
      });
    }
    if (snapshot.finished && !args.seenEnds.has(snapshot.id)) {
      args.seenEnds.add(snapshot.id);
      events.push({
        type: 'step_finished',
        stepId: snapshot.id,
        tool: snapshot.tool,
        output: formatToolOutput(snapshot.output).slice(0, args.outputLimit),
      });
    }
  }
  return events;
}

function resolveMemoryMode(args: {
  mode: MemoryMode;
  hasProvider: boolean;
  hasNativeEvidenceReader: boolean;
  supportsNativeMemory: boolean;
}): MemoryMode {
  if (args.mode !== 'auto') return args.mode;
  if (args.supportsNativeMemory && args.hasNativeEvidenceReader) return 'native';
  if (args.hasProvider) return 'explicit';
  return 'off';
}

function resolveSkillMode(args: {
  mode: SkillMode;
  hasProvider: boolean;
  supportsNativeSkills: boolean;
}): SkillMode {
  if (args.mode !== 'auto') return args.mode;
  if (args.supportsNativeSkills) return 'native';
  if (args.hasProvider) return 'prompt';
  return 'off';
}

function resolveMcpMode(args: {
  mode: McpMode;
  hasProvider: boolean;
  supportsNativeMcp: boolean;
}): McpMode {
  if (args.mode !== 'auto') return args.mode;
  if (args.supportsNativeMcp) return 'native';
  if (args.hasProvider) return 'manifest';
  return 'off';
}

export function defaultPromptBuilder(args: {
  question: string;
  memories: MemoryRecallEvidence | null;
  skills?: SkillManifest | null;
  mcp?: McpManifest | null;
}): string {
  const memoryText = args.memories?.memories.length
    ? [
      'Relevant memory evidence:',
      ...args.memories.memories.map((memory, index) => [
        `${index + 1}. ${memory.title || memory.uri}`,
        memory.abstract ? `Abstract: ${memory.abstract}` : '',
        memory.content ? `Content: ${memory.content}` : '',
      ].filter(Boolean).join('\n')),
      '',
    ].join('\n')
    : '';

  const skillText = args.skills?.skills.length
    ? [
      'Runtime skills:',
      renderSkillManifestForPrompt(args.skills),
      '',
    ].join('\n')
    : '';

  const mcpText = args.mcp && (args.mcp.tools.length > 0 || args.mcp.resources.length > 0)
    ? [
      'MCP capabilities:',
      renderMcpManifestForPrompt(args.mcp),
      '',
    ].join('\n')
    : '';

  return [
    memoryText,
    skillText,
    mcpText,
    'User question:',
    args.question,
  ].filter(Boolean).join('\n');
}

export async function* streamChatTurn<TRawMessage, TRawTask>(args: {
  question: string;
  adapter: RuntimeAdapter<TRawMessage, TRawTask>;
  store: ChatStore;
  modelId?: string;
  memoryProvider?: MemoryProvider;
  memory?: {
    mode?: MemoryMode;
    provider?: MemoryProvider;
    recallLimit?: number;
    targetUri?: string;
  };
  skills?: {
    mode?: SkillMode;
    provider?: SkillProvider;
    names?: string[];
  };
  mcp?: {
    mode?: McpMode;
    provider?: McpProvider;
    serverId?: string;
  };
  chatSessionId?: string;
  requestedRuntimeSessionId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  recallLimit?: number;
  pollIntervalMs?: number;
  toolOutputLimit?: number;
  buildPrompt?: (args: {
    question: string;
    memories: MemoryRecallEvidence | null;
    skills: SkillManifest | null;
    mcp: McpManifest | null;
    binding: SessionBinding;
  }) => string;
}): AsyncGenerator<AgentEvent> {
  let persistedSessionId: string | undefined;

  try {
    const session = await args.store.ensureSession({
      chatSessionId: args.chatSessionId,
      title: args.title || args.question,
      metadata: args.metadata,
    });
    persistedSessionId = session.id;

    await args.store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: args.question,
      metadata: args.metadata,
    });

    const existingBinding = await args.store.getSessionBinding(session.id);
    const runtimeSessionId = args.requestedRuntimeSessionId || existingBinding?.runtimeSessionId;
    const runtimeSession = runtimeSessionId
      ? await args.adapter.resumeSession({ sessionId: runtimeSessionId })
      : await args.adapter.createSession({ title: args.title || args.question, metadata: args.metadata });
    const memoryProvider = args.memory?.provider || args.memoryProvider;

    let binding = makeBinding({
      chatSessionId: session.id,
      runtimeKind: args.adapter.kind,
      runtimeSessionId: runtimeSession.id,
      memoryProvider: existingBinding?.memoryProvider,
      memorySessionId: existingBinding?.memorySessionId,
    });

    if (memoryProvider) {
      binding = await memoryProvider.bindSession(binding);
    }

    await args.store.updateBinding({
      sessionId: session.id,
      runtimeKind: args.adapter.kind,
      runtimeSessionId: runtimeSession.id,
      memoryProvider: binding.memoryProvider,
      memorySessionId: binding.memorySessionId,
      status: 'active',
    });

    yield { type: 'session_bound', binding };
    yield {
      type: 'log',
      message: runtimeSession.resumed
        ? `Reused runtime session ${runtimeSession.id}`
        : `Created runtime session ${runtimeSession.id}`,
    };

    const capabilities = args.adapter.capabilities();
    const requestedMemoryMode = args.memory?.mode || (memoryProvider ? 'explicit' : 'off');
    const effectiveMemoryMode = resolveMemoryMode({
      mode: requestedMemoryMode,
      hasProvider: Boolean(memoryProvider),
      hasNativeEvidenceReader: Boolean(args.adapter.readNativeMemoryEvidence),
      supportsNativeMemory: capabilities.nativeMemoryIntegration,
    });

    const requestedSkillMode = args.skills?.mode || (args.skills?.provider ? 'auto' : 'off');
    const effectiveSkillMode = resolveSkillMode({
      mode: requestedSkillMode,
      hasProvider: Boolean(args.skills?.provider),
      supportsNativeSkills: Boolean(capabilities.nativeSkillIntegration),
    });

    const requestedMcpMode = args.mcp?.mode || (args.mcp?.provider ? 'auto' : 'off');
    const effectiveMcpMode = resolveMcpMode({
      mode: requestedMcpMode,
      hasProvider: Boolean(args.mcp?.provider),
      supportsNativeMcp: Boolean(capabilities.nativeMcpIntegration),
    });

    if (requestedMemoryMode === 'native' && effectiveMemoryMode === 'native') {
      yield { type: 'log', message: 'Using native runtime memory integration.' };
    }

    const memories = effectiveMemoryMode === 'explicit' && memoryProvider
      ? await memoryProvider.recall({
        query: args.question,
        session: binding,
        limit: args.memory?.recallLimit ?? args.recallLimit,
        targetUri: args.memory?.targetUri,
        metadata: args.metadata,
      })
      : null;

    if (memories && memories.count > 0) {
      yield { type: 'memory_recalled', evidence: memories };
    }

    const skillManifest = effectiveSkillMode !== 'off' && args.skills?.provider
      ? await buildSkillManifest({
        provider: args.skills.provider,
        names: args.skills.names,
        metadata: args.metadata,
      })
      : null;

    const mcpManifest = effectiveMcpMode !== 'off' && args.mcp?.provider
      ? await buildMcpManifest({
        provider: args.mcp.provider,
        serverId: args.mcp.serverId,
        metadata: args.metadata,
      })
      : null;

    if (args.adapter.prepareRuntimeAssets) {
      await args.adapter.prepareRuntimeAssets({
        session: runtimeSession,
        skills: skillManifest,
        mcp: mcpManifest,
        skillMode: effectiveSkillMode,
        mcpMode: effectiveMcpMode,
        metadata: args.metadata,
      });
    }

    const promptSkills = effectiveSkillMode === 'prompt' ? skillManifest : null;
    const promptMcp = effectiveMcpMode === 'manifest' ? mcpManifest : null;
    const prompt = args.buildPrompt
      ? args.buildPrompt({ question: args.question, memories, skills: promptSkills, mcp: promptMcp, binding })
      : defaultPromptBuilder({ question: args.question, memories, skills: promptSkills, mcp: promptMcp });

    yield { type: 'progress', phase: 'Runtime is processing the task...' };

    const seenStarts = new Set<string>();
    const seenEnds = new Set<string>();
    const historicalMessages = await args.adapter.listMessages({
      sessionId: runtimeSession.id,
    }).catch(() => [] as TRawMessage[]);

    for (const snapshot of args.adapter.extractToolSnapshots(historicalMessages)) {
      seenStarts.add(snapshot.id);
      if (snapshot.finished) seenEnds.add(snapshot.id);
    }

    const startedAt = Date.now();
    const sendPromise = args.adapter.sendTask({
      sessionId: runtimeSession.id,
      modelId: args.modelId,
      prompt,
      metadata: args.metadata,
    });

    let task: Awaited<typeof sendPromise> | null = null;
    let sendError: unknown = null;

    void sendPromise.then(
      value => { task = value; },
      error => { sendError = error; },
    );

    while (!task && !sendError) {
      const polledMessages = await args.adapter.listMessages({
        sessionId: runtimeSession.id,
      }).catch(() => [] as TRawMessage[]);
      const events = diffToolEvents({
        snapshots: args.adapter.extractToolSnapshots(polledMessages),
        seenStarts,
        seenEnds,
        outputLimit: args.toolOutputLimit ?? 600,
      });
      for (const event of events) yield event;
      yield {
        type: 'progress',
        phase: events.length > 0 ? 'Runtime is executing tools...' : 'Runtime is reading context...',
        elapsedMs: Date.now() - startedAt,
      };
      await sleep(args.pollIntervalMs ?? 1200);
    }

    if (sendError) throw sendError;

    const finalMessages = await args.adapter.listMessages({ sessionId: runtimeSession.id });
    const finalEvents = diffToolEvents({
      snapshots: args.adapter.extractToolSnapshots(finalMessages),
      seenStarts,
      seenEnds,
      outputLimit: args.toolOutputLimit ?? 600,
    });
    for (const event of finalEvents) yield event;

    const result = args.adapter.buildResult({ task: task!, messages: finalMessages });
    const nativeMemories = effectiveMemoryMode === 'native' && args.adapter.readNativeMemoryEvidence
      ? await args.adapter.readNativeMemoryEvidence({
        sessionId: runtimeSession.id,
        task: task!,
        messages: finalMessages,
        query: args.question,
        startedAt,
      })
      : null;
    if (nativeMemories && nativeMemories.count > 0) {
      yield { type: 'memory_recalled', evidence: nativeMemories };
    }

    const assistantMessage = await args.store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: result.content,
      toolSteps: result.steps,
      metadata: args.metadata,
    });

    await args.store.updateBinding({
      sessionId: session.id,
      runtimeKind: args.adapter.kind,
      runtimeSessionId: result.sessionId,
      memoryProvider: binding.memoryProvider,
      memorySessionId: binding.memorySessionId,
      status: 'active',
    });

    yield {
      type: 'final_text',
      content: result.content,
      sessionId: result.sessionId,
      chatSessionId: session.id,
      messageId: assistantMessage.id,
    };
  } catch (error) {
    if (persistedSessionId) {
      await args.store.updateBinding({
        sessionId: persistedSessionId,
        status: 'failed',
      }).catch(() => undefined);
    }
    yield {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
