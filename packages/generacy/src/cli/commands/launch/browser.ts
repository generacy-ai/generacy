import { exec } from 'node:child_process';
import * as p from '@clack/prompts';

/**
 * Opens the given URL in the user's default browser.
 *
 * On macOS and Windows the system browser is launched via `open` / `start`.
 * On Linux (and any other platform) the URL is printed to the console with
 * instructions for the user to open it manually.
 *
 * If the exec call fails on macOS/Windows the function falls back to printing
 * the URL rather than throwing.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;

  if (platform === 'darwin') {
    p.log.info('Opening browser...');
    exec(`open "${url}"`, (err) => {
      if (err) {
        p.log.info(`Open this URL in your browser:\n  ${url}`);
      }
    });
  } else if (platform === 'win32') {
    p.log.info('Opening browser...');
    exec(`start "" "${url}"`, (err) => {
      if (err) {
        p.log.info(`Open this URL in your browser:\n  ${url}`);
      }
    });
  } else {
    p.log.info(`Open this URL in your browser:\n  ${url}`);
  }
}
