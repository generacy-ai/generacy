/**
 * Interactive prompts for `generacy launch`.
 * Uses `@clack/prompts` following the init command pattern.
 */
import * as p from '@clack/prompts';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const CUSTOM_PATH_SENTINEL = '__custom__';

/**
 * Guard: exit with code 130 if the user cancelled a prompt.
 */
function exitIfCancelled(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Operation cancelled.');
    process.exit(130);
  }
}

/**
 * Format an absolute path for display, replacing homedir with ~.
 */
function formatPath(absPath: string): string {
  const home = homedir();
  if (absPath.startsWith(home)) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Prompt the user for a claim code if not provided via --claim flag.
 */
export async function promptClaimCode(): Promise<string> {
  const value = await p.text({
    message: 'Enter your claim code',
    placeholder: 'claim_xxxxxxxx',
    validate(input) {
      if (!input.trim()) return 'Claim code cannot be empty';
      if (/\s/.test(input)) return 'Claim code cannot contain whitespace';
      return undefined;
    },
  });
  exitIfCancelled(value);
  return (value as string).trim();
}

/**
 * Prompt the user to select a project directory from predefined options or a custom path.
 *
 * @param defaultDir - The resolved absolute default path (e.g. ~/Generacy/<projectName>)
 * @param cwd - The current working directory (resolved absolute)
 * @returns The chosen absolute path
 */
export async function selectDirectory(defaultDir: string, cwd: string): Promise<string> {
  const options: { value: string; label: string; hint?: string }[] = [];

  // Option 1: Default path
  options.push({
    value: defaultDir,
    label: `${formatPath(defaultDir)} (default)`,
  });

  // Option 2: Current directory (only if different from default)
  if (cwd !== defaultDir) {
    const hint = existsSync(resolve(cwd, '.generacy')) ? 'already contains .generacy/' : undefined;
    options.push({
      value: cwd,
      label: `${formatPath(cwd)} (current directory)`,
      hint,
    });
  }

  // Option 3: Custom path
  options.push({
    value: CUSTOM_PATH_SENTINEL,
    label: 'Enter a custom path...',
  });

  const selection = await p.select({
    message: 'Where should the project be created?',
    options,
  });
  exitIfCancelled(selection);

  if (selection === CUSTOM_PATH_SENTINEL) {
    const customPath = await p.text({
      message: 'Enter project directory path:',
      validate(input) {
        if (!input.trim()) return 'Path cannot be empty';
        return undefined;
      },
    });
    exitIfCancelled(customPath);
    return resolve(customPath as string);
  }

  return selection as string;
}
