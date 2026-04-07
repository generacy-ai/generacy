import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../tar-utils.js';

// ---------------------------------------------------------------------------
// Tar construction helpers — build ustar-format tar archives for testing
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

/**
 * Create a 512-byte ustar tar header for a regular file.
 * Only fills the fields that `extractTarGz` actually reads:
 * name (0, 100), size (124, 12), type flag (156, 1), prefix (345, 155).
 */
function makeTarHeader(opts: {
  name: string;
  size: number;
  prefix?: string;
  typeFlag?: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // name (offset 0, length 100)
  header.write(opts.name, 0, Math.min(opts.name.length, 100), 'ascii');

  // size as octal string (offset 124, length 12) — null terminated
  const octalSize = opts.size.toString(8).padStart(11, '0');
  header.write(octalSize, 124, 11, 'ascii');
  header[135] = 0; // null terminator

  // type flag (offset 156, length 1): '0' = regular file, '5' = directory
  const flag = opts.typeFlag ?? '0';
  header.write(flag, 156, 1, 'ascii');

  // prefix (offset 345, length 155)
  if (opts.prefix) {
    header.write(
      opts.prefix,
      345,
      Math.min(opts.prefix.length, 155),
      'ascii',
    );
  }

  return header;
}

/** Pad content to the next 512-byte boundary. */
function padToBlock(content: Buffer): Buffer {
  const remainder = content.length % BLOCK_SIZE;
  if (remainder === 0) return content;
  const padding = Buffer.alloc(BLOCK_SIZE - remainder, 0);
  return Buffer.concat([content, padding]);
}

/** Two consecutive zero blocks = end-of-archive marker. */
function endOfArchive(): Buffer {
  return Buffer.alloc(BLOCK_SIZE * 2, 0);
}

/** Build a complete tar entry (header + padded content). */
function makeTarEntry(opts: {
  name: string;
  content: string;
  prefix?: string;
  typeFlag?: string;
}): Buffer {
  const body = Buffer.from(opts.content, 'utf-8');
  const header = makeTarHeader({
    name: opts.name,
    size: body.length,
    prefix: opts.prefix,
    typeFlag: opts.typeFlag,
  });
  return Buffer.concat([header, padToBlock(body)]);
}

/** Build a directory entry (header only, size 0). */
function makeDirEntry(name: string, prefix?: string): Buffer {
  return makeTarHeader({ name, size: 0, prefix, typeFlag: '5' });
}

/** Assemble entries into a gzipped tar buffer. */
function buildTarGz(...entries: Buffer[]): Buffer {
  const tar = Buffer.concat([...entries, endOfArchive()]);
  return Buffer.from(gzipSync(tar));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractTarGz', () => {
  // -------------------------------------------------------------------------
  // Single file extraction
  // -------------------------------------------------------------------------

  it('extracts a single file from a tarball', async () => {
    const archive = buildTarGz(
      makeTarEntry({ name: 'hello.txt', content: 'Hello, world!' }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(1);
    expect(files.get('hello.txt')).toBe('Hello, world!');
  });

  // -------------------------------------------------------------------------
  // Multiple files
  // -------------------------------------------------------------------------

  it('extracts multiple files from a tarball', async () => {
    const archive = buildTarGz(
      makeTarEntry({ name: 'a.txt', content: 'file-a' }),
      makeTarEntry({ name: 'b.txt', content: 'file-b' }),
      makeTarEntry({ name: 'c.txt', content: 'file-c' }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(3);
    expect(files.get('a.txt')).toBe('file-a');
    expect(files.get('b.txt')).toBe('file-b');
    expect(files.get('c.txt')).toBe('file-c');
  });

  // -------------------------------------------------------------------------
  // Filter function
  // -------------------------------------------------------------------------

  describe('filter function', () => {
    it('includes only paths matching the filter', async () => {
      const archive = buildTarGz(
        makeTarEntry({ name: 'include-me.txt', content: 'yes' }),
        makeTarEntry({ name: 'exclude-me.txt', content: 'no' }),
        makeTarEntry({ name: 'include-also.txt', content: 'also yes' }),
      );

      const files = await extractTarGz(archive, (path) =>
        path.startsWith('include'),
      );

      expect(files.size).toBe(2);
      expect(files.has('include-me.txt')).toBe(true);
      expect(files.has('include-also.txt')).toBe(true);
      expect(files.has('exclude-me.txt')).toBe(false);
    });

    it('returns empty map when filter excludes all files', async () => {
      const archive = buildTarGz(
        makeTarEntry({ name: 'a.txt', content: 'data' }),
      );

      const files = await extractTarGz(archive, () => false);

      expect(files.size).toBe(0);
    });

    it('receives the full archive path including prefix', async () => {
      const receivedPaths: string[] = [];
      const archive = buildTarGz(
        makeTarEntry({
          name: 'Dockerfile',
          content: 'FROM node',
          prefix: 'abc123/standard',
        }),
      );

      await extractTarGz(archive, (path) => {
        receivedPaths.push(path);
        return true;
      });

      expect(receivedPaths).toEqual(['abc123/standard/Dockerfile']);
    });
  });

  // -------------------------------------------------------------------------
  // Nested directory paths (prefix field)
  // -------------------------------------------------------------------------

  describe('nested directory paths', () => {
    it('reconstructs path from prefix and name fields', async () => {
      const archive = buildTarGz(
        makeTarEntry({
          name: 'entrypoint.sh',
          content: '#!/bin/bash\necho hello',
          prefix: 'hash123/standard/scripts',
        }),
      );

      const files = await extractTarGz(archive, () => true);

      expect(files.size).toBe(1);
      expect(files.get('hash123/standard/scripts/entrypoint.sh')).toBe(
        '#!/bin/bash\necho hello',
      );
    });

    it('handles entries without prefix', async () => {
      const archive = buildTarGz(
        makeTarEntry({ name: 'root-file.txt', content: 'at root' }),
      );

      const files = await extractTarGz(archive, () => true);

      expect(files.get('root-file.txt')).toBe('at root');
    });

    it('handles deeply nested paths via prefix', async () => {
      const archive = buildTarGz(
        makeTarEntry({
          name: 'deep-file.yaml',
          content: 'key: value',
          prefix: 'repo-abc123/standard/config/nested',
        }),
      );

      const files = await extractTarGz(archive, () => true);

      expect(files.get('repo-abc123/standard/config/nested/deep-file.yaml')).toBe(
        'key: value',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Empty tarball
  // -------------------------------------------------------------------------

  it('returns empty map for a tarball with no files', async () => {
    const archive = buildTarGz(); // only end-of-archive marker

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Directory entries are skipped
  // -------------------------------------------------------------------------

  it('skips directory entries (type flag 5)', async () => {
    const archive = buildTarGz(
      makeDirEntry('some-dir/'),
      makeTarEntry({ name: 'some-dir/file.txt', content: 'in dir' }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(1);
    expect(files.has('some-dir/')).toBe(false);
    expect(files.get('some-dir/file.txt')).toBe('in dir');
  });

  // -------------------------------------------------------------------------
  // Legacy null type flag (treated as regular file)
  // -------------------------------------------------------------------------

  it('treats null type flag as a regular file', async () => {
    const archive = buildTarGz(
      makeTarEntry({ name: 'legacy.txt', content: 'old tar', typeFlag: '\0' }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(1);
    expect(files.get('legacy.txt')).toBe('old tar');
  });

  // -------------------------------------------------------------------------
  // File content with special characters
  // -------------------------------------------------------------------------

  it('preserves UTF-8 content correctly', async () => {
    const content = 'line1\nline2\ttab\n# comment with ñ and ü';
    const archive = buildTarGz(
      makeTarEntry({ name: 'utf8.txt', content }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.get('utf8.txt')).toBe(content);
  });

  // -------------------------------------------------------------------------
  // Content larger than one block
  // -------------------------------------------------------------------------

  it('handles file content spanning multiple 512-byte blocks', async () => {
    const content = 'x'.repeat(1500); // ~3 blocks of content
    const archive = buildTarGz(
      makeTarEntry({ name: 'large.txt', content }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.get('large.txt')).toBe(content);
    expect(files.get('large.txt')!.length).toBe(1500);
  });

  // -------------------------------------------------------------------------
  // Mixed entry types
  // -------------------------------------------------------------------------

  it('only includes regular files, skipping dirs and other types', async () => {
    const archive = buildTarGz(
      makeDirEntry('project/'),
      makeTarEntry({ name: 'project/Dockerfile', content: 'FROM ubuntu' }),
      makeDirEntry('project/scripts/'),
      makeTarEntry({
        name: 'project/scripts/run.sh',
        content: '#!/bin/sh\nrun',
      }),
      // Symlink-like entry (type flag '2')
      makeTarEntry({
        name: 'project/link',
        content: '',
        typeFlag: '2',
      }),
    );

    const files = await extractTarGz(archive, () => true);

    expect(files.size).toBe(2);
    expect(files.has('project/Dockerfile')).toBe(true);
    expect(files.has('project/scripts/run.sh')).toBe(true);
    expect(files.has('project/')).toBe(false);
    expect(files.has('project/scripts/')).toBe(false);
    expect(files.has('project/link')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GitHub tarball-like structure (strip top-level prefix)
  // -------------------------------------------------------------------------

  it('supports filtering files from GitHub tarballs', async () => {
    const archive = buildTarGz(
      makeDirEntry('generacy-ai-cluster-base-abc1234/'),
      makeDirEntry('generacy-ai-cluster-base-abc1234/standard/'),
      makeTarEntry({
        name: 'Dockerfile',
        content: 'FROM node:20',
        prefix: 'generacy-ai-cluster-base-abc1234/standard',
      }),
      makeTarEntry({
        name: 'docker-compose.yml',
        content: 'version: "3"',
        prefix: 'generacy-ai-cluster-base-abc1234/standard',
      }),
      makeDirEntry('generacy-ai-cluster-base-abc1234/microservices/'),
      makeTarEntry({
        name: 'Dockerfile',
        content: 'FROM node:20-slim',
        prefix: 'generacy-ai-cluster-base-abc1234/microservices',
      }),
    );

    // Filter for standard variant only
    const files = await extractTarGz(archive, (path) =>
      path.includes('/standard/'),
    );

    expect(files.size).toBe(2);
    expect(
      files.get(
        'generacy-ai-cluster-base-abc1234/standard/Dockerfile',
      ),
    ).toBe('FROM node:20');
    expect(
      files.get(
        'generacy-ai-cluster-base-abc1234/standard/docker-compose.yml',
      ),
    ).toBe('version: "3"');
  });

  // -------------------------------------------------------------------------
  // Invalid / corrupt input
  // -------------------------------------------------------------------------

  it('rejects non-gzip input with an error', async () => {
    const notGzip = Buffer.from('this is not gzip data');

    await expect(extractTarGz(notGzip, () => true)).rejects.toThrow();
  });
});
