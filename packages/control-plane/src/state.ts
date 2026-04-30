import type { ClusterState, ClusterStatus, DeploymentMode, ClusterVariant } from './schemas.js';

const VALID_TRANSITIONS: Record<ClusterStatus, ClusterStatus[]> = {
  bootstrapping: ['ready', 'error'],
  ready: ['degraded', 'error'],
  degraded: ['ready', 'error'],
  error: [],
};

let state: ClusterState = {
  status: 'bootstrapping',
  deploymentMode: 'local',
  variant: 'cluster-base',
  lastSeen: new Date().toISOString(),
};

export function initClusterState(config: {
  deploymentMode?: DeploymentMode;
  variant?: ClusterVariant;
}): void {
  state = {
    status: 'bootstrapping',
    deploymentMode: config.deploymentMode ?? 'local',
    variant: config.variant ?? 'cluster-base',
    lastSeen: new Date().toISOString(),
  };
}

export function updateClusterStatus(
  status: ClusterStatus,
  statusReason?: string,
): void {
  const allowed = VALID_TRANSITIONS[state.status];
  if (!allowed.includes(status)) {
    throw new Error(
      `Invalid state transition: ${state.status} → ${status}`,
    );
  }

  state = {
    ...state,
    status,
    lastSeen: new Date().toISOString(),
    statusReason,
  };
}

export function getClusterState(): ClusterState {
  return {
    ...state,
    lastSeen: new Date().toISOString(),
  };
}
