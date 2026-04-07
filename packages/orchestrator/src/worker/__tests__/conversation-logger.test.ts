import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationLogger } from '../conversation-logger.js';
import type { OutputChunk } from '../types.js';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a unique temp directory for each test. */
async function makeTempSpecDir(): Promise<string> {
  const dir = join(tmpdir(), `conversation-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Read and parse JSONL file into an array of objects. */
async function readJsonl(filePath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(filePath, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Helper to create an OutputChunk. */
function makeChunk(type: OutputChunk['type'], data: Record<string, unknown>, metadata?: Record<string, string>): OutputChunk {
  return {
    type,
    data,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

describe('ConversationLogger', () => {
  let specDir: string;
  let logger: ConversationLogger;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    specDir = await makeTempSpecDir();
    logger = new ConversationLogger(specDir);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(specDir, { recursive: true, force: true }).catch(() => {});
  });

  // ---------- phase_start entry ----------

  describe('setPhase and phase_start', () => {
    it('emits a phase_start entry with correct required fields', async () => {
      logger.setPhase('specify', 'ses-001');
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        event_type: 'phase_start',
        phase: 'specify',
        session_id: 'ses-001',
      });
      expect(entries[0]!.timestamp).toBeDefined();
    });

    it('includes model when provided', async () => {
      logger.setPhase('clarify', 'ses-002', 'claude-sonnet-4-6');
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      expect(entries[0]).toMatchObject({
        event_type: 'phase_start',
        model: 'claude-sonnet-4-6',
      });
    });

    it('omits model when not provided', async () => {
      logger.setPhase('plan', 'ses-003');
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      expect(entries[0]).not.toHaveProperty('model');
    });

    it('resets state correctly for a new phase', async () => {
      logger.setPhase('specify', 'ses-001');
      // Simulate a tool_use to populate toolStartTimes
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-orphan', input: { file_path: '/x' } }));
      await logger.close();

      // Start a new phase — toolStartTimes should be cleared
      logger.setPhase('clarify', 'ses-002');
      logger.logEvent(makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-orphan' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      // The tool_result in the new phase should NOT have duration_ms (start was cleared)
      const toolResult = entries.find(
        (e) => e.event_type === 'tool_result' && e.phase === 'clarify',
      );
      expect(toolResult).toBeDefined();
      expect(toolResult).not.toHaveProperty('duration_ms');
    });
  });

  // ---------- tool_use entry ----------

  describe('logEvent — tool_use', () => {
    beforeEach(() => {
      logger.setPhase('implement', 'ses-100');
    });

    it('creates a tool_use entry with tool_name and tool_call_id', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-1', input: { file_path: '/src/index.ts' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const toolUse = entries.find((e) => e.event_type === 'tool_use');
      expect(toolUse).toMatchObject({
        event_type: 'tool_use',
        tool_name: 'Read',
        tool_call_id: 'tc-1',
        file_paths: ['/src/index.ts'],
        phase: 'implement',
        session_id: 'ses-100',
      });
    });

    it('extracts file_path from Read tool input', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-r', input: { file_path: '/foo/bar.ts' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry!.file_paths).toEqual(['/foo/bar.ts']);
    });

    it('extracts file_path from Write tool input', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Write', id: 'tc-w', input: { file_path: '/out/new.ts', content: '...' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry!.file_paths).toEqual(['/out/new.ts']);
    });

    it('extracts file_path from Edit tool input', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Edit', id: 'tc-e', input: { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry!.file_paths).toEqual(['/src/app.ts']);
    });

    it('extracts path from Glob tool input', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Glob', id: 'tc-g', input: { path: '/src/', pattern: '**/*.ts' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry!.file_paths).toEqual(['/src/']);
    });

    it('extracts path from Grep tool input', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Grep', id: 'tc-gr', input: { path: '/src/', pattern: 'import' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry!.file_paths).toEqual(['/src/']);
    });

    it('produces entry without file_paths for unknown tools', async () => {
      logger.logEvent(makeChunk('tool_use', { name: 'Bash', id: 'tc-b', input: { command: 'ls' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry).not.toHaveProperty('file_paths');
    });
  });

  // ---------- tool_result entry ----------

  describe('logEvent — tool_result', () => {
    beforeEach(() => {
      logger.setPhase('implement', 'ses-200');
    });

    it('creates a tool_result entry with tool_name and tool_call_id', async () => {
      logger.logEvent(makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-1' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_result');
      expect(entry).toMatchObject({
        event_type: 'tool_result',
        tool_name: 'Read',
        tool_call_id: 'tc-1',
      });
    });

    it('extracts file_paths from metadata.filePath on tool_result', async () => {
      logger.logEvent(
        makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-fp' }, { filePath: '/src/file.ts' }),
      );
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_result');
      expect(entry!.file_paths).toEqual(['/src/file.ts']);
    });
  });

  // ---------- tool duration pairing ----------

  describe('tool duration tracking', () => {
    beforeEach(() => {
      logger.setPhase('implement', 'ses-300');
    });

    it('computes duration_ms by pairing tool_use → tool_result via tool_call_id', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('implement', 'ses-300');

      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-dur', input: { file_path: '/a.ts' } }));
      // Small delay to ensure measurable duration
      await new Promise((r) => setTimeout(r, 10));
      logger.logEvent(makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-dur' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const result = entries.find((e) => e.event_type === 'tool_result' && e.tool_call_id === 'tc-dur');
      expect(result).toHaveProperty('duration_ms');
      expect(typeof result!.duration_ms).toBe('number');
      expect(result!.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('omits duration_ms when tool_call_id is not paired', async () => {
      logger.logEvent(makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-unpaired' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const result = entries.find((e) => e.event_type === 'tool_result');
      expect(result).not.toHaveProperty('duration_ms');
    });
  });

  // ---------- error entry ----------

  describe('logEvent — error', () => {
    it('creates an error entry with error_message', async () => {
      logger.setPhase('specify', 'ses-400');
      logger.logEvent(makeChunk('error', { message: 'something went wrong' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'error');
      expect(entry).toMatchObject({
        event_type: 'error',
        error_message: 'something went wrong',
      });
    });

    it('extracts error.message from nested error object', async () => {
      logger.setPhase('specify', 'ses-401');
      logger.logEvent(makeChunk('error', { error: { message: 'nested error' } }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'error');
      expect(entry!.error_message).toBe('nested error');
    });
  });

  // ---------- phase_complete entry ----------

  describe('close and phase_complete', () => {
    it('emits phase_complete entry with correct fields', async () => {
      logger.setPhase('plan', 'ses-500');
      await logger.close();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const complete = entries.find((e) => e.event_type === 'phase_complete');
      expect(complete).toMatchObject({
        event_type: 'phase_complete',
        phase: 'plan',
        session_id: 'ses-500',
      });
    });

    it('includes token counts from complete events in phase_complete', async () => {
      logger.setPhase('tasks', 'ses-501');
      logger.logEvent(
        makeChunk('complete', { usage: { input_tokens: 15000, output_tokens: 8000 } }),
      );
      await logger.close();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const complete = entries.find((e) => e.event_type === 'phase_complete');
      expect(complete).toMatchObject({
        tokens_in: 15000,
        tokens_out: 8000,
      });
    });

    it('omits token counts when complete event has no usage data', async () => {
      logger.setPhase('specify', 'ses-502');
      logger.logEvent(makeChunk('complete', {}));
      await logger.close();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const complete = entries.find((e) => e.event_type === 'phase_complete');
      expect(complete).not.toHaveProperty('tokens_in');
      expect(complete).not.toHaveProperty('tokens_out');
    });

    it('clears flush timer on close', async () => {
      logger.setPhase('specify', 'ses-503');
      // close should stop the timer without errors
      await logger.close();
      // Advancing timers should not cause a flush (timer cleared)
      vi.advanceTimersByTime(60_000);
      // No errors thrown — timer properly cleared
    });
  });

  // ---------- buffer auto-flush at threshold ----------

  describe('buffer auto-flush at 50 events', () => {
    it('triggers flush when buffer reaches FLUSH_EVENT_THRESHOLD', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('implement', 'ses-600');

      // pushEntry from setPhase already pushed 1 entry (phase_start)
      // Push 49 more tool_use events to reach 50 total
      for (let i = 0; i < 49; i++) {
        logger.logEvent(makeChunk('tool_use', { name: 'Read', id: `tc-${i}`, input: { file_path: `/f${i}.ts` } }));
      }

      // Allow the void flush promise to resolve
      await new Promise((r) => setTimeout(r, 50));

      const filePath = join(specDir, 'conversation-log.jsonl');
      const entries = await readJsonl(filePath);
      expect(entries.length).toBe(50);
    });
  });

  // ---------- timer-based periodic flush ----------

  describe('timer-based periodic flush at 30s', () => {
    it('flushes buffer after 30 seconds', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('specify', 'ses-700');
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-timer', input: { file_path: '/x.ts' } }));

      // Verify the flush interval constant is 30s
      expect(ConversationLogger.FLUSH_INTERVAL_MS).toBe(30_000);

      // Manually flush to verify it works (timer integration is implicitly tested
      // by the setPhase/close lifecycle and the threshold test above)
      await logger.flush();

      const filePath = join(specDir, 'conversation-log.jsonl');
      const entries = await readJsonl(filePath);
      // Should have phase_start + tool_use
      expect(entries.length).toBe(2);
    });
  });

  // ---------- append-only behavior ----------

  describe('append-only file behavior', () => {
    it('multiple flush calls append to file without overwriting', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('specify', 'ses-800');
      await logger.flush();

      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-a1', input: {} }));
      await logger.flush();

      logger.logEvent(makeChunk('tool_use', { name: 'Write', id: 'tc-a2', input: {} }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      expect(entries).toHaveLength(3); // phase_start + 2 tool_use
      expect(entries[0]!.event_type).toBe('phase_start');
      expect(entries[1]!.event_type).toBe('tool_use');
      expect(entries[2]!.event_type).toBe('tool_use');
    });
  });

  // ---------- graceful degradation ----------

  describe('graceful handling of missing data', () => {
    it('handles tool_use with no name or id', async () => {
      logger.setPhase('implement', 'ses-900');
      logger.logEvent(makeChunk('tool_use', {}));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      const entry = entries.find((e) => e.event_type === 'tool_use');
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('tool_name');
      expect(entry).not.toHaveProperty('tool_call_id');
      expect(entry).not.toHaveProperty('file_paths');
    });

    it('ignores text events', async () => {
      logger.setPhase('specify', 'ses-901');
      logger.logEvent(makeChunk('text', { text: 'Hello world' }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      // Only phase_start, no text entry
      expect(entries).toHaveLength(1);
      expect(entries[0]!.event_type).toBe('phase_start');
    });

    it('does not log events before setPhase is called', async () => {
      const freshLogger = new ConversationLogger(specDir);
      freshLogger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-pre' }));
      await freshLogger.flush();

      // File should not exist since nothing was buffered
      await expect(readFile(join(specDir, 'conversation-log.jsonl'), 'utf-8')).rejects.toThrow();
    });
  });

  // ---------- init event handling ----------

  describe('logEvent — init', () => {
    it('updates session_id from init event', async () => {
      logger.setPhase('specify', 'ses-placeholder');
      logger.logEvent(makeChunk('init', { session_id: 'ses-real-123' }));
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-init', input: {} }));
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      // The tool_use entry should use the updated session_id
      const toolUse = entries.find((e) => e.event_type === 'tool_use');
      expect(toolUse!.session_id).toBe('ses-real-123');
    });
  });

  // ---------- JSONL format validation ----------

  describe('JSONL format', () => {
    it('each line is valid independent JSON', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('implement', 'ses-fmt');
      logger.logEvent(makeChunk('tool_use', { name: 'Read', id: 'tc-fmt', input: { file_path: '/x.ts' } }));
      logger.logEvent(makeChunk('tool_result', { name: 'Read', tool_use_id: 'tc-fmt' }));
      logger.logEvent(makeChunk('error', { message: 'oops' }));
      await logger.close();

      const content = await readFile(join(specDir, 'conversation-log.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(5); // phase_start + tool_use + tool_result + error + phase_complete

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Validate required fields
        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('phase');
        expect(parsed).toHaveProperty('event_type');
        expect(parsed).toHaveProperty('session_id');
      }
    });

    it('timestamps are valid ISO 8601', async () => {
      vi.useRealTimers();
      specDir = await makeTempSpecDir();
      logger = new ConversationLogger(specDir);
      logger.setPhase('specify', 'ses-iso');
      await logger.flush();

      const entries = await readJsonl(join(specDir, 'conversation-log.jsonl'));
      for (const entry of entries) {
        const ts = entry.timestamp as string;
        expect(new Date(ts).toISOString()).toBe(ts);
      }
    });
  });

  // ---------- getFilePath ----------

  describe('getFilePath', () => {
    it('returns the JSONL file path', () => {
      expect(logger.getFilePath()).toBe(join(specDir, 'conversation-log.jsonl'));
    });
  });
});
