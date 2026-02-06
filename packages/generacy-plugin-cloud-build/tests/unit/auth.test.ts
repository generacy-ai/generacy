/**
 * Unit tests for the authentication provider.
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultAuthProvider, createAuthProvider } from '../../src/auth/auth-provider.js';
import { AuthError } from '../../src/errors.js';

// Mock the Google Cloud libraries
vi.mock('@google-cloud/cloudbuild', () => ({
  CloudBuildClient: vi.fn().mockImplementation((options) => ({
    projectId: options?.projectId,
    credentials: options?.credentials,
  })),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation((options) => ({
    projectId: options?.projectId,
    credentials: options?.credentials,
  })),
}));

describe('DefaultAuthProvider', () => {
  const validServiceAccountKey = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'key-id',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
    client_email: 'test@test-project.iam.gserviceaccount.com',
    client_id: '123456789',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com',
  });

  describe('constructor', () => {
    it('should create provider with projectId only (ADC)', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
      });

      expect(provider).toBeDefined();
    });

    it('should create provider with valid serviceAccountKey', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
        serviceAccountKey: validServiceAccountKey,
      });

      expect(provider).toBeDefined();
    });

    it('should throw AuthError for invalid JSON in serviceAccountKey', () => {
      expect(() => {
        new DefaultAuthProvider({
          projectId: 'test-project',
          serviceAccountKey: 'not-valid-json',
        });
      }).toThrow(AuthError);
    });

    it('should throw AuthError with descriptive message for invalid JSON', () => {
      try {
        new DefaultAuthProvider({
          projectId: 'test-project',
          serviceAccountKey: '{invalid}',
        });
        expect.fail('Expected AuthError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toBe('Invalid service account key JSON');
      }
    });
  });

  describe('getCloudBuildClient', () => {
    it('should return a CloudBuildClient instance', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
      });

      const client = provider.getCloudBuildClient();

      expect(client).toBeDefined();
      expect((client as { projectId: string }).projectId).toBe('test-project');
    });

    it('should return same instance on multiple calls', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
      });

      const client1 = provider.getCloudBuildClient();
      const client2 = provider.getCloudBuildClient();

      expect(client1).toBe(client2);
    });

    it('should pass credentials when serviceAccountKey is provided', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
        serviceAccountKey: validServiceAccountKey,
      });

      const client = provider.getCloudBuildClient();

      expect((client as { credentials: unknown }).credentials).toBeDefined();
    });
  });

  describe('getStorageClient', () => {
    it('should return a Storage instance', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
      });

      const storage = provider.getStorageClient();

      expect(storage).toBeDefined();
      expect((storage as { projectId: string }).projectId).toBe('test-project');
    });

    it('should return same instance on multiple calls', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
      });

      const storage1 = provider.getStorageClient();
      const storage2 = provider.getStorageClient();

      expect(storage1).toBe(storage2);
    });

    it('should pass credentials when serviceAccountKey is provided', () => {
      const provider = new DefaultAuthProvider({
        projectId: 'test-project',
        serviceAccountKey: validServiceAccountKey,
      });

      const storage = provider.getStorageClient();

      expect((storage as { credentials: unknown }).credentials).toBeDefined();
    });
  });
});

describe('createAuthProvider', () => {
  it('should create a DefaultAuthProvider', () => {
    const provider = createAuthProvider({
      projectId: 'test-project',
    });

    expect(provider).toBeInstanceOf(DefaultAuthProvider);
  });
});
