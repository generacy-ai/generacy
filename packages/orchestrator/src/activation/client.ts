// Re-export client functions from the shared activation-client package.
// The orchestrator wraps these with file-based persistence in index.ts.
export {
  NativeHttpClient,
  initDeviceFlow as requestDeviceCode,
  pollDeviceCode,
} from '@generacy-ai/activation-client';
