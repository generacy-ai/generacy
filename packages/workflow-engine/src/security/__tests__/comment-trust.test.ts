import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../../types/logger.js';
import type { Comment } from '../../types/github.js';
import {
  isTrustedCommentAuthor,
  normalizeLogin,
  type CommentTrustContext,
  type TrustSurface,
} from '../comment-trust.js';
import type { CommentTrustConfig } from '../comment-trust-config.js';

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeComment(overrides: Partial<Comment>): Comment {
  const base: Comment = {
    id: 1,
    body: 'irrelevant',
    author: 'someone',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    // #878 default: `false` keeps decision 1.5 quiet in tests that don't
    // exercise the self-authored path. Tests that need the warn behavior
    // (S4 / S5) explicitly override to undefined / null.
    viewerDidAuthor: false,
  };
  const result = { ...base, ...overrides };
  // Support explicit `undefined` override — spread copies the key.
  if ('viewerDidAuthor' in overrides && overrides.viewerDidAuthor === undefined) {
    delete (result as { viewerDidAuthor?: boolean }).viewerDidAuthor;
  }
  return result;
}

function ctx(overrides?: Partial<CommentTrustContext>): CommentTrustContext & { logger: ReturnType<typeof makeLogger> } {
  const logger = makeLogger();
  return { logger, ...overrides };
}

describe('isTrustedCommentAuthor', () => {
  const SURFACES: TrustSurface[] = ['answer-scanner', 'clarify-resume', 'pr-feedback'];

  describe('default trusted tiers', () => {
    it.each([
      ['OWNER', 'owner'],
      ['MEMBER', 'member'],
      ['COLLABORATOR', 'collaborator'],
    ])('trusts %s on every surface', (tier, reason) => {
      for (const surface of SURFACES) {
        const c = ctx();
        const decision = isTrustedCommentAuthor(
          makeComment({ authorAssociation: tier }),
          surface,
          c,
        );
        expect(decision).toEqual({ trusted: true, reason });
        expect(c.logger.warn).not.toHaveBeenCalled();
      }
    });
  });

  describe('bot login', () => {
    it('trusts the cluster bot login regardless of tier', () => {
      for (const surface of SURFACES) {
        const decision = isTrustedCommentAuthor(
          makeComment({ author: 'my-bot', authorAssociation: 'NONE' }),
          surface,
          ctx({ botLogin: 'my-bot' }),
        );
        expect(decision).toEqual({ trusted: true, reason: 'bot' });
      }
    });

    it('trusts the bot even with unset authorAssociation', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'my-bot' }),
        'answer-scanner',
        ctx({ botLogin: 'my-bot' }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'bot' });
    });

    it('does not trust another user with same NONE tier', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'attacker', authorAssociation: 'NONE' }),
        'answer-scanner',
        ctx({ botLogin: 'my-bot' }),
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
    });
  });

  describe('known untrusted tiers', () => {
    it.each([
      ['NONE', 'none-untrusted'],
      ['FIRST_TIME_CONTRIBUTOR', 'first-time-contributor-untrusted'],
      ['FIRST_TIMER', 'first-timer-untrusted'],
      ['MANNEQUIN', 'mannequin-untrusted'],
      ['CONTRIBUTOR', 'contributor-untrusted'],
    ])('marks %s as untrusted without widen config', (tier, reason) => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: tier }),
        'answer-scanner',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason });
      expect(c.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed on unset authorAssociation', () => {
    it('returns author-association-unset when field is undefined, no warn', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: undefined }),
        'clarify-resume',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason: 'author-association-unset' });
      expect(c.logger.warn).not.toHaveBeenCalled();
    });

    it('returns author-association-unset when field is empty string, no warn', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: '' }),
        'pr-feedback',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason: 'author-association-unset' });
      expect(c.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('unknown / future tier (SC-008)', () => {
    it('marks as untrusted with unknown-tier reason and one warn log', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: 'FUTURE_TIER', id: 42 }),
        'pr-feedback',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason: 'unknown-tier' });
      expect(c.logger.warn).toHaveBeenCalledTimes(1);
      const call = c.logger.warn.mock.calls[0]!;
      expect(call[0]).toMatch(/unrecognized author_association tier/i);
      expect(call[1]).toEqual(expect.objectContaining({
        authorAssociation: 'FUTURE_TIER',
        commentId: 42,
      }));
    });

    it('marks SPONSOR (future GitHub tier) as unknown-tier', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: 'SPONSOR' }),
        'clarify-resume',
        c,
      );
      expect(decision.reason).toBe('unknown-tier');
    });
  });

  describe('widen-config (SC-009)', () => {
    const config: CommentTrustConfig = {
      widen: { tiers: ['CONTRIBUTOR'], logins: [] },
    };

    it('trusts CONTRIBUTOR on clarify-resume when widen.tiers includes it', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: 'CONTRIBUTOR' }),
        'clarify-resume',
        ctx({ config }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'widened-tier' });
    });

    it('trusts CONTRIBUTOR on pr-feedback when widen.tiers includes it', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: 'CONTRIBUTOR' }),
        'pr-feedback',
        ctx({ config }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'widened-tier' });
    });

    it('still rejects CONTRIBUTOR on answer-scanner even with widen config', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ authorAssociation: 'CONTRIBUTOR' }),
        'answer-scanner',
        ctx({ config }),
      );
      expect(decision).toEqual({ trusted: false, reason: 'contributor-untrusted' });
    });

    it('trusts a widen.logins entry on context surfaces even at tier NONE', () => {
      const c: CommentTrustConfig = { widen: { tiers: [], logins: ['alice'] } };
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'alice', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ config: c }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'widened-login' });
    });

    it('does not trust widen.logins entry on answer-scanner surface', () => {
      const c: CommentTrustConfig = { widen: { tiers: [], logins: ['alice'] } };
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'alice', authorAssociation: 'NONE' }),
        'answer-scanner',
        ctx({ config: c }),
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
    });
  });

  describe('self-authored via viewerDidAuthor (#878)', () => {
    it('S1: viewerDidAuthor=true + NONE → trusted self-authored, no warn', () => {
      for (const surface of SURFACES) {
        const c = ctx();
        const decision = isTrustedCommentAuthor(
          makeComment({ viewerDidAuthor: true, authorAssociation: 'NONE' }),
          surface,
          c,
        );
        expect(decision).toEqual({ trusted: true, reason: 'self-authored' });
        expect(c.logger.warn).not.toHaveBeenCalled();
      }
    });

    it('S2: viewerDidAuthor=false + NONE → none-untrusted, no warn', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ viewerDidAuthor: false, authorAssociation: 'NONE' }),
        'pr-feedback',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
      expect(c.logger.warn).not.toHaveBeenCalled();
    });

    it('S3: viewerDidAuthor=false + OWNER → owner (association tier still fires)', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ viewerDidAuthor: false, authorAssociation: 'OWNER' }),
        'pr-feedback',
        c,
      );
      expect(decision).toEqual({ trusted: true, reason: 'owner' });
      expect(c.logger.warn).not.toHaveBeenCalled();
    });

    it('S4: viewerDidAuthor=undefined + NONE → none-untrusted + one warn', () => {
      const c = ctx();
      const decision = isTrustedCommentAuthor(
        makeComment({ id: 4444, authorAssociation: 'NONE', viewerDidAuthor: undefined }),
        'pr-feedback',
        c,
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
      expect(c.logger.warn).toHaveBeenCalledTimes(1);
      const call = c.logger.warn.mock.calls[0]!;
      expect(call[0]).toMatch(/viewerDidAuthor missing\/non-boolean/i);
      expect(call[1]).toEqual({ surface: 'pr-feedback', commentId: 4444, observedValue: undefined });
    });

    it('S5: viewerDidAuthor=null + NONE → none-untrusted + one warn', () => {
      const c = ctx();
      // Wire value may bleed through as null on partial-error paths.
      const comment = makeComment({ id: 5555, authorAssociation: 'NONE' }) as Comment & {
        viewerDidAuthor: null;
      };
      comment.viewerDidAuthor = null;
      const decision = isTrustedCommentAuthor(comment, 'pr-feedback', c);
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
      expect(c.logger.warn).toHaveBeenCalledTimes(1);
      const call = c.logger.warn.mock.calls[0]!;
      expect(call[0]).toMatch(/viewerDidAuthor missing\/non-boolean/i);
      expect(call[1]).toEqual({ surface: 'pr-feedback', commentId: 5555, observedValue: null });
    });

    // #910: warn scope extended to answer-scanner and clarify-resume.
    // These surfaces now fetch via getIssueCommentsWithViewerAuth (GraphQL),
    // so the field is structurally required. Absence is a shape-drift alarm
    // (SC-006 injected-drift case).
    it.each(['answer-scanner', 'clarify-resume'] as const)(
      'S4-#910: viewerDidAuthor=undefined on %s → warn fires with surface tag',
      (surface) => {
        const c = ctx();
        const decision = isTrustedCommentAuthor(
          makeComment({ id: 4477, authorAssociation: 'NONE', viewerDidAuthor: undefined }),
          surface,
          c,
        );
        expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
        expect(c.logger.warn).toHaveBeenCalledTimes(1);
        const call = c.logger.warn.mock.calls[0]!;
        expect(call[0]).toMatch(/viewerDidAuthor missing\/non-boolean/i);
        expect(call[1]).toEqual({ surface, commentId: 4477, observedValue: undefined });
      },
    );

    it.each(['answer-scanner', 'clarify-resume'] as const)(
      'S5-#910: viewerDidAuthor=null on %s → warn fires with surface tag',
      (surface) => {
        const c = ctx();
        const comment = makeComment({ id: 5577, authorAssociation: 'NONE' }) as Comment & {
          viewerDidAuthor: null;
        };
        comment.viewerDidAuthor = null;
        const decision = isTrustedCommentAuthor(comment, surface, c);
        expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
        expect(c.logger.warn).toHaveBeenCalledTimes(1);
        const call = c.logger.warn.mock.calls[0]!;
        expect(call[0]).toMatch(/viewerDidAuthor missing\/non-boolean/i);
        expect(call[1]).toEqual({ surface, commentId: 5577, observedValue: null });
      },
    );

    // SC-006 healthy case: warn does NOT fire when the field is populated
    // (either true or false) on the migrated surfaces.
    it.each(['answer-scanner', 'clarify-resume', 'pr-feedback'] as const)(
      'S6-#910: viewerDidAuthor=false on %s → no warn (healthy path)',
      (surface) => {
        const c = ctx();
        const decision = isTrustedCommentAuthor(
          makeComment({ authorAssociation: 'NONE', viewerDidAuthor: false }),
          surface,
          c,
        );
        expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
        expect(c.logger.warn).not.toHaveBeenCalled();
      },
    );

    it.each(['answer-scanner', 'clarify-resume', 'pr-feedback'] as const)(
      'S7-#910: viewerDidAuthor=true on %s → trusted, no warn (healthy self-authored)',
      (surface) => {
        const c = ctx();
        const decision = isTrustedCommentAuthor(
          makeComment({ authorAssociation: 'NONE', viewerDidAuthor: true }),
          surface,
          c,
        );
        expect(decision).toEqual({ trusted: true, reason: 'self-authored' });
        expect(c.logger.warn).not.toHaveBeenCalled();
      },
    );

    it('S6: botLogin wins over viewerDidAuthor=true (decision 1 fires first)', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({
          author: 'mybot',
          authorAssociation: 'NONE',
          viewerDidAuthor: true,
        }),
        'pr-feedback',
        ctx({ botLogin: 'mybot' }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'bot' });
    });

    it('S7: rule is surface-agnostic (answer-scanner still trusts self-authored)', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ viewerDidAuthor: true, authorAssociation: 'NONE' }),
        'answer-scanner',
        ctx(),
      );
      expect(decision).toEqual({ trusted: true, reason: 'self-authored' });
    });
  });

  // normalizeLogin coverage — the bot-login path still uses it (decision 1).
  // Cluster-identity fixture matrix (16 positive + 4 negative) removed in
  // #878 with the login-comparison self-recognition path.
  describe('normalizeLogin (bot-login path only after #878)', () => {
    const BOT_POSITIVE_PAIRS: Array<[string, string]> = [
      ['generacy-ai', 'generacy-ai'],
      ['generacy-ai', 'generacy-ai[bot]'],
      ['generacy-ai[bot]', 'generacy-ai'],
      ['generacy-ai[bot]', 'generacy-ai[bot]'],
      ['Generacy-AI', 'generacy-ai'],
      ['Generacy-AI[bot]', 'generacy-ai[bot]'],
      [' generacy-ai ', 'generacy-ai'],
      [' Generacy-AI[bot] ', 'generacy-ai[bot]'],
    ];

    it.each(BOT_POSITIVE_PAIRS)(
      'botLogin pair (%j, %j) resolves to trust reason bot',
      (provisioned, observed) => {
        const decision = isTrustedCommentAuthor(
          makeComment({ author: observed, authorAssociation: 'NONE' }),
          'pr-feedback',
          ctx({ botLogin: provisioned }),
        );
        expect(decision).toEqual({ trusted: true, reason: 'bot' });
      },
    );

    it.each([
      ['', ''],
      ['   ', ''],
      ['[bot]', ''],
      [' [bot] ', ''],
      ['A[BOT]', 'a'],
    ])('normalizeLogin(%j) === %j', (input, expected) => {
      expect(normalizeLogin(input)).toBe(expected);
    });

    it('empty botLogin after normalization does not fire bot branch', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: '', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ botLogin: '[bot]' }),
      );
      expect(decision.reason).not.toBe('bot');
    });
  });

  describe('config cannot narrow defaults', () => {
    it('OWNER/MEMBER/COLLABORATOR always trusted regardless of config shape', () => {
      // Even with a bizarre config that omits everything, defaults win.
      const config: CommentTrustConfig = { widen: { tiers: [], logins: [] } };
      for (const tier of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        const decision = isTrustedCommentAuthor(
          makeComment({ authorAssociation: tier }),
          'answer-scanner',
          ctx({ config }),
        );
        expect(decision.trusted).toBe(true);
      }
    });
  });
});
