import { describe, it, expect, vi } from 'vitest';
import { credentialFilePlugin } from '../plugins/core/credential-file.js';

describe('credential-file plugin', () => {
  describe('resolve', () => {
    it('reads base64 blob from backend and returns it as a secret', async () => {
      const base64Blob = Buffer.from('hello world').toString('base64');
      const mockBackend = {
        fetchSecret: vi.fn().mockResolvedValue(base64Blob),
      };

      const result = await credentialFilePlugin.resolve!({
        credentialId: 'test-file',
        backendKey: 'file/test',
        backend: mockBackend as any,
        config: {},
      });

      expect(result.value).toBe(base64Blob);
      expect(result.format).toBe('blob');
      expect(mockBackend.fetchSecret).toHaveBeenCalledWith('file/test');
    });
  });

  describe('renderExposure', () => {
    it('returns decoded bytes as PluginFileExposure for file kind', () => {
      const base64Blob = Buffer.from('hello world').toString('base64');
      const secret = { value: base64Blob, format: 'blob' as const };
      const cfg = { kind: 'file' as const, path: '/tmp/test.txt', mode: 0o600 };

      const result = credentialFilePlugin.renderExposure('file', secret, cfg);

      expect(result.kind).toBe('file');
      if (result.kind === 'file') {
        expect(Buffer.isBuffer(result.data)).toBe(true);
        expect(result.data.toString()).toBe('hello world');
        expect(result.path).toBe('/tmp/test.txt');
        expect(result.mode).toBe(0o600);
      }
    });

    it('throws for unsupported exposure kind', () => {
      const secret = { value: 'data', format: 'blob' as const };
      const cfg = { kind: 'env' as const, name: 'TEST' };

      expect(() => credentialFilePlugin.renderExposure('env', secret, cfg)).toThrow(
        'Unsupported exposure kind: env',
      );
    });
  });

  it('has correct type and supportedExposures', () => {
    expect(credentialFilePlugin.type).toBe('credential-file');
    expect(credentialFilePlugin.supportedExposures).toEqual(['file']);
  });
});
