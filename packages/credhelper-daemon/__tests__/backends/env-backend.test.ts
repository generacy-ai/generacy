import { EnvBackend } from '../../src/backends/env-backend.js';
import { CredhelperError } from '../../src/errors.js';

describe('EnvBackend', () => {
  const backend = new EnvBackend();

  it('returns the value when the environment variable exists', async () => {
    process.env['CREDHELPER_TEST_KEY'] = 'my-secret';
    try {
      const value = await backend.fetchSecret('CREDHELPER_TEST_KEY');
      expect(value).toBe('my-secret');
    } finally {
      delete process.env['CREDHELPER_TEST_KEY'];
    }
  });

  it('throws BACKEND_SECRET_NOT_FOUND when the key is undefined', async () => {
    delete process.env['CREDHELPER_TEST_MISSING'];
    try {
      await backend.fetchSecret('CREDHELPER_TEST_MISSING');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('BACKEND_SECRET_NOT_FOUND');
      expect((err as CredhelperError).message).toContain('CREDHELPER_TEST_MISSING');
    }
  });

  it('returns empty string when the value is empty', async () => {
    process.env['CREDHELPER_TEST_EMPTY'] = '';
    try {
      const value = await backend.fetchSecret('CREDHELPER_TEST_EMPTY');
      expect(value).toBe('');
    } finally {
      delete process.env['CREDHELPER_TEST_EMPTY'];
    }
  });

  it('returns whitespace value as-is', async () => {
    process.env['CREDHELPER_TEST_WS'] = '  spaces  ';
    try {
      const value = await backend.fetchSecret('CREDHELPER_TEST_WS');
      expect(value).toBe('  spaces  ');
    } finally {
      delete process.env['CREDHELPER_TEST_WS'];
    }
  });
});
