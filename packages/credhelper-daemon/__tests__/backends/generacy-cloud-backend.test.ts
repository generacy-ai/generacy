import { GeneracyCloudBackend } from '../../src/backends/generacy-cloud-backend.js';
import { CredhelperError } from '../../src/errors.js';

describe('GeneracyCloudBackend', () => {
  const backend = new GeneracyCloudBackend();

  it('throws NOT_IMPLEMENTED for any key', async () => {
    try {
      await backend.fetchSecret('any-key');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredhelperError);
      expect((err as CredhelperError).code).toBe('NOT_IMPLEMENTED');
      expect((err as CredhelperError).message).toContain('generacy-cloud');
    }
  });
});
