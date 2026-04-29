import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { openUrl } from '../browser.js';

const mockedExec = vi.mocked(exec);
const mockedPlatform = vi.mocked(platform);

describe('openUrl', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses "open" on macOS', () => {
    mockedPlatform.mockReturnValue('darwin');
    openUrl('https://example.com');
    expect(mockedExec).toHaveBeenCalledWith('open "https://example.com"');
  });

  it('uses "start" on Windows', () => {
    mockedPlatform.mockReturnValue('win32');
    openUrl('https://example.com');
    expect(mockedExec).toHaveBeenCalledWith('start "" "https://example.com"');
  });

  it('prints URL on Linux without exec', () => {
    mockedPlatform.mockReturnValue('linux');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    openUrl('https://example.com');
    expect(mockedExec).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('https://example.com'));
    consoleSpy.mockRestore();
  });
});
