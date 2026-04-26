# zinx

`zinx` is a runtime-agnostic SDK for connecting product chat APIs to different coding agents and memory providers.

It is designed around two layers:

- A low-level `RuntimeAdapter` for agents such as OpenCode, Cursor, Codex, or custom runtimes.
- A high-level chat/task orchestrator that normalizes sessions, tool steps, memory recall evidence, and final answers.

## Why

Different coding agents expose different session models, message shapes, tool logs, and streaming behavior. `zinx` keeps those differences behind adapters so product code can consume one event stream.

Memory is intentionally handled as a sidecar provider. The orchestrator can explicitly recall memories before a task and inject them into the prompt, while runtimes with native memory plugins can still expose their own evidence through adapter capabilities.

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
})) {
  console.log(event);
}
```

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

## OpenViking Memory Provider

```ts
import { OpenVikingMemoryProvider } from 'zinx';

const memoryProvider = new OpenVikingMemoryProvider({
  endpoint: 'http://127.0.0.1:1933',
  apiKey: '<openviking-api-key>',
});
```

The orchestrator calls `memoryProvider.recall()` before sending a task to the runtime. Recalled memories are emitted as a `memory_recalled` event and passed into the prompt builder.

## Core Events

- `session_bound`
- `memory_recalled`
- `step_started`
- `step_finished`
- `partial_text`
- `final_text`
- `error`

## Status

This package currently includes:

- Core runtime and memory interfaces.
- A generic chat/task orchestrator.
- A self-contained OpenCode HTTP adapter.
- A generic OpenViking HTTP memory provider.
- An in-memory store for tests and examples.
- Cursor and Codex minimum capability specs.

Cursor and Codex adapters should be implemented as thin runtime clients on top of the same `RuntimeAdapter` interface.
