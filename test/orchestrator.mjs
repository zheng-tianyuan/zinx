import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryChatStore, MockRuntimeAdapter, streamChatTurn } from '../dist/index.js';

test('streamChatTurn calls before-session and after-session asset hooks in order', async () => {
  const calls = [];
  const adapter = new MockRuntimeAdapter(() => 'ok');
  adapter.prepareRuntimeAssetsBeforeSession = async args => {
    calls.push(['before', args.session?.id ?? null]);
  };
  adapter.prepareRuntimeAssetsAfterSession = async args => {
    calls.push(['after', args.session.id]);
  };

  for await (const _event of streamChatTurn({
    question: 'hello',
    adapter,
    store: new InMemoryChatStore(),
  })) {
    // Drain the stream.
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['before', null]);
  assert.equal(calls[1][0], 'after');
  assert.match(calls[1][1], /^mock_/);
});
