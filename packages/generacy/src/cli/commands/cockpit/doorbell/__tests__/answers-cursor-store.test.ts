/**
 * Unit coverage for `AnswersCursorStore` — load/advance/flush round-trip,
 * atomic tmp+rename persistence, corrupt/invalid/wrong-version → null,
 * monotonic-within-ino + new-ino reset, lazy `cursors/` mkdir, and
 * warn-not-throw on write failure.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AnswersCursorStore,
  AnswersCursorSchema,
} from '../answers-cursor-store.js';
import type { FsFacade } from '../answers-file-source.js';

interface MemFs {
  fs: FsFacade;
  files: Map<string, string>;
  dirs: Set<string>;
  calls: {
    mkdir: Array<[string, { recursive: boolean }]>;
    writeFile: Array<[string, string]>;
    rename: Array<[string, string]>;
  };
}

function makeMemFs(opts: { failWrite?: boolean } = {}): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: MemFs['calls'] = { mkdir: [], writeFile: [], rename: [] };
  const fs: FsFacade = {
    // Read surface is unused by the cursor store; stub to satisfy the type.
    stat: async () => {
      throw new Error('unused');
    },
    open: async () => {
      throw new Error('unused');
    },
    mkdir: async (p, o) => {
      calls.mkdir.push([p, o]);
      dirs.add(p);
    },
    readFile: async (p) => {
      const v = files.get(p);
      if (v == null) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      calls.writeFile.push([p, data]);
      if (opts.failWrite) throw new Error('disk full');
      files.set(p, data);
    },
    rename: async (from, to) => {
      calls.rename.push([from, to]);
      const v = files.get(from);
      if (v == null) throw new Error(`ENOENT rename ${from}`);
      files.delete(from);
      files.set(to, v);
    },
  };
  return { fs, files, dirs, calls };
}

function makeLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

const BASE = {
  answersFilePath: '/mem/answers.ndjson',
  epicRef: 'Owner/Repo#5',
  cursorDir: '/mem/cursors',
};
const CURSOR_PATH = '/mem/cursors/owner__repo__5.json';

describe('AnswersCursorStore', () => {
  it('advance + flush persists an atomic tmp→rename, and load reads it back', async () => {
    const mem = makeMemFs();
    const store = new AnswersCursorStore({
      ...BASE,
      logger: makeLogger(),
      fs: mem.fs,
      now: () => 1_700_000_000_000,
    });

    store.advance(7, 128);
    await store.flush();

    // Written to a tmp path first, then renamed onto the final cursor path.
    expect(mem.calls.writeFile).toHaveLength(1);
    const tmpPath = mem.calls.writeFile[0]![0];
    expect(tmpPath).toContain('.tmp-');
    expect(tmpPath).not.toBe(CURSOR_PATH);
    expect(mem.calls.rename).toEqual([[tmpPath, CURSOR_PATH]]);
    // Only the final path survives — no partial tmp left behind.
    expect(mem.files.has(tmpPath)).toBe(false);
    expect(mem.files.has(CURSOR_PATH)).toBe(true);

    // Round-trip: a fresh store loads exactly what was written.
    const reader = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });
    const loaded = await reader.load();
    expect(loaded).toEqual({ ino: 7, offset: 128 });

    // Persisted payload validates against the schema (version pinned to 1).
    const parsed = AnswersCursorSchema.parse(JSON.parse(mem.files.get(CURSOR_PATH)!));
    expect(parsed.version).toBe(1);
    expect(parsed.ino).toBe(7);
    expect(parsed.offset).toBe(128);
  });

  it('lazily mkdir -p the cursors dir at first flush only', async () => {
    const mem = makeMemFs();
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });

    store.advance(1, 10);
    await store.flush();
    store.advance(1, 20);
    await store.flush();

    expect(mem.calls.mkdir).toEqual([['/mem/cursors', { recursive: true }]]);
  });

  it('load returns null for a missing cursor file', async () => {
    const mem = makeMemFs();
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });
    expect(await store.load()).toBeNull();
  });

  it('load returns null for corrupt JSON', async () => {
    const mem = makeMemFs();
    mem.files.set(CURSOR_PATH, '{not json');
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });
    expect(await store.load()).toBeNull();
  });

  it('load returns null for a wrong-version / invalid payload', async () => {
    const mem = makeMemFs();
    mem.files.set(
      CURSOR_PATH,
      JSON.stringify({ version: 2, ino: 1, offset: 5, updatedAt: new Date().toISOString() }),
    );
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });
    expect(await store.load()).toBeNull();

    mem.files.set(CURSOR_PATH, JSON.stringify({ version: 1, ino: -1, offset: 5 }));
    const store2 = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });
    expect(await store2.load()).toBeNull();
  });

  it('advance is monotonic within an inode (never lowers the offset)', async () => {
    const mem = makeMemFs();
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });

    store.advance(3, 100);
    store.advance(3, 50); // lower — ignored
    await store.flush();

    const parsed = AnswersCursorSchema.parse(JSON.parse(mem.files.get(CURSOR_PATH)!));
    expect(parsed.offset).toBe(100);
  });

  it('a new inode resets the offset', async () => {
    const mem = makeMemFs();
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: mem.fs });

    store.advance(3, 100);
    await store.flush();
    store.advance(9, 5); // new ino → offset resets to 5
    await store.flush();

    const parsed = AnswersCursorSchema.parse(JSON.parse(mem.files.get(CURSOR_PATH)!));
    expect(parsed.ino).toBe(9);
    expect(parsed.offset).toBe(5);
  });

  it('a write failure warns and does not throw', async () => {
    const mem = makeMemFs({ failWrite: true });
    const logger = makeLogger();
    const store = new AnswersCursorStore({ ...BASE, logger, fs: mem.fs });

    store.advance(1, 10);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/persist failed/);
  });

  it('is a no-op (no throw) when the fs façade lacks a write surface', async () => {
    const readOnlyFs: FsFacade = {
      stat: async () => {
        throw new Error('unused');
      },
      open: async () => {
        throw new Error('unused');
      },
    };
    const store = new AnswersCursorStore({ ...BASE, logger: makeLogger(), fs: readOnlyFs });
    expect(await store.load()).toBeNull();
    store.advance(1, 10);
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
