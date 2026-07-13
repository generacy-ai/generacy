/** Reserved provider for non-agent plugins (subprocess, shell). Internal — never exported from `index.ts`, never valid in workflow config. */
export const SYSTEM_PROVIDER = 'system' as const;

/** Default provider when `LaunchRequest.provider` is omitted. Internal — call sites must not depend on it. */
export const DEFAULT_PROVIDER = 'claude-code' as const;
