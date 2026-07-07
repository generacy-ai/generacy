/**
 * SC-004 / SC-005 backfill test using a metadata-only fixture of
 * maintainer comments. See fixtures/README.md — bodies are never
 * committed to this repo.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Logger } from '../../types/logger.js';
import type { Comment } from '../../types/github.js';
import type { TrustSurface } from '../comment-trust.js';
import { isTrustedCommentAuthor } from '../comment-trust.js';
import { wrapUntrustedData } from '../untrusted-data-fence.js';
import { CommentTrustConfigSchema } from '../comment-trust-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = join(__dirname, 'fixtures', 'maintainer-comments.json');

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('SC-004: every fixture record carries authorAssociation', () => {
  it('all ≥20 backfill records have a non-null authorAssociation', () => {
    const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Array<{
      id: number;
      author: string;
      authorAssociation: string;
    }>;
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    for (const f of fixtures) {
      expect(f.authorAssociation).toBeTruthy();
    }
  });
});

describe('SC-005: every maintainer fixture is trusted on every surface', () => {
  const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Array<{
    id: number;
    author: string;
    authorAssociation: string;
  }>;

  const SURFACES: TrustSurface[] = ['answer-scanner', 'clarify-resume', 'pr-feedback'];

  it.each(SURFACES)('all fixtures trusted on surface %s', (surface) => {
    const logger = makeLogger();
    for (const f of fixtures) {
      const comment: Comment = {
        id: f.id,
        body: '(metadata-only fixture — body not stored)',
        author: f.author,
        authorAssociation: f.authorAssociation,
        created_at: '',
        updated_at: '',
      };
      const decision = isTrustedCommentAuthor(comment, surface, { logger });
      expect({ id: f.id, trusted: decision.trusted, reason: decision.reason }).toEqual({
        id: f.id,
        trusted: true,
        reason: decision.reason,
      });
    }
  });
});

describe('T043 / SC-005 widen-config fixture path', () => {
  const widenConfig = CommentTrustConfigSchema.parse({
    widen: {
      tiers: ['CONTRIBUTOR'],
      logins: ['external-triage-bot'],
    },
  });

  it('CONTRIBUTOR is trusted on context surfaces when widen.tiers includes it', () => {
    const c: Comment = {
      id: 1,
      body: '',
      author: 'external-contrib',
      authorAssociation: 'CONTRIBUTOR',
      created_at: '',
      updated_at: '',
    };
    for (const surface of ['clarify-resume', 'pr-feedback'] as TrustSurface[]) {
      const d = isTrustedCommentAuthor(c, surface, { logger: makeLogger(), config: widenConfig });
      expect(d.trusted).toBe(true);
      expect(d.reason).toBe('widened-tier');
    }
  });

  it('CONTRIBUTOR still untrusted on answer-scanner even with widen config (SC-009)', () => {
    const c: Comment = {
      id: 1,
      body: '',
      author: 'external-contrib',
      authorAssociation: 'CONTRIBUTOR',
      created_at: '',
      updated_at: '',
    };
    const d = isTrustedCommentAuthor(c, 'answer-scanner', { logger: makeLogger(), config: widenConfig });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('contributor-untrusted');
  });

  it('widen.logins entry is trusted on context surfaces regardless of tier', () => {
    const c: Comment = {
      id: 1,
      body: '',
      author: 'external-triage-bot',
      authorAssociation: 'NONE',
      created_at: '',
      updated_at: '',
    };
    const d = isTrustedCommentAuthor(c, 'pr-feedback', { logger: makeLogger(), config: widenConfig });
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('widened-login');
  });

  it('widen.logins entry is NOT trusted on answer-scanner', () => {
    const c: Comment = {
      id: 1,
      body: '',
      author: 'external-triage-bot',
      authorAssociation: 'NONE',
      created_at: '',
      updated_at: '',
    };
    const d = isTrustedCommentAuthor(c, 'answer-scanner', { logger: makeLogger(), config: widenConfig });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('none-untrusted');
  });
});

describe('T041 SC-004 smoke: gh-cli projection round-trip', () => {
  it('a Comment with authorAssociation flows through wrapUntrustedData intact', () => {
    // Simulates the end-to-end path: gh returns author_association → Comment
    // → trust helper → fence.
    const comment: Comment = {
      id: 42,
      body: 'looks good',
      author: 'maintainer-a',
      authorAssociation: 'OWNER',
      created_at: '',
      updated_at: '',
    };
    const decision = isTrustedCommentAuthor(comment, 'pr-feedback', { logger: makeLogger() });
    expect(decision.trusted).toBe(true);

    const rendered = `<comment id="${comment.id}" author="${comment.author}" association="${comment.authorAssociation}">\n${comment.body}\n</comment>`;
    const fenced = wrapUntrustedData(rendered, 'PR #42 review comments');
    expect(fenced).toContain('<untrusted-data');
    expect(fenced).toContain('association="OWNER"');
    expect(fenced).toContain('looks good');
  });
});
