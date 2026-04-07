import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, normalize, dirname } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/** Allowed path prefixes for file operations */
const ALLOWED_PREFIXES = ['.generacy/'];

/**
 * Validate and resolve a file path from the query parameter.
 * Returns the resolved absolute path or an error response object.
 */
function validatePath(
  filePath: string | undefined,
): { resolved: string } | { error: string; reason: string } {
  if (!filePath || typeof filePath !== 'string') {
    return { error: 'Access denied', reason: 'missing-path' };
  }

  // Block path traversal
  const normalized = normalize(filePath);
  if (normalized.includes('..')) {
    return { error: 'Access denied', reason: 'path-traversal' };
  }

  // Enforce prefix allowlist
  const allowed = ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!allowed) {
    return { error: 'Access denied', reason: 'disallowed-prefix' };
  }

  const resolved = resolve(process.cwd(), normalized);
  return { resolved };
}

/**
 * Setup file read/write routes.
 *
 * These routes are used by the cloud API (via relay) to read and write
 * workspace files such as .generacy/cluster.yaml.
 */
export async function setupFileRoutes(server: FastifyInstance): Promise<void> {
  // GET /files?path=<relative-path>
  server.get(
    '/files',
    {
      schema: {
        description: 'Read a file from the workspace',
        tags: ['Files'],
        querystring: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { path: string } }>, reply: FastifyReply) => {
      const result = validatePath(request.query.path);

      if ('error' in result) {
        return reply.status(403).send({
          error: result.error,
          path: request.query.path,
          reason: result.reason,
        });
      }

      if (!existsSync(result.resolved)) {
        return reply.status(404).send({
          error: 'File not found',
          path: request.query.path,
        });
      }

      const content = await readFile(result.resolved, 'utf-8');
      const stat = statSync(result.resolved);

      return reply.send({
        content,
        mtime: stat.mtime.toISOString(),
      });
    },
  );

  // PUT /files?path=<relative-path>
  server.put(
    '/files',
    {
      schema: {
        description: 'Write a file to the workspace',
        tags: ['Files'],
        querystring: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
        body: {
          type: 'object',
          properties: {
            content: { type: 'string' },
          },
          required: ['content'],
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { path: string }; Body: { content: string } }>,
      reply: FastifyReply,
    ) => {
      const result = validatePath(request.query.path);

      if ('error' in result) {
        return reply.status(403).send({
          error: result.error,
          path: request.query.path,
          reason: result.reason,
        });
      }

      const existed = existsSync(result.resolved);

      // Ensure parent directory exists
      await mkdir(dirname(result.resolved), { recursive: true });

      await writeFile(result.resolved, request.body.content, 'utf-8');
      const stat = statSync(result.resolved);

      return reply.status(existed ? 200 : 201).send({
        mtime: stat.mtime.toISOString(),
      });
    },
  );
}
