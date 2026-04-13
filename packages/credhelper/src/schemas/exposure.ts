import { z } from 'zod';

export const ExposureConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string() }),
  z.object({ kind: z.literal('git-credential-helper') }),
  z.object({ kind: z.literal('gcloud-external-account') }),
  z.object({ kind: z.literal('localhost-proxy'), port: z.number() }),
  z.object({ kind: z.literal('docker-socket-proxy') }),
]);

export const ExposureOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('env'),
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  z.object({
    kind: z.literal('git-credential-helper'),
    script: z.string(),
  }),
  z.object({
    kind: z.literal('gcloud-external-account'),
    json: z.object({}).passthrough(),
  }),
  z.object({
    kind: z.literal('localhost-proxy'),
    proxyConfig: z.object({
      port: z.number(),
      upstream: z.string(),
      headers: z.record(z.string()),
    }),
  }),
  z.object({
    kind: z.literal('docker-socket-proxy'),
    socketPath: z.string(),
  }),
]);

export type ExposureConfigParsed = z.infer<typeof ExposureConfigSchema>;
export type ExposureOutputParsed = z.infer<typeof ExposureOutputSchema>;
