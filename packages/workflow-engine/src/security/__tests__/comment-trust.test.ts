import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '../../types/logger.js';
import type { Comment } from '../../types/github.js';
import {
  isTrustedCommentAuthor,
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
  return {
    id: 1,
    body: 'irrelevant',
    author: 'someone',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    ...overrides,
  };
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

  describe('cluster-identity (#869 / FR-001)', () => {
    it('T1: trusts cluster-identity match with authorAssociation=NONE', () => {
      for (const surface of SURFACES) {
        const decision = isTrustedCommentAuthor(
          makeComment({ author: 'cluster-app[bot]', authorAssociation: 'NONE' }),
          surface,
          ctx({ clusterIdentity: 'cluster-app[bot]' }),
        );
        expect(decision).toEqual({ trusted: true, reason: 'cluster-identity' });
      }
    });

    it('T2: cluster-identity wins on decision-order over OWNER tier', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'cluster-app[bot]', authorAssociation: 'OWNER' }),
        'pr-feedback',
        ctx({ clusterIdentity: 'cluster-app[bot]' }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'cluster-identity' });
    });

    it('T3: unrelated author with NONE tier still untrusted when clusterIdentity set', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'alice', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ clusterIdentity: 'cluster-app[bot]' }),
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
    });

    it('T4: clusterIdentity=undefined preserves pre-#869 behavior byte-for-byte', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'alice', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ clusterIdentity: undefined }),
      );
      expect(decision).toEqual({ trusted: false, reason: 'none-untrusted' });
    });

    it('T5: botLogin fires before clusterIdentity when only botLogin matches', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'mybot', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ botLogin: 'mybot', clusterIdentity: 'alice' }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'bot' });
    });

    it('T6: botLogin wins deterministically when both match same author (collision)', () => {
      const decision = isTrustedCommentAuthor(
        makeComment({ author: 'mybot', authorAssociation: 'NONE' }),
        'pr-feedback',
        ctx({ botLogin: 'mybot', clusterIdentity: 'mybot' }),
      );
      expect(decision).toEqual({ trusted: true, reason: 'bot' });
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
