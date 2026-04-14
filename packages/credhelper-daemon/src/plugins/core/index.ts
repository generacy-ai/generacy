import type { CredentialTypePlugin } from '@generacy-ai/credhelper';

import { githubAppPlugin } from './github-app.js';
import { githubPatPlugin } from './github-pat.js';
import { gcpServiceAccountPlugin } from './gcp-service-account.js';
import { awsStsPlugin } from './aws-sts.js';
import { stripeRestrictedKeyPlugin } from './stripe-restricted-key.js';
import { apiKeyPlugin } from './api-key.js';
import { envPassthroughPlugin } from './env-passthrough.js';

/**
 * All 7 core credential type plugins, statically registered.
 * These are registered directly by the daemon — no discovery pipeline needed.
 */
export const CORE_PLUGINS: ReadonlyArray<CredentialTypePlugin> = [
  githubAppPlugin,
  githubPatPlugin,
  gcpServiceAccountPlugin,
  awsStsPlugin,
  stripeRestrictedKeyPlugin,
  apiKeyPlugin,
  envPassthroughPlugin,
];
