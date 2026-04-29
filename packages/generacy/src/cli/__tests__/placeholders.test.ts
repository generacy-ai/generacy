import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { placeholderCommands } from '../commands/placeholders.js';

describe('placeholderCommands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 4 commands', () => {
    const commands = placeholderCommands();
    expect(commands).toHaveLength(4);
  });

  it('should have correct names for all commands', () => {
    const commands = placeholderCommands();
    const names = commands.map((cmd) => cmd.name());
    expect(names).toEqual([
      'open',
      'claude-login',
      'deploy',
      'rebuild',
    ]);
  });

  it('should print the correct message for "deploy" (phase 10)', async () => {
    const commands = placeholderCommands();
    const deploy = commands.find((cmd) => cmd.name() === 'deploy')!;
    await deploy.parseAsync(['node', 'test']);
    expect(logSpy).toHaveBeenCalledWith(
      '"deploy" is not yet implemented in this preview — landing in a future v1.5 phase 10 issue.',
    );
  });

  it('should print the correct message for "open" (phase 6)', async () => {
    const commands = placeholderCommands();
    const open = commands.find((cmd) => cmd.name() === 'open')!;
    await open.parseAsync(['node', 'test']);
    expect(logSpy).toHaveBeenCalledWith(
      '"open" is not yet implemented in this preview — landing in a future v1.5 phase 6 issue.',
    );
  });

  it('should allow unknown options without erroring', async () => {
    const commands = placeholderCommands();
    const open = commands.find((cmd) => cmd.name() === 'open')!;
    // Parsing with an unknown flag should not throw
    await expect(
      open.parseAsync(['node', 'test', '--some-unknown-flag', '--another']),
    ).resolves.not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"open" is not yet implemented'),
    );
  });
});
