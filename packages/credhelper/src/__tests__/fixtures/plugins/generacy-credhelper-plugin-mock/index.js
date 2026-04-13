// Mock credential type plugin implementing CredentialTypePlugin interface
import { z } from 'zod';

const credentialSchema = z.object({
  token: z.string(),
});

const plugin = {
  type: 'mock',
  credentialSchema,
  supportedExposures: ['env'],
  renderExposure(kind, secret, cfg) {
    return { kind: 'env', entries: [{ key: cfg.name || 'MOCK_TOKEN', value: secret.value }] };
  },
};

export default plugin;
