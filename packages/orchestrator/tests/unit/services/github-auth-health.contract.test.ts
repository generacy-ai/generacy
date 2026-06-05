import { describe, it, expect } from 'vitest';
import { GitHubAuthHealthService } from '../../../src/services/github-auth-health.js';
import {
  CredentialsEventPayloadSchema,
  GitHubAuthSnapshotSchema,
  type CredentialsEventPayload,
} from '../../../src/types/github-auth.js';

/**
 * Contract tests: every event payload emitted by the service must satisfy
 * `CredentialsEventPayloadSchema` (mirror of contracts/cluster-credentials-event.schema.json),
 * and every snapshot must satisfy `GitHubAuthSnapshotSchema` (mirror of
 * contracts/github-auth-health.schema.json). Discriminator drift caught here.
 */
describe('contracts: cluster.credentials event payload + githubAuth snapshot', () => {
  function newService() {
    const emitted: CredentialsEventPayload[] = [];
    const service = new GitHubAuthHealthService({
      emitEvent: (p) => emitted.push(p),
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      now: () => 1_700_000_000_000,
    });
    return { service, emitted };
  }

  it('refresh-requested payload validates against contract', () => {
    const { service, emitted } = newService();
    service.setCredentials([
      { credentialId: 'primary', type: 'github-app', expiresAt: '2030-01-01T00:00:00.000Z' },
    ]);
    service.maybeRequestRefresh('primary', 'near-expiry');
    expect(emitted).toHaveLength(1);
    const result = CredentialsEventPayloadSchema.safeParse(emitted[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('refresh-requested');
    }
  });

  it('auth-failed + refresh-requested (auth-401) payloads validate against contract', () => {
    const { service, emitted } = newService();
    service.setCredentials([{ credentialId: 'primary', type: 'github-app' }]);
    service.recordResult('primary', { ok: false, statusCode: 401 });
    // Should produce one auth-failed and one refresh-requested (auth-401)
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const p of emitted) {
      const r = CredentialsEventPayloadSchema.safeParse(p);
      expect(r.success).toBe(true);
    }
    expect(emitted.some((e) => e.action === 'auth-failed')).toBe(true);
    expect(emitted.some((e) => e.action === 'refresh-requested')).toBe(true);
  });

  it('auth-recovered payload validates against contract', () => {
    const { service, emitted } = newService();
    service.setCredentials([{ credentialId: 'primary', type: 'github-app' }]);
    service.recordResult('primary', { ok: false, statusCode: 401 });
    emitted.length = 0;
    service.recordResult('primary', { ok: true });
    expect(emitted).toHaveLength(1);
    const result = CredentialsEventPayloadSchema.safeParse(emitted[0]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('auth-recovered');
    }
  });

  it('snapshot is valid in unknown state', () => {
    const { service } = newService();
    expect(GitHubAuthSnapshotSchema.safeParse(service.snapshot()).success).toBe(true);
  });

  it('snapshot is valid in ok state', () => {
    const { service } = newService();
    service.setCredentials([
      { credentialId: 'primary', type: 'github-app', expiresAt: '2030-01-01T00:00:00.000Z' },
    ]);
    service.recordResult('primary', { ok: true });
    expect(GitHubAuthSnapshotSchema.safeParse(service.snapshot()).success).toBe(true);
  });

  it('snapshot is valid in failing state', () => {
    const { service } = newService();
    service.setCredentials([{ credentialId: 'primary', type: 'github-app' }]);
    service.recordResult('primary', { ok: false, statusCode: 401 });
    expect(GitHubAuthSnapshotSchema.safeParse(service.snapshot()).success).toBe(true);
  });
});
