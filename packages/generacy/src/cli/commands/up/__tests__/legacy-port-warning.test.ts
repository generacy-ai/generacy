import { describe, it, expect } from 'vitest';
import { hasLegacyPorts } from '../index.js';

describe('hasLegacyPorts', () => {
  it('returns true when ports contain HOST:CONTAINER pattern', () => {
    expect(hasLegacyPorts(['3100:3100'])).toBe(true);
    expect(hasLegacyPorts(['3100:3100', '3101:3101', '3102:3102'])).toBe(true);
  });

  it('returns false for ephemeral port format', () => {
    expect(hasLegacyPorts(['3100'])).toBe(false);
  });

  it('returns false when ports is empty', () => {
    expect(hasLegacyPorts([])).toBe(false);
  });

  it('returns false for non-string entries', () => {
    expect(hasLegacyPorts([3100, { target: 3100 }])).toBe(false);
  });

  it('detects mixed legacy and ephemeral ports', () => {
    expect(hasLegacyPorts(['3100', '3101:3101'])).toBe(true);
  });
});
