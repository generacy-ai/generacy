// Re-export the shared fetchLaunchConfig from the launch command.
// Both deploy and launch use the same cloud endpoint for compose config.
export { fetchLaunchConfig } from '../launch/cloud-client.js';
export type { LaunchConfig } from '../launch/types.js';
