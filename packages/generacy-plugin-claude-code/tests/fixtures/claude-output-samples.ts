/**
 * Test fixtures for Claude Code JSON output samples.
 */

/**
 * Sample assistant message output.
 */
export const ASSISTANT_MESSAGE = JSON.stringify({
  type: 'assistant',
  content: 'I will help you with that task.',
  timestamp: '2024-01-01T00:00:00.000Z',
});

/**
 * Sample tool use output.
 */
export const TOOL_USE_READ = JSON.stringify({
  type: 'tool_use',
  tool: 'Read',
  input: {
    file_path: '/workspace/src/index.ts',
  },
  timestamp: '2024-01-01T00:00:01.000Z',
});

/**
 * Sample tool result output.
 */
export const TOOL_RESULT_READ = JSON.stringify({
  type: 'tool_result',
  tool: 'Read',
  file: '/workspace/src/index.ts',
  result: {
    content: 'export const hello = "world";',
  },
  timestamp: '2024-01-01T00:00:02.000Z',
});

/**
 * Sample write tool use.
 */
export const TOOL_USE_WRITE = JSON.stringify({
  type: 'tool_use',
  tool: 'Write',
  input: {
    file_path: '/workspace/src/output.ts',
    content: 'export const result = 42;',
  },
  timestamp: '2024-01-01T00:00:03.000Z',
});

/**
 * Sample write tool result.
 */
export const TOOL_RESULT_WRITE = JSON.stringify({
  type: 'tool_result',
  tool: 'Write',
  file: '/workspace/src/output.ts',
  result: {
    success: true,
  },
  timestamp: '2024-01-01T00:00:04.000Z',
});

/**
 * Sample question output.
 */
export const QUESTION_BLOCKING = JSON.stringify({
  type: 'assistant',
  content: 'I need your input to proceed. Which option would you prefer?',
  is_question: true,
  urgency: 'blocking_now',
  choices: ['Option A', 'Option B', 'Option C'],
  timestamp: '2024-01-01T00:00:05.000Z',
});

/**
 * Sample question detected by pattern.
 */
export const QUESTION_PATTERN = JSON.stringify({
  type: 'assistant',
  content: 'Should I create the new file at /workspace/src/new-file.ts?',
  timestamp: '2024-01-01T00:00:06.000Z',
});

/**
 * Sample error output.
 */
export const ERROR_MESSAGE = JSON.stringify({
  type: 'error',
  error: 'Permission denied: cannot write to /etc/passwd',
  timestamp: '2024-01-01T00:00:07.000Z',
});

/**
 * Sample completion result.
 */
export const COMPLETION_SUCCESS = JSON.stringify({
  type: 'result',
  exit_code: 0,
  content: 'Task completed successfully. Created 2 files and modified 3 files.',
  timestamp: '2024-01-01T00:00:08.000Z',
});

/**
 * Sample failed completion.
 */
export const COMPLETION_FAILURE = JSON.stringify({
  type: 'result',
  exit_code: 1,
  content: 'Task failed due to compilation errors.',
  timestamp: '2024-01-01T00:00:09.000Z',
});

/**
 * Sample bash tool use.
 */
export const TOOL_USE_BASH = JSON.stringify({
  type: 'tool_use',
  tool: 'Bash',
  input: {
    command: 'npm test',
    description: 'Run tests',
  },
  timestamp: '2024-01-01T00:00:10.000Z',
});

/**
 * Sample bash tool result.
 */
export const TOOL_RESULT_BASH = JSON.stringify({
  type: 'tool_result',
  tool: 'Bash',
  result: {
    stdout: 'All tests passed',
    stderr: '',
    exitCode: 0,
  },
  timestamp: '2024-01-01T00:00:11.000Z',
});

/**
 * Sample status message.
 */
export const STATUS_MESSAGE = JSON.stringify({
  type: 'status',
  content: 'Processing...',
  timestamp: '2024-01-01T00:00:12.000Z',
});

/**
 * Sample tool result with error.
 */
export const TOOL_RESULT_ERROR = JSON.stringify({
  type: 'tool_result',
  tool: 'Read',
  file: '/workspace/nonexistent.ts',
  result: {
    error: 'File not found',
    success: false,
  },
  timestamp: '2024-01-01T00:00:13.000Z',
});

/**
 * Complete workflow sample - series of outputs simulating a typical invocation.
 */
export const WORKFLOW_SAMPLE = [
  // Initial response
  JSON.stringify({
    type: 'assistant',
    content: "I'll help you create a new TypeScript file.",
    timestamp: '2024-01-01T00:00:00.000Z',
  }),
  // Read existing file
  JSON.stringify({
    type: 'tool_use',
    tool: 'Read',
    input: { file_path: '/workspace/src/index.ts' },
    timestamp: '2024-01-01T00:00:01.000Z',
  }),
  JSON.stringify({
    type: 'tool_result',
    tool: 'Read',
    file: '/workspace/src/index.ts',
    result: { content: 'export const app = {};' },
    timestamp: '2024-01-01T00:00:02.000Z',
  }),
  // Write new file
  JSON.stringify({
    type: 'assistant',
    content: "I'll create the new utility file.",
    timestamp: '2024-01-01T00:00:03.000Z',
  }),
  JSON.stringify({
    type: 'tool_use',
    tool: 'Write',
    input: {
      file_path: '/workspace/src/utils.ts',
      content: 'export const utils = { helper: () => {} };',
    },
    timestamp: '2024-01-01T00:00:04.000Z',
  }),
  JSON.stringify({
    type: 'tool_result',
    tool: 'Write',
    file: '/workspace/src/utils.ts',
    result: { success: true },
    timestamp: '2024-01-01T00:00:05.000Z',
  }),
  // Completion
  JSON.stringify({
    type: 'result',
    exit_code: 0,
    content: 'Created /workspace/src/utils.ts successfully.',
    timestamp: '2024-01-01T00:00:06.000Z',
  }),
];

/**
 * Sample with question in the middle of workflow.
 */
export const WORKFLOW_WITH_QUESTION = [
  JSON.stringify({
    type: 'assistant',
    content: "I'll update the configuration file.",
    timestamp: '2024-01-01T00:00:00.000Z',
  }),
  JSON.stringify({
    type: 'tool_use',
    tool: 'Read',
    input: { file_path: '/workspace/config.json' },
    timestamp: '2024-01-01T00:00:01.000Z',
  }),
  JSON.stringify({
    type: 'tool_result',
    tool: 'Read',
    file: '/workspace/config.json',
    result: { content: '{ "version": "1.0.0" }' },
    timestamp: '2024-01-01T00:00:02.000Z',
  }),
  // Question
  JSON.stringify({
    type: 'assistant',
    content:
      'I found the config file. Should I update the version to 2.0.0 or keep it at 1.0.0?',
    is_question: true,
    urgency: 'blocking_now',
    choices: ['Update to 2.0.0', 'Keep at 1.0.0'],
    timestamp: '2024-01-01T00:00:03.000Z',
  }),
];

/**
 * Sample with error during execution.
 */
export const WORKFLOW_WITH_ERROR = [
  JSON.stringify({
    type: 'assistant',
    content: "I'll try to read the protected file.",
    timestamp: '2024-01-01T00:00:00.000Z',
  }),
  JSON.stringify({
    type: 'tool_use',
    tool: 'Read',
    input: { file_path: '/etc/shadow' },
    timestamp: '2024-01-01T00:00:01.000Z',
  }),
  JSON.stringify({
    type: 'error',
    error: 'Permission denied: cannot read /etc/shadow',
    timestamp: '2024-01-01T00:00:02.000Z',
  }),
  JSON.stringify({
    type: 'result',
    exit_code: 1,
    content: 'Task failed due to permission error.',
    timestamp: '2024-01-01T00:00:03.000Z',
  }),
];

/**
 * Get all samples as an array.
 */
export function getAllSamples(): string[] {
  return [
    ASSISTANT_MESSAGE,
    TOOL_USE_READ,
    TOOL_RESULT_READ,
    TOOL_USE_WRITE,
    TOOL_RESULT_WRITE,
    QUESTION_BLOCKING,
    QUESTION_PATTERN,
    ERROR_MESSAGE,
    COMPLETION_SUCCESS,
    COMPLETION_FAILURE,
    TOOL_USE_BASH,
    TOOL_RESULT_BASH,
    STATUS_MESSAGE,
    TOOL_RESULT_ERROR,
  ];
}
