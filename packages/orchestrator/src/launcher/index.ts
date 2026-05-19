export { AgentLauncher } from './agent-launcher.js';
export { GenericSubprocessPlugin } from './generic-subprocess-plugin.js';
export { createAgentLauncher } from './launcher-setup.js';
export { CredhelperUnavailableError, CredhelperSessionError } from './credhelper-errors.js';
export { CredhelperHttpClient } from './credhelper-client.js';
export type { CredhelperClient, CredhelperClientOptions, BeginSessionResult } from './credhelper-client.js';
export {
  generateSessionId,
  buildSessionEnv,
  wrapCommand,
  applyCredentials,
} from './credentials-interceptor.js';
export type { InterceptorResult } from './credentials-interceptor.js';
export type {
  GenericSubprocessIntent,
  ShellIntent,
  LaunchIntent,
  LaunchRequest,
  LaunchSpec,
  AgentLaunchPlugin,
  OutputParser,
  LaunchHandle,
} from './types.js';
