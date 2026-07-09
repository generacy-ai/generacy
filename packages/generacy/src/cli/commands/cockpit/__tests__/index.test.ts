import { describe, it, expect } from 'vitest';
import { cockpitCommand } from '../index.js';

describe('cockpit command tree', () => {
  it('exposes the watch/status observability verbs, the single-issue verbs, and merge', () => {
    const cmd = cockpitCommand();
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      'advance',
      'context',
      'merge',
      'queue',
      'resume',
      'status',
      'watch',
    ]);
  });

  it('has the documented top-level description', () => {
    const cmd = cockpitCommand();
    expect(cmd.description()).toBe(
      'Cockpit — inspect and drive workflow state for Generacy epics and issues.',
    );
  });
});
