import { z } from 'zod';

export const RoleExposeSchema = z.object({
  as: z.enum(['env', 'git-credential-helper', 'gcloud-external-account', 'localhost-proxy', 'docker-socket-proxy']),
  name: z.string().optional(),
  port: z.number().optional(),
  envName: z.string().optional(),
});

export const RoleCredentialRefSchema = z.object({
  ref: z.string(),
  scope: z.record(z.unknown()).optional(),
  expose: z.array(RoleExposeSchema),
});

export const ProxyRuleSchema = z.object({
  method: z.string(),
  path: z.string(),
});

export const ProxyConfigSchema = z.object({
  upstream: z.string().url(),
  default: z.enum(['deny']),
  allow: z.array(ProxyRuleSchema),
});

export const DockerRuleSchema = z.object({
  method: z.string(),
  path: z.string(),
  name: z.string().optional(),
});

export const DockerConfigSchema = z.object({
  default: z.enum(['deny']),
  allow: z.array(DockerRuleSchema),
});

export const RoleConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  id: z.string(),
  description: z.string(),
  extends: z.string().optional(),
  credentials: z.array(RoleCredentialRefSchema),
  proxy: z.record(ProxyConfigSchema).optional(),
  docker: DockerConfigSchema.optional(),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type RoleCredentialRef = z.infer<typeof RoleCredentialRefSchema>;
export type RoleExpose = z.infer<typeof RoleExposeSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ProxyRule = z.infer<typeof ProxyRuleSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type DockerRule = z.infer<typeof DockerRuleSchema>;
