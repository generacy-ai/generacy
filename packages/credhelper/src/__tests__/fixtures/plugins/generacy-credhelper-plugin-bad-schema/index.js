// Bad schema plugin — credentialSchema is not a valid Zod schema (missing .parse)
const plugin = {
  type: 'bad-schema',
  credentialSchema: { notASchema: true },
  supportedExposures: ['env'],
  renderExposure(kind, secret, cfg) {
    return { kind: 'env', entries: [] };
  },
};

export default plugin;
