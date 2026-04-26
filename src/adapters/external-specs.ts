export type ExternalRuntimeMinSpec = {
  runtime: 'cursor' | 'codex';
  requiredCapabilities: Array<'sendTask' | 'listMessages' | 'resumeSession'>;
  optionalCapabilities: Array<'toolStreaming' | 'sessionCreate' | 'cancelTask' | 'memoryHints'>;
  degradationStrategy: string[];
};

export const cursorRuntimeMinSpec: ExternalRuntimeMinSpec = {
  runtime: 'cursor',
  requiredCapabilities: ['sendTask', 'listMessages', 'resumeSession'],
  optionalCapabilities: ['toolStreaming', 'sessionCreate', 'cancelTask', 'memoryHints'],
  degradationStrategy: [
    'If Cursor only returns final text, emit final_text without step events.',
    'If Cursor cannot create an explicit session, map the product chat id to runtimeSessionId.',
    'If tool results are unavailable, preserve the transcript and normalized final answer only.',
  ],
};

export const codexRuntimeMinSpec: ExternalRuntimeMinSpec = {
  runtime: 'codex',
  requiredCapabilities: ['sendTask', 'listMessages', 'resumeSession'],
  optionalCapabilities: ['toolStreaming', 'sessionCreate', 'cancelTask', 'memoryHints'],
  degradationStrategy: [
    'If Codex exposes one-shot execution, replay the completed transcript as normalized events.',
    'If Codex task id is the only stable identifier, use it as runtimeSessionId.',
    'If native memory hooks are absent, use MemoryProvider recall and prompt injection.',
  ],
};
