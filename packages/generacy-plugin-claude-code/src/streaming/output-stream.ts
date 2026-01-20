/**
 * @generacy-ai/generacy-plugin-claude-code
 *
 * Async generator for streaming output from Claude Code.
 */

import type { Readable } from 'stream';
import type { OutputChunk, QuestionPayload } from '../types.js';
import { OutputParser } from './output-parser.js';
import type { OutputStreamOptions } from './types.js';

/**
 * Default stream options.
 */
const DEFAULT_OPTIONS: OutputStreamOptions = {
  includeRaw: false,
  parseTools: true,
};

/**
 * Create an async iterable from a readable stream that yields OutputChunks.
 */
export async function* createOutputStream(
  stdout: Readable,
  stderr?: Readable,
  options: OutputStreamOptions = {}
): AsyncIterable<OutputChunk> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const parser = new OutputParser();

  // Create a combined async iterator from both streams
  const chunks: OutputChunk[] = [];
  let resolveNext: ((value: OutputChunk | null) => void) | null = null;
  let rejectNext: ((error: Error) => void) | null = null;
  let done = false;
  let streamsClosed = 0;
  const totalStreams = stderr ? 2 : 1;

  const pushChunk = (chunk: OutputChunk) => {
    if (resolveNext) {
      resolveNext(chunk);
      resolveNext = null;
      rejectNext = null;
    } else {
      chunks.push(chunk);
    }
  };

  const handleData = (data: Buffer | string, isStderr: boolean) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');

    if (isStderr && !opts.includeRaw) {
      // Parse stderr as potential error
      pushChunk(parser.createStderrChunk(text));
    } else {
      // Parse stdout as JSON Lines
      const parsed = parser.parseChunk(text);
      for (const chunk of parsed) {
        pushChunk(chunk);
      }
    }
  };

  const handleEnd = () => {
    streamsClosed++;
    if (streamsClosed >= totalStreams) {
      // Flush any remaining buffered content
      const remaining = parser.flush();
      for (const chunk of remaining) {
        pushChunk(chunk);
      }

      done = true;
      if (resolveNext) {
        resolveNext(null);
        resolveNext = null;
      }
    }
  };

  const handleError = (error: Error) => {
    if (rejectNext) {
      rejectNext(error);
      resolveNext = null;
      rejectNext = null;
    } else {
      pushChunk(parser.createErrorChunk(error.message));
    }
    done = true;
  };

  // Attach listeners
  stdout.on('data', (data) => handleData(data, false));
  stdout.on('end', handleEnd);
  stdout.on('error', handleError);

  if (stderr) {
    stderr.on('data', (data) => handleData(data, true));
    stderr.on('end', handleEnd);
    stderr.on('error', handleError);
  }

  // Yield chunks as they arrive
  while (!done || chunks.length > 0) {
    if (chunks.length > 0) {
      yield chunks.shift()!;
    } else if (!done) {
      const chunk = await new Promise<OutputChunk | null>((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });

      if (chunk === null) {
        break;
      }

      yield chunk;
    }
  }
}

/**
 * Create an output stream from raw data (for testing or replay).
 */
export async function* createOutputStreamFromData(
  data: string[],
  _options: OutputStreamOptions = {}
): AsyncIterable<OutputChunk> {
  const parser = new OutputParser();

  for (const line of data) {
    const chunks = parser.parseChunk(line + '\n');
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  const remaining = parser.flush();
  for (const chunk of remaining) {
    yield chunk;
  }
}

/**
 * Collect all chunks from an output stream into an array.
 */
export async function collectOutputChunks(
  stream: AsyncIterable<OutputChunk>
): Promise<OutputChunk[]> {
  const chunks: OutputChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Find the first question chunk in a stream.
 * Yields all chunks until a question is found, then returns the question.
 */
export async function findQuestion(
  stream: AsyncIterable<OutputChunk>
): Promise<{
  question: QuestionPayload | null;
  chunks: OutputChunk[];
}> {
  const chunks: OutputChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);

    if (chunk.type === 'question') {
      return {
        question: chunk.data as QuestionPayload,
        chunks,
      };
    }
  }

  return {
    question: null,
    chunks,
  };
}

/**
 * Filter chunks by type.
 */
export async function* filterChunksByType(
  stream: AsyncIterable<OutputChunk>,
  types: OutputChunk['type'][]
): AsyncIterable<OutputChunk> {
  for await (const chunk of stream) {
    if (types.includes(chunk.type)) {
      yield chunk;
    }
  }
}

/**
 * Wait for a completion chunk.
 * Returns all chunks and the completion result.
 */
export async function waitForCompletion(
  stream: AsyncIterable<OutputChunk>,
  options: { timeout?: number } = {}
): Promise<{
  completed: boolean;
  exitCode?: number;
  chunks: OutputChunk[];
  error?: Error;
}> {
  const chunks: OutputChunk[] = [];
  const timeout = options.timeout ?? 0;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeoutPromise = timeout > 0
    ? new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Stream timed out after ${timeout}ms`));
        }, timeout);
      })
    : null;

  try {
    const iteratorPromise = (async () => {
      for await (const chunk of stream) {
        if (timedOut) break;

        chunks.push(chunk);

        if (chunk.type === 'complete') {
          const data = chunk.data as { exitCode?: number };
          return {
            completed: true,
            exitCode: data.exitCode,
            chunks,
          };
        }

        if (chunk.type === 'error') {
          const data = chunk.data as { message?: string };
          return {
            completed: false,
            chunks,
            error: new Error(data.message ?? 'Unknown error'),
          };
        }
      }

      return {
        completed: false,
        chunks,
      };
    })();

    if (timeoutPromise) {
      return await Promise.race([
        iteratorPromise,
        timeoutPromise.then(() => ({
          completed: false,
          chunks,
          error: new Error(`Stream timed out after ${timeout}ms`),
        })),
      ]) as { completed: boolean; exitCode?: number; chunks: OutputChunk[]; error?: Error };
    }

    return await iteratorPromise;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
