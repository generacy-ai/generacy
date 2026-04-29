/**
 * Interactive prompts for `generacy launch`.
 * Uses `@clack/prompts` following the init command pattern.
 */
import * as p from '@clack/prompts';

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
 * Ask the user to confirm the project directory before creating it.
 */
export async function confirmDirectory(dir: string): Promise<boolean> {
  const confirmed = await p.confirm({
    message: `Create project in ${dir}?`,
  });
  exitIfCancelled(confirmed);
  return confirmed as boolean;
}
