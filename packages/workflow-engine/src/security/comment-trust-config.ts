/**
 * Workspace-level comment-trust config loader.
 *
 * Reads `.agency/comment-trust.yaml` from the workspace root. Missing /
 * malformed / invalid → `undefined` (default posture, no throw).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Logger } from '../types/logger.js';

export const CommentTrustConfigSchema = z
  .object({
    widen: z
      .object({
        tiers: z.array(z.string()).default([]),
        logins: z.array(z.string()).default([]),
      })
      .strict()
      .default({ tiers: [], logins: [] }),
  })
  .strict();

export type CommentTrustConfig = z.infer<typeof CommentTrustConfigSchema>;

export const COMMENT_TRUST_CONFIG_RELATIVE_PATH = '.agency/comment-trust.yaml';

export function tryLoadCommentTrustConfig(
  workspaceDir: string,
  logger?: Logger,
): CommentTrustConfig | undefined {
  const configPath = join(workspaceDir, COMMENT_TRUST_CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    // Missing file → default posture. No warn.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    logger?.warn('comment-trust config: failed to read file, using default posture', {
      path: configPath,
      error: (err as Error).message,
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    logger?.warn('comment-trust config: malformed YAML, using default posture', {
      path: configPath,
      error: (err as Error).message,
    });
    return undefined;
  }

  // Empty file / null → default posture.
  if (parsed === null || parsed === undefined) {
    return CommentTrustConfigSchema.parse({});
  }

  const result = CommentTrustConfigSchema.safeParse(parsed);
  if (!result.success) {
    const failedField = result.error.issues[0]?.path.join('.') ?? '<unknown>';
    logger?.warn('comment-trust config: schema violation, using default posture', {
      path: configPath,
      failedField,
      message: result.error.issues[0]?.message,
    });
    return undefined;
  }

  return result.data;
}
