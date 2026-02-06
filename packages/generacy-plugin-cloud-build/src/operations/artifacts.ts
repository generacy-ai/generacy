/**
 * Artifact operations for the Cloud Build plugin.
 *
 * Handles:
 * - Listing build artifacts
 * - Downloading artifacts (Buffer mode for ≤100MB)
 * - Streaming artifacts (ReadableStream for large files)
 */

import type { CloudBuildClient } from '@google-cloud/cloudbuild';
import type { Storage } from '@google-cloud/storage';
import type { Logger } from 'pino';
import type { CloudBuildConfig } from '../config/types.js';
import type { Artifact } from '../types/artifacts.js';
import { MAX_ARTIFACT_SIZE_BYTES } from '../types/artifacts.js';
import { NotFoundError, ValidationError, CloudBuildError } from '../errors.js';
import { mapApiError } from '../client.js';

export class ArtifactOperations {
  constructor(
    private readonly cloudBuildClient: CloudBuildClient,
    private readonly storage: Storage,
    private readonly config: CloudBuildConfig,
    private readonly logger: Logger
  ) {}

  /**
   * List artifacts for a build.
   */
  async listArtifacts(buildId: string): Promise<Artifact[]> {
    this.logger.debug({ buildId }, 'Listing artifacts');

    try {
      // Get the build to find artifact information
      const [build] = await this.cloudBuildClient.getBuild({
        projectId: this.config.projectId,
        id: buildId,
      });

      if (!build) {
        throw new NotFoundError('Build', buildId);
      }

      // Get artifacts from build results and config
      const artifacts: Artifact[] = [];

      // Check for object artifacts
      const artifactConfig = build.artifacts?.objects;
      if (artifactConfig?.location && artifactConfig?.paths) {
        const bucketMatch = artifactConfig.location.match(/^gs:\/\/([^/]+)(?:\/(.*))?$/);
        if (bucketMatch) {
          const bucketName = bucketMatch[1];
          const prefix = bucketMatch[2] || '';

          if (bucketName) {
            const bucket = this.storage.bucket(bucketName);

            for (const pathPattern of artifactConfig.paths) {
              const fullPrefix = prefix ? `${prefix}/${pathPattern.replace(/\*\*?/g, '')}` : pathPattern.replace(/\*\*?/g, '');

              const [files] = await bucket.getFiles({
                prefix: fullPrefix,
              });

              for (const file of files) {
                const [metadata] = await file.getMetadata();

                artifacts.push({
                  path: file.name,
                  bucket: bucketName,
                  size: parseInt(metadata.size as string) || 0,
                  contentType: metadata.contentType ?? undefined,
                  generation: metadata.generation?.toString(),
                  md5Hash: metadata.md5Hash ?? undefined,
                  crc32c: metadata.crc32c ?? undefined,
                  updated: new Date(metadata.updated as string),
                });
              }
            }
          }
        }
      }

      // Also check explicit artifact bucket in config
      if (this.config.artifactBucket) {
        const bucket = this.storage.bucket(this.config.artifactBucket);
        const buildPrefix = `builds/${buildId}/`;

        const [files] = await bucket.getFiles({ prefix: buildPrefix });

        for (const file of files) {
          // Avoid duplicates
          if (artifacts.some(a => a.path === file.name && a.bucket === this.config.artifactBucket)) {
            continue;
          }

          const [metadata] = await file.getMetadata();

          artifacts.push({
            path: file.name,
            bucket: this.config.artifactBucket,
            size: parseInt(metadata.size as string) || 0,
            contentType: metadata.contentType ?? undefined,
            generation: metadata.generation?.toString(),
            md5Hash: metadata.md5Hash ?? undefined,
            crc32c: metadata.crc32c ?? undefined,
            updated: new Date(metadata.updated as string),
          });
        }
      }

      return artifacts;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof CloudBuildError) {
        throw error;
      }
      throw mapApiError(error, { buildId });
    }
  }

  /**
   * Download an artifact as a Buffer.
   * Throws if artifact exceeds 100MB.
   */
  async getArtifact(buildId: string, path: string): Promise<Buffer> {
    this.logger.debug({ buildId, path }, 'Getting artifact');

    // Find the artifact to get its metadata
    const artifacts = await this.listArtifacts(buildId);
    const artifact = artifacts.find(a => a.path === path || a.path.endsWith(`/${path}`));

    if (!artifact) {
      throw new NotFoundError('Artifact', path);
    }

    // Check size limit
    if (artifact.size > MAX_ARTIFACT_SIZE_BYTES) {
      throw new ValidationError(
        `Artifact size (${artifact.size} bytes) exceeds maximum of ${MAX_ARTIFACT_SIZE_BYTES} bytes. Use getArtifactStream() for large files.`,
        'size'
      );
    }

    try {
      const bucket = this.storage.bucket(artifact.bucket);
      const file = bucket.file(artifact.path);

      const [contents] = await file.download();
      return contents;
    } catch (error) {
      throw mapApiError(error, { buildId, path });
    }
  }

  /**
   * Download an artifact as a ReadableStream.
   * Use for large files that exceed the 100MB Buffer limit.
   */
  async getArtifactStream(buildId: string, path: string): Promise<ReadableStream> {
    this.logger.debug({ buildId, path }, 'Getting artifact stream');

    // Find the artifact
    const artifacts = await this.listArtifacts(buildId);
    const artifact = artifacts.find(a => a.path === path || a.path.endsWith(`/${path}`));

    if (!artifact) {
      throw new NotFoundError('Artifact', path);
    }

    try {
      const bucket = this.storage.bucket(artifact.bucket);
      const file = bucket.file(artifact.path);

      // Create a Node.js readable stream
      const nodeStream = file.createReadStream();

      // Convert Node.js stream to Web ReadableStream
      return new ReadableStream({
        start(controller) {
          nodeStream.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });

          nodeStream.on('end', () => {
            controller.close();
          });

          nodeStream.on('error', (error: Error) => {
            controller.error(error);
          });
        },

        cancel() {
          nodeStream.destroy();
        },
      });
    } catch (error) {
      throw mapApiError(error, { buildId, path });
    }
  }
}
