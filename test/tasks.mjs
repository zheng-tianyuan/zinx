import assert from 'node:assert/strict';
import test from 'node:test';

import { MockRuntimeAdapter, InMemoryChatStore, runAgentTask } from '../dist/index.js';

function task(overrides = {}) {
  return {
    id: 'task_1',
    type: 'custom',
    title: 'Test task',
    prompt: 'Say hello',
    ...overrides,
  };
}

test('runAgentTask fails when the runtime returns empty output', async () => {
  const events = [];
  const result = await runAgentTask({
    task: task(),
    adapter: new MockRuntimeAdapter(() => ''),
    store: new InMemoryChatStore(),
    sink: {
      onEvent: event => events.push(event),
    },
  });

  assert.equal(result.status, 'failed');
  assert.match(result.content, /empty output/i);
  assert.equal(events.at(-1)?.type, 'error');
});

test('runAgentTask succeeds and emits an artifact for non-empty output', async () => {
  const artifacts = [];
  const result = await runAgentTask({
    task: task(),
    adapter: new MockRuntimeAdapter(() => 'done'),
    store: new InMemoryChatStore(),
    sink: {
      onArtifact: artifact => artifacts.push(artifact),
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.content, 'done');
  assert.equal(artifacts[0]?.content, 'done');
});
