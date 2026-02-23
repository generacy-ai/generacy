/**
 * Unit tests for executeCommand() streaming callbacks.
 *
 * Verifies that:
 * - onStdout callback receives chunks from spawned processes
 * - onStderr callback receives stderr output
 * - Multi-byte UTF-8 characters are not garbled across chunk boundaries
 * - Callbacks are not invoked when not provided (backward compatibility)
 * - Full stdout/stderr strings still accumulated correctly when callbacks are present
 */
import { describe, it, expect, vi } from 'vitest';
import { executeCommand } from '../cli-utils.js';

describe('executeCommand streaming callbacks', () => {
  it('should invoke onStdout with stdout chunks', async () => {
    const chunks: string[] = [];
    const onStdout = vi.fn((chunk: string) => chunks.push(chunk));

    const result = await executeCommand('echo', ['hello world'], {
      onStdout,
    });

    expect(result.exitCode).toBe(0);
    expect(onStdout).toHaveBeenCalled();
    expect(chunks.join('')).toBe('hello world\n');
  });

  it('should invoke onStderr with stderr chunks', async () => {
    const chunks: string[] = [];
    const onStderr = vi.fn((chunk: string) => chunks.push(chunk));

    // Write to stderr via bash -c
    const result = await executeCommand('bash', ['-c', 'echo "error output" >&2'], {
      onStderr,
    });

    expect(result.exitCode).toBe(0);
    expect(onStderr).toHaveBeenCalled();
    expect(chunks.join('')).toBe('error output\n');
  });

  it('should accumulate full stdout string when onStdout callback is present', async () => {
    const onStdout = vi.fn();

    const result = await executeCommand('echo', ['accumulated output'], {
      onStdout,
    });

    expect(result.stdout).toBe('accumulated output\n');
    expect(result.exitCode).toBe(0);
  });

  it('should accumulate full stderr string when onStderr callback is present', async () => {
    const onStderr = vi.fn();

    const result = await executeCommand('bash', ['-c', 'echo "stderr text" >&2'], {
      onStderr,
    });

    expect(result.stderr).toBe('stderr text\n');
    expect(result.exitCode).toBe(0);
  });

  it('should receive both stdout and stderr simultaneously', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await executeCommand(
      'bash',
      ['-c', 'echo "out"; echo "err" >&2'],
      {
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(stdoutChunks.join('')).toBe('out\n');
    expect(stderrChunks.join('')).toBe('err\n');
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
  });

  it('should not invoke callbacks when not provided (backward compatibility)', async () => {
    // Simply verify that executeCommand works without callbacks and doesn't throw
    const result = await executeCommand('echo', ['no callbacks']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('no callbacks\n');
    expect(result.stderr).toBe('');
  });

  it('should handle multi-byte UTF-8 characters correctly', async () => {
    const chunks: string[] = [];
    const onStdout = vi.fn((chunk: string) => chunks.push(chunk));

    // Use printf to emit multi-byte characters (emoji, CJK, accented)
    const testString = 'Hello 🌍 世界 café';
    const result = await executeCommand('printf', ['%s', testString], {
      onStdout,
    });

    expect(result.exitCode).toBe(0);
    expect(onStdout).toHaveBeenCalled();
    const received = chunks.join('');
    expect(received).toBe(testString);
    expect(result.stdout).toBe(testString);
  });

  it('should handle multi-byte UTF-8 across chunk boundaries via StringDecoder', async () => {
    const chunks: string[] = [];
    const onStdout = vi.fn((chunk: string) => chunks.push(chunk));

    // Generate enough output with multi-byte chars that chunks may split mid-character.
    // node:child_process typically delivers 64KB chunks — we generate enough data
    // to force multiple chunks containing multi-byte sequences.
    // Use python to emit a known pattern of multi-byte characters in a controlled way.
    const result = await executeCommand(
      'bash',
      [
        '-c',
        // Emit 1000 repetitions of a string containing multi-byte chars.
        // This creates ~30KB+ of output which may be chunked by the OS pipe buffer.
        'for i in $(seq 1 1000); do printf "café🌍世界\\n"; done',
      ],
      { onStdout },
    );

    expect(result.exitCode).toBe(0);
    expect(onStdout).toHaveBeenCalled();

    // The key assertion: every chunk must be valid UTF-8 (no replacement characters)
    const fullOutput = chunks.join('');
    expect(fullOutput).not.toContain('\uFFFD'); // No Unicode replacement characters

    // Verify the full accumulated string is also correct
    expect(result.stdout).toBe(fullOutput);

    // Verify content integrity — each line should be exactly "café🌍世界"
    const lines = fullOutput.trimEnd().split('\n');
    expect(lines).toHaveLength(1000);
    for (const line of lines) {
      expect(line).toBe('café🌍世界');
    }
  });

  it('should handle large stdout output with callbacks', async () => {
    const chunks: string[] = [];
    const onStdout = vi.fn((chunk: string) => chunks.push(chunk));

    // Generate a large output to ensure multiple data events
    const result = await executeCommand(
      'bash',
      ['-c', 'for i in $(seq 1 5000); do echo "line $i: some padding text here"; done'],
      { onStdout },
    );

    expect(result.exitCode).toBe(0);
    expect(onStdout).toHaveBeenCalled();
    // Multiple chunks should have been received
    expect(chunks.length).toBeGreaterThan(1);
    // Full output should match
    expect(chunks.join('')).toBe(result.stdout);
  });

  it('should handle empty output with callbacks', async () => {
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    const result = await executeCommand('true', [], {
      onStdout,
      onStderr,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    // Callbacks should not be called for empty output
    // (StringDecoder.end() returns '' for empty streams, which is skipped)
    expect(onStdout).not.toHaveBeenCalled();
    expect(onStderr).not.toHaveBeenCalled();
  });

  it('should invoke callbacks for a process that exits with non-zero code', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await executeCommand(
      'bash',
      ['-c', 'echo "partial output"; echo "error info" >&2; exit 1'],
      {
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(stdoutChunks.join('')).toBe('partial output\n');
    expect(stderrChunks.join('')).toBe('error info\n');
    expect(result.stdout).toBe('partial output\n');
    expect(result.stderr).toBe('error info\n');
  });
});
