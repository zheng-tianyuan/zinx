# zinx

`zinx` is a runtime-agnostic SDK for connecting product chat APIs to different coding agents and memory providers.

It is designed around two layers:

- A low-level `RuntimeAdapter` for agents such as OpenCode, Cursor, Codex, or custom runtimes.
- A high-level chat/task orchestrator that normalizes sessions, tool steps, memory recall evidence, and final answers.

## Why

Different coding agents expose different session models, message shapes, tool logs, and streaming behavior. `zinx` keeps those differences behind adapters so product code can consume one event stream.

Memory, skills, and MCP are intentionally handled as sidecar providers. The orchestrator supports both explicit SDK recall and native runtime integrations, so portable runtimes can use prompt injection while runtimes such as OpenCode can use a faster plugin path.

## Install

```bash
npm install zinx
```

## Basic Usage

```ts
import {
  InMemoryChatStore,
  MockRuntimeAdapter,
  streamChatTurn,
} from 'zinx';

const adapter = new MockRuntimeAdapter();
const store = new InMemoryChatStore();

for await (const event of streamChatTurn({
  question: 'Explain how this service handles retries',
  adapter,
  store,
  timeoutMs: 20 * 60 * 1000,
})) {
  console.log(event);
}
```

Pass `signal` when the host app needs to cancel a turn. The orchestrator forwards the signal to adapters that support abortable execution and emits an `error` event if the runtime aborts or times out.

## OpenCode Adapter

```ts
import { OpenCodeRuntimeAdapter } from 'zinx';

const adapter = new OpenCodeRuntimeAdapter({
  baseUrl: 'http://127.0.0.1:4096',
  directory: '/path/to/repositories',
  providerId: 'your-provider-id',
  defaultModelId: 'your-model-id',
});
```

`zinx` does not ship credentials. Pass endpoint URLs, model ids, and API keys from your own application configuration.

## Gemini Adapter

`GeminiRuntimeAdapter` wraps the Gemini CLI stream-json mode and normalizes text, tool calls, tool results, and cancellation.

```ts
import { GeminiRuntimeAdapter } from 'zinx';

const adapter = new GeminiRuntimeAdapter({
  executable: 'gemini',
  cwd: '/path/to/repositories',
  timeoutMs: 20 * 60 * 1000,
});
```

The adapter runs `gemini -p <prompt> -o stream-json --yolo` by default. Credentials and model access stay in your own Gemini CLI environment.

## OpenViking Memory Provider

```ts
import { OpenVikingMemoryProvider } from 'zinx';

const memoryProvider = new OpenVikingMemoryProvider({
  endpoint: 'http://127.0.0.1:1933',
  apiKey: '<openviking-api-key>',
});
```

The orchestrator calls `memoryProvider.recall()` before sending a task to the runtime. Recalled memories are emitted as a `memory_recalled` event and passed into the prompt builder.

## Memory Modes

`zinx` supports four memory modes:

- `auto`: use native runtime memory when the adapter can provide evidence, otherwise fall back to explicit SDK recall.
- `explicit`: call `MemoryProvider.recall()` before the task and inject memories into the prompt.
- `native`: rely on the runtime's native memory integration, such as an agent plugin.
- `off`: do not use memory.

```ts
for await (const event of streamChatTurn({
  question: 'What should I check first for this alert?',
  adapter,
  store,
  memory: {
    mode: 'auto',
    provider: memoryProvider,
    recallLimit: 8,
  },
})) {
  console.log(event);
}
```

For native memory evidence, adapters can implement `readNativeMemoryEvidence()`. The OpenCode adapter accepts a `readNativeMemoryEvidence` callback so applications can bridge their own plugin state or logs without coupling `zinx` to a specific local file layout.

## MCP Providers

MCP is also abstracted behind a provider interface. Product code can list tools and resources once, then let each runtime decide whether to mount MCP natively or receive a rendered manifest in the prompt.

```ts
import {
  StaticMcpProvider,
  buildMcpManifest,
  renderMcpManifestForPrompt,
} from 'zinx';

const mcpProvider = new StaticMcpProvider({
  servers: [{ id: 'docs', name: 'Documentation MCP', transport: 'http' }],
  tools: [{
    id: 'docs.search',
    name: 'search_docs',
    description: 'Search internal documentation.',
    server: { id: 'docs' },
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
});

const manifest = await buildMcpManifest({ provider: mcpProvider });
const promptTools = renderMcpManifestForPrompt(manifest);
```

`streamChatTurn()` can do this automatically:

```ts
for await (const event of streamChatTurn({
  question: 'Compare this release with our integration code',
  adapter,
  store,
  mcp: {
    mode: 'auto',
    provider: mcpProvider,
  },
})) {
  console.log(event);
}
```

MCP modes:

- `auto`: use native runtime MCP when available, otherwise render a manifest into the prompt.
- `native`: rely on the runtime to mount MCP servers directly.
- `manifest`: render MCP tools/resources into the prompt.
- `off`: do not use MCP.

Recommended runtime behavior:

- OpenCode or other runtimes with native MCP support can mount the MCP server directly.
- Cursor/Codex or runtimes without native MCP support can receive `renderMcpManifestForPrompt()` output as a tool manifest.
- Product code should depend on `McpProvider`, not on any one runtime's MCP config format.

## Skill Providers

Skills follow the same provider pattern as MCP. They are portable `SkillBundle` objects that can be mounted natively by a runtime or rendered into the prompt for runtimes without native skill support.

```ts
import { StaticSkillProvider, streamChatTurn } from 'zinx';

const skillProvider = new StaticSkillProvider({
  skills: [{
    name: 'release-impact-review',
    description: 'Analyze upstream release notes against a local integration.',
    trigger: 'Use when the user asks what a dependency release changes for their codebase.',
    content: 'Read the release notes, inspect integration code, and summarize behavior changes and risks.',
  }],
});

for await (const event of streamChatTurn({
  question: 'What does the new TON release change for global-scan?',
  adapter,
  store,
  skills: {
    mode: 'auto',
    provider: skillProvider,
  },
})) {
  console.log(event);
}
```

Skill modes:

- `auto`: use native runtime skills when available, otherwise inject skills into the prompt.
- `native`: rely on the runtime's skill loader.
- `prompt`: render skill instructions into the prompt.
- `off`: do not use skills.

## Core Events

- `session_bound`
- `memory_recalled`
- `step_started`
- `step_finished`
- `partial_text`
- `final_text`
- `error`

## Runtime Asset Hooks

Adapters that need runtime assets such as MCP servers or skill manifests can prepare them in two phases:

```ts
const adapter = {
  // ...RuntimeAdapter implementation
  async prepareRuntimeAssetsBeforeSession(args) {
    // Called before createSession/resumeSession. Use this for runtimes that
    // need MCP/skill config available during session initialization.
  },
  async prepareRuntimeAssetsAfterSession(args) {
    // Called after the real runtime session id is known.
  },
};
```

Existing adapters can continue implementing `prepareRuntimeAssets()`. `zinx` still calls that legacy hook in the same before/after positions for backwards compatibility.

## Task Runner

`runAgentTask()` wraps `streamChatTurn()` for durable task systems. It now treats runtime `error` events and empty final output as failed tasks, which keeps worker queues from marking failed agents as successful.

```ts
import { runAgentTask } from 'zinx';

const result = await runAgentTask({
  task: {
    id: 'task_1',
    type: 'custom',
    title: 'Review requirement',
    prompt: 'Create a design proposal for this requirement.',
  },
  adapter,
  store,
  timeoutMs: 30 * 60 * 1000,
  shouldCancel: async () => false,
});
```

## Status

This package currently includes:

- Core runtime and memory interfaces.
- A generic chat/task orchestrator.
- A self-contained OpenCode HTTP adapter.
- A Gemini CLI adapter.
- A generic OpenViking HTTP memory provider.
- Generic MCP provider types, manifest helpers, and a static MCP provider.
- Generic skill provider types, manifest helpers, and a static skill provider.
- An in-memory store for tests and examples.
- Cursor and Codex minimum capability specs.

Cursor and Codex adapters should be implemented as thin runtime clients on top of the same `RuntimeAdapter` interface.
