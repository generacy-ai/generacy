import { exec } from 'node:child_process';
import { platform } from 'node:os';

export function openUrl(url: string): void {
  const plat = platform();

  if (plat === 'darwin') {
    exec(`open "${url}"`);
  } else if (plat === 'win32') {
    exec(`start "" "${url}"`);
  } else {
    console.log(`\nOpen this URL in your browser:\n  ${url}\n`);
  }
}
