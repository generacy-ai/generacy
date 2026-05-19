import fs from 'node:fs';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getLogger } from '../../utils/logger.js';
import { execSafe } from '../../utils/exec.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';
import { upsertRegistryEntry } from '../cluster/registry.js';
import {
  extractImageHost,
  materializeScopedDockerConfig,
  cleanupScopedDockerConfig,
  getScopedDockerConfigPath,
} from '../../utils/docker-config.js';

const CredentialValueResponseSchema = z.object({
  value: z.string(),
});

const RegistryCredentialValueSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * Fetch registry credential from control-plane via docker compose exec.
 * Returns { username, password } or undefined on any failure.
 */
function fetchRegistryCredential(
  ctx: { composePath: string; projectName: string; projectRoot: string; generacyDir: string },
  host: string,
): { username: string; password: string } | undefined {
  const logger = getLogger();
  const credentialId = `registry-${host}`;
  const curlCmd = `curl -sf --unix-socket /run/generacy-control-plane/control.sock http://localhost/credentials/${credentialId}/value`;
  const result = execSafe(
    `docker compose --project-name=${ctx.projectName} --file=${ctx.composePath} exec -T orchestrator ${curlCmd}`,
  );

  if (!result.ok) {
    logger.debug({ stderr: result.stderr }, 'Failed to exec into container for credential fetch');
    return undefined;
  }

  try {
    const json = JSON.parse(result.stdout);
    const response = CredentialValueResponseSchema.parse(json);
    const cred = RegistryCredentialValueSchema.parse(JSON.parse(response.value));
    return cred;
  } catch {
    logger.debug('Failed to parse credential response');
    return undefined;
  }
}

/**
 * Extract the image host from the compose file's orchestrator service.
 */
function getImageHostFromCompose(composePath: string): string | undefined {
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    const doc = parseYaml(content);
    const services = doc?.services;
    if (!services || typeof services !== 'object') return undefined;

    // Check orchestrator service first, fall back to first service with image
    const orchestrator = (services as Record<string, unknown>)['orchestrator'];
    const image = (orchestrator as Record<string, unknown> | undefined)?.image;
    if (typeof image === 'string') {
      return extractImageHost(image);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function updateCommand(): Command {
  return new Command('update')
    .description('Pull latest images and recreate changed containers')
    .action(async () => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();

      const imageHost = getImageHostFromCompose(ctx.composePath);
      let scopedConfig = false;

      if (imageHost) {
        const cred = fetchRegistryCredential(ctx, imageHost);
        if (cred) {
          materializeScopedDockerConfig({
            projectDir: ctx.projectRoot,
            host: imageHost,
            username: cred.username,
            password: cred.password,
          });
          scopedConfig = true;
        } else {
          logger.warn(
            'Cluster is offline or credentials not found; the update will use your machine\'s ambient docker login. ' +
            'If the image requires credentials stored on the cluster, start the cluster first with `generacy up`.',
          );
        }
      }

      try {
        const pullEnv = scopedConfig
          ? { DOCKER_CONFIG: getScopedDockerConfigPath(ctx.projectRoot) }
          : undefined;
        const pullResult = runCompose(ctx, ['pull'], pullEnv ? { env: pullEnv } : undefined);
        if (!pullResult.ok) {
          throw new Error(`Failed to pull images: ${pullResult.stderr || pullResult.stdout}`);
        }
      } finally {
        if (scopedConfig) {
          cleanupScopedDockerConfig(ctx.projectRoot);
        }
      }

      const upResult = runCompose(ctx, ['up', '-d']);
      if (!upResult.ok) {
        throw new Error(`Failed to recreate containers: ${upResult.stderr || upResult.stdout}`);
      }

      upsertRegistryEntry(ctx);
      logger.info('Cluster updated.');
    });
}
