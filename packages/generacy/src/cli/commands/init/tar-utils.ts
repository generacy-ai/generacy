import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

// ---------------------------------------------------------------------------
// Constants — POSIX ustar tar format
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512;

/** Header field offsets and lengths within a 512-byte tar header block. */
const HEADER = {
  name: { offset: 0, length: 100 },
  size: { offset: 124, length: 12 },
  typeFlag: { offset: 156, length: 1 },
  prefix: { offset: 345, length: 155 },
} as const;

/** Type flags for regular files. '\0' is legacy, '0' is POSIX. */
const REGULAR_FILE_FLAGS = new Set(['0', '\0']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a null-terminated ASCII string from a buffer region. */
function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nullIdx = slice.indexOf(0);
  return slice.subarray(0, nullIdx === -1 ? length : nullIdx).toString('ascii');
}

/** Parse an octal size field (ASCII digits, null/space terminated). */
function readOctalSize(buf: Buffer, offset: number, length: number): number {
  const raw = readString(buf, offset, length).trim();
  return raw.length === 0 ? 0 : parseInt(raw, 8);
}

/** Check if a header block is all zeros (end-of-archive marker). */
function isEndOfArchive(block: Buffer): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/** Build the full path from the header's name and optional prefix fields. */
function readPath(header: Buffer): string {
  const prefix = readString(
    header,
    HEADER.prefix.offset,
    HEADER.prefix.length,
  );
  const name = readString(header, HEADER.name.offset, HEADER.name.length);
  return prefix ? `${prefix}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Decompress helper
// ---------------------------------------------------------------------------

/** Decompress a gzip buffer into a plain Buffer. */
async function gunzip(compressed: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    const stream = Readable.from(compressed).pipe(createGunzip());
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract files from a gzip-compressed tar archive.
 *
 * Parses the POSIX ustar format used by GitHub tarball downloads. Only
 * regular files whose path passes the `filter` function are included in the
 * result. File content is decoded as UTF-8.
 *
 * @param buffer  Complete `.tar.gz` content.
 * @param filter  Predicate receiving the full archive path — return `true` to
 *                include the file in the output map.
 * @returns Map from archive path → file content (UTF-8).
 */
export async function extractTarGz(
  buffer: Buffer,
  filter: (path: string) => boolean,
): Promise<Map<string, string>> {
  const tar = await gunzip(buffer);
  const files = new Map<string, string>();

  let offset = 0;

  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);

    // Two consecutive zero blocks signal end-of-archive.
    if (isEndOfArchive(header)) break;

    const path = readPath(header);
    const size = readOctalSize(
      header,
      HEADER.size.offset,
      HEADER.size.length,
    );
    const typeFlag = String.fromCharCode(header[HEADER.typeFlag.offset] ?? 0);

    // Advance past the header block to the file content.
    offset += BLOCK_SIZE;

    if (REGULAR_FILE_FLAGS.has(typeFlag) && size > 0 && filter(path)) {
      const content = tar.subarray(offset, offset + size);
      files.set(path, content.toString('utf-8'));
    }

    // Content is padded to a 512-byte boundary.
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  return files;
}
