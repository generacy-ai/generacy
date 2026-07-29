/**
 * Fake cloud gate-doc store for the #1068 run-scoped-gate verification harness.
 *
 * In-memory stand-in for the generacy-cloud Firestore
 * `organizations/{orgId}/cockpitGates/{gateId}` collection. Backs the fake HTTP
 * handler that services `GET /cockpit/gates` for `CloudGateQueryClient`.
 *
 * See specs/1068-problem-gate-identity-work/contracts/fake-cloud-store.md and
 * specs/1068-problem-gate-identity-work/data-model.md §E1 / §E2.
 */
import {
  deriveGateId,
  deriveGateKey,
  type GateType,
  type GateOption,
} from '@generacy-ai/cockpit';
import type { GateOpenWire } from '../../../../generacy/src/cli/commands/cockpit/mcp/gates/schemas.js';

/** Fake-peer augments GateOpenWire with a raw `runId` field (stripped by the
 *  wire schema itself). The store uses it to key the doc correctly. */
type GateOpenWireWithRunId = GateOpenWire & { runId?: string };

export type CloudGateStatus =
  | 'open'
  | 'answered'
  | 'delivered'
  | 'applied'
  | 'superseded'
  | 'failed'
  | 'expired';

export type WireOutcome = 'applied' | 'superseded' | 'failed';

export interface GateDoc {
  gateId: string;
  gateKey: string;
  gateType: GateType;
  issueRef: string;
  epicRef: string;
  /** Present on Phase-A-and-later docs; ABSENT on hand-crafted pre-Phase-A docs (FR-009). */
  generation?: string;
  /** Optional per-run discriminator (#1067). */
  runId?: string;
  issueTitle: string;
  issueUrl: string;
  title: string;
  body: string;
  options: GateOption[];
  allowFreeText: boolean;
  sessionId: string;
  askedAt: string;
  status: CloudGateStatus;
  lastOutcome?: {
    outcome: WireOutcome;
    detail?: string;
    at: string;
  };
}

export interface FakeCloudStoreOptions {
  /**
   * When false, `putGateFromWireFrame` drops the `generation` field before
   * storing (Phase A revert simulation).
   * Default: true.
   */
  persistGeneration?: boolean;
}

export interface FakeCloudStore {
  putGateFromWireFrame(payload: GateOpenWireWithRunId): void;
  applyOutcome(gateId: string, outcome: WireOutcome, detail?: string): void;
  putRaw(doc: GateDoc): void;
  getByKey(
    issueRef: string,
    gateType: GateType,
    generation: string | number,
    runId?: string,
  ): GateDoc | null;
  listByIssueRef(issueRef: string, gateType?: GateType): GateDoc[];
  readonly all: ReadonlyArray<GateDoc>;
}

/**
 * Extract `generation` out of a wire `gateKey` of shape
 * `${issueRef}:${gateType}:${generation}[:${runId}]`. `generation` can itself
 * contain colons (e.g. `artifact-review:spec-review:abc123`), so we cannot
 * just split on `:`. Instead: locate `:${gateType}:` and take everything after
 * it, then strip the `:${runId}` suffix when `runId` is known.
 */
function extractGenerationFromKey(
  gateKey: string,
  gateType: string,
  runId?: string,
): string {
  const marker = `:${gateType}:`;
  const idx = gateKey.indexOf(marker);
  if (idx < 0) return '';
  let tail = gateKey.slice(idx + marker.length);
  if (runId !== undefined) {
    const suffix = `:${runId}`;
    if (tail.endsWith(suffix)) {
      tail = tail.slice(0, tail.length - suffix.length);
    }
  }
  return tail;
}

export function createFakeCloudStore(
  options: FakeCloudStoreOptions = {},
): FakeCloudStore {
  const persistGeneration = options.persistGeneration ?? true;
  const store = new Map<string, GateDoc>();

  return {
    putGateFromWireFrame(payload) {
      // `payload.runId` is copied from the raw frame by the fake-peer; the
      // frozen wire schema strips it.
      const generation = extractGenerationFromKey(
        payload.gateKey,
        payload.gateType,
        payload.runId,
      );

      // Upsert on `gateId` (as the tool derived it). Phase-A revert is
      // simulated by (a) dropping `generation` from the stored doc and (b)
      // making `getByKey` return null when it's called with a `generation`
      // arg (see getByKey below). This preserves the ability to `applyOutcome`
      // on the same gateId + surface the doc in list mode with the fallback
      // sentinel, while still making the generation-scoped lookup miss.
      const existing = store.get(payload.gateId);
      const doc: GateDoc = {
        gateId: payload.gateId,
        gateKey: existing?.gateKey ?? payload.gateKey,
        gateType: payload.gateType,
        issueRef: payload.issueRef,
        epicRef: payload.epicRef,
        ...(persistGeneration && generation.length > 0
          ? { generation }
          : {}),
        ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
        issueTitle: payload.issueTitle,
        issueUrl: payload.issueUrl,
        title: payload.title,
        body: payload.body,
        options: payload.options,
        allowFreeText: payload.allowFreeText,
        sessionId: payload.sessionId,
        askedAt: existing?.askedAt ?? payload.askedAt,
        status: existing?.status ?? 'open',
        ...(existing?.lastOutcome !== undefined ? { lastOutcome: existing.lastOutcome } : {}),
      };
      store.set(payload.gateId, doc);
    },

    applyOutcome(gateId, outcome, detail) {
      const doc = store.get(gateId);
      if (doc == null) return; // no-op — matches real cloud "unknown gate → drop"
      const at = new Date().toISOString();
      doc.status = outcome;
      doc.lastOutcome = detail !== undefined
        ? { outcome, detail, at }
        : { outcome, at };
    },

    putRaw(doc) {
      if (doc.gateId.length !== 24) {
        throw new Error('FakeCloudStore.putRaw: invalid gateId length');
      }
      store.set(doc.gateId, { ...doc });
    },

    getByKey(issueRef, gateType, generation, runId) {
      const lookupKey = deriveGateKey(issueRef, gateType, String(generation), runId);
      const lookupId = deriveGateId(lookupKey);
      const doc = store.get(lookupId) ?? null;
      // Phase-A revert: cloud doesn't persist `generation`, so a
      // generation-scoped lookup returns null even if a doc with the exact
      // derived id exists — the cloud has no way to confirm the match.
      if (doc != null && !persistGeneration) return null;
      return doc;
    },

    listByIssueRef(issueRef, gateType) {
      const result: GateDoc[] = [];
      for (const doc of store.values()) {
        if (doc.issueRef !== issueRef) continue;
        if (gateType !== undefined && doc.gateType !== gateType) continue;
        result.push(doc);
      }
      return result;
    },

    get all() {
      return Array.from(store.values());
    },
  };
}
