/**
 * Identity-split detector.
 *
 * Compares `process.env.GENERACY_CLUSTER_ID` to the persisted
 * `cluster.json.cluster_id`. On mismatch, emits a single
 * `cluster.identity-split` relay event per orchestrator process lifetime.
 *
 * Never mutates env, .env, or cluster.json (FR-003).
 */
import type { FastifyBaseLogger } from 'fastify';
import { readClusterJson } from '../activation/persistence.js';

export interface IdentitySplitEvent {
  env_cluster_id: string;
  cluster_json_cluster_id: string;
  detected_at: string;
}

export type DetectionOutcome =
  | { kind: 'no-env'; envClusterId: undefined }
  | { kind: 'no-cluster-json'; envClusterId: string }
  | { kind: 'match'; clusterId: string }
  | {
      kind: 'mismatch';
      envClusterId: string;
      clusterJsonClusterId: string;
      emitted: boolean;
    };

export interface DetectIdentitySplitOptions {
  clusterJsonPath: string;
  env?: NodeJS.ProcessEnv;
  sendRelayEvent?: (
    channel: 'cluster.identity-split',
    payload: IdentitySplitEvent,
  ) => void;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

// Module-level once-guard. Container restart = fresh module = resets to false.
let hasEmitted = false;

/**
 * Test helper: reset the once-emitted flag. Not for production use.
 */
export function resetIdentitySplitDetectionState(): void {
  hasEmitted = false;
}

export async function detectIdentitySplit(
  options: DetectIdentitySplitOptions,
): Promise<DetectionOutcome> {
  const env = options.env ?? process.env;
  const envClusterId = env['GENERACY_CLUSTER_ID'];

  if (!envClusterId || envClusterId.length === 0) {
    return { kind: 'no-env', envClusterId: undefined };
  }

  const clusterJson = await readClusterJson(options.clusterJsonPath);
  if (!clusterJson) {
    return { kind: 'no-cluster-json', envClusterId };
  }

  if (envClusterId === clusterJson.cluster_id) {
    return { kind: 'match', clusterId: envClusterId };
  }

  // Mismatch detected
  if (hasEmitted) {
    options.logger.info(
      { envClusterId, clusterJsonClusterId: clusterJson.cluster_id },
      'Identity-split detected (already emitted this process lifetime — suppressing)',
    );
    return {
      kind: 'mismatch',
      envClusterId,
      clusterJsonClusterId: clusterJson.cluster_id,
      emitted: false,
    };
  }

  const payload: IdentitySplitEvent = {
    env_cluster_id: envClusterId,
    cluster_json_cluster_id: clusterJson.cluster_id,
    detected_at: new Date().toISOString(),
  };

  // Flip the once-guard before attempting send: a single attempt counts,
  // even if the send throws (quickstart.md: "single attempt counts").
  hasEmitted = true;

  options.logger.info(
    { envClusterId, clusterJsonClusterId: clusterJson.cluster_id },
    'Identity-split detected: emitting cluster.identity-split relay event',
  );

  try {
    options.sendRelayEvent?.('cluster.identity-split', payload);
  } catch (err) {
    options.logger.error(
      { err },
      'Failed to send cluster.identity-split relay event (swallowed)',
    );
  }

  return {
    kind: 'mismatch',
    envClusterId,
    clusterJsonClusterId: clusterJson.cluster_id,
    emitted: true,
  };
}
