// Duplicate type plugin — same type as mock plugin ('mock')
import { z } from 'zod';

const credentialSchema = z.object({
  token: z.string(),
});

const plugin = {
  type: 'mock',
  credentialSchema,
  supportedExposures: ['env'],
  renderExposure(kind, secret, cfg) {
    return { kind: 'env', entries: [{ key: 'DUPLICATE', value: secret.value }] };
  },
};

export default plugin;
