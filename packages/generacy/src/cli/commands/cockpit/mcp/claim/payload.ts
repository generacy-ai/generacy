/**
 * Type + Zod schema surface for the active-driver claim mechanism (#1015).
 *
 * The claim payload is the JSON body of the `<!-- cockpit:claim v1 -->` marker
 * comment posted on a scope issue. `ClaimPayloadSchema` is the runtime
 * source of truth — any wire boundary (marker parse, `cockpit_claim` input)
 * validates through it.
 */
import { z } from 'zod';

/** Regex shape for `sessionId` — opaque hex chars, caller-supplied. */
export const SESSION_ID_REGEX = /^[a-f0-9]{16,64}$/;

/** Regex shape for `scope` — `<owner>/<repo>#<n>`. */
export const CLAIM_SCOPE_REGEX = /^[^/\s]+\/[^/\s#]+#\d+$/;

export interface ClaimPayload {
  /** Marker format version — currently 1. */
  version: 1;
  /** Opaque per-MCP-server-process identifier; skill supplies INSTANCE_NONCE. */
  sessionId: string;
  /** ISO-8601 UTC; original acquire time (never mutated by refresh). */
  heldSince: string;
  /** ISO-8601 UTC; updated on every heartbeat/refresh. */
  heartbeatAt: string;
  /** Relative path to the session's ledger. */
  ledger: string;
  /** Scope ref as `<owner>/<repo>#<n>`. */
  scope: string;
}

export const ClaimPayloadSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().regex(SESSION_ID_REGEX, {
      message: 'sessionId must be 16-64 hex chars',
    }),
    heldSince: z.string().datetime({ offset: true }),
    heartbeatAt: z.string().datetime({ offset: true }),
    ledger: z.string().min(1).max(512),
    scope: z.string().regex(CLAIM_SCOPE_REGEX, {
      message: 'scope must be "<owner>/<repo>#<n>"',
    }),
  })
  .strict();

export interface LiveClaim {
  payload: ClaimPayload;
  commentId: number;
  commentUrl: string;
}

export type DiscoverResult =
  | { kind: 'no-claim' }
  | {
      kind: 'held';
      live: LiveClaim;
      /**
       * True when a live claim exists but the enumeration label
       * `cockpit:claimed` is NOT applied — an inconsistency that acquire /
       * refresh should reconcile by idempotently re-applying the label.
       * Not load-bearing (callers can just always `addLabels`), but useful
       * for tests + observability.
       */
      orphanedLabelPresent: boolean;
    };

export type AcquireResult =
  | {
      status: 'ok';
      action: 'acquired';
      claim: ClaimPayload;
      commentUrl: string;
    }
  | {
      status: 'ok';
      action: 'refreshed';
      claim: ClaimPayload;
      commentUrl: string;
    }
  | {
      status: 'ok';
      action: 'taken-over';
      claim: ClaimPayload;
      commentUrl: string;
      displaced: ClaimPayload;
    };

export type ReleaseResult =
  | {
      status: 'ok';
      action: 'released';
      releasedClaim: ClaimPayload;
    }
  | {
      status: 'ok';
      action: 'not-holder';
      currentHolder?: ClaimPayload;
    }
  | {
      status: 'ok';
      action: 'no-claim';
    };

/**
 * Refusal shape emitted by `cockpit_claim` when a different session holds the
 * claim and `takeover: false`. Extends the shared `ToolErrorResult` with
 * `holder` + `commentUrl`.
 */
export interface RefusalPayload {
  status: 'error';
  class: 'claim-conflict';
  detail: string;
  hint: string;
  holder: ClaimPayload;
  commentUrl: string;
}
