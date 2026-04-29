import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
  },
}));

import { exec } from 'node:child_process';
import * as p from '@clack/prompts';
import { openBrowser } from '../browser.js';

const mockedExec = vi.mocked(exec);

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.clearAllMocks();
});

describe('openBrowser', () => {
  const url = 'https://example.com/verify?code=ABC123';

  it('calls exec with open on macOS and logs "Opening browser..."', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockedExec.mockImplementation((_cmd: any, _callback: any) => {
      return {} as any;
    });

    openBrowser(url);

    expect(p.log.info).toHaveBeenCalledWith('Opening browser...');
    expect(mockedExec).toHaveBeenCalledWith(`open "${url}"`, expect.any(Function));
  });

  it('calls exec with start on Windows and logs "Opening browser..."', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockedExec.mockImplementation((_cmd: any, _callback: any) => {
      return {} as any;
    });

    openBrowser(url);

    expect(p.log.info).toHaveBeenCalledWith('Opening browser...');
    expect(mockedExec).toHaveBeenCalledWith(`start "" "${url}"`, expect.any(Function));
  });

  it('does not call exec on Linux and prints URL with instructions', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    openBrowser(url);

    expect(mockedExec).not.toHaveBeenCalled();
    expect(p.log.info).toHaveBeenCalledWith(`Open this URL in your browser:\n  ${url}`);
  });

  it('falls back to printing URL when exec fails on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockedExec.mockImplementation((_cmd: any, callback: any) => {
      callback(new Error('exec failed'));
      return {} as any;
    });

    openBrowser(url);

    expect(p.log.info).toHaveBeenCalledWith('Opening browser...');
    expect(p.log.info).toHaveBeenCalledWith(`Open this URL in your browser:\n  ${url}`);
  });

  it('falls back to printing URL when exec fails on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockedExec.mockImplementation((_cmd: any, callback: any) => {
      callback(new Error('exec failed'));
      return {} as any;
    });

    openBrowser(url);

    expect(p.log.info).toHaveBeenCalledWith('Opening browser...');
    expect(p.log.info).toHaveBeenCalledWith(`Open this URL in your browser:\n  ${url}`);
  });
});
