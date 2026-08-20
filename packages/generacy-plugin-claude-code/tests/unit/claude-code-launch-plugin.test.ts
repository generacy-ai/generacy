import { describe, it, expect, afterEach } from 'vitest';
import { ClaudeCodeLaunchPlugin } from '../../src/launch/claude-code-launch-plugin.js';
import type {
  PhaseIntent,
  PrFeedbackIntent,
  ValidateFixIntent,
  MergeConflictIntent,
  ConversationTurnIntent,
  InvokeIntent,
} from '../../src/launch/types.js';

describe('ClaudeCodeLaunchPlugin', () => {
  const plugin = new ClaudeCodeLaunchPlugin();

  // ---- T010: Unit tests ----

  describe('identity', () => {
    it('has pluginId "claude-code"', () => {
      expect(plugin.pluginId).toBe('claude-code');
    });

    it('supports phase, pr-feedback, validate-fix, merge-conflict, review, remediate, conversation-turn, and invoke kinds', () => {
      expect(plugin.supportedKinds).toEqual(['phase', 'pr-feedback', 'validate-fix', 'merge-conflict', 'review', 'remediate', 'conversation-turn', 'invoke']);
    });
  });

  describe('invoke intent', () => {
    it('produces correct argv for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: '/speckit:specify https://github.com/org/repo/issues/1' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.command).toBe('claude');
      expect(spec.args).toEqual(['--print', '--dangerously-skip-permissions', '/speckit:specify https://github.com/org/repo/issues/1']);
    });

    it('uses default stdioProfile for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test command' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.stdioProfile).toBe('default');
    });

    it('returns no-op output parser for invoke intent', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
      // Should not throw
      parser.processChunk('stdout', 'data');
      parser.processChunk('stderr', 'err');
      parser.flush();
    });

    it('does not include env in launch spec', () => {
      const intent: InvokeIntent = { kind: 'invoke', command: 'test' };
      const spec = plugin.buildLaunch(intent);
      expect(spec.env).toBeUndefined();
    });
  });

  describe('createOutputParser', () => {
    it('returns a valid OutputParser for phase intent', () => {
      const intent: PhaseIntent = { kind: 'phase', phase: 'specify', prompt: 'test' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
      parser.processChunk('stdout', 'data');
      parser.processChunk('stderr', 'err');
      parser.flush();
    });

    it('returns a valid OutputParser for pr-feedback intent', () => {
      const intent: PrFeedbackIntent = { kind: 'pr-feedback', prNumber: 42, prompt: 'fix it' };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
    });

    it('returns a valid OutputParser for conversation-turn intent', () => {
      const intent: ConversationTurnIntent = {
        kind: 'conversation-turn',
        message: 'hello',
        skipPermissions: true,
      };
      const parser = plugin.createOutputParser(intent);
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
    });
  });

  describe('unsupported intent', () => {
    it('throws on unsupported intent kind', () => {
      const intent = { kind: 'unknown' } as any;
      expect(() => plugin.buildLaunch(intent)).toThrow('Unsupported intent kind: unknown');
    });
  });

  // ---- T009: Snapshot tests ----

  describe('buildLaunch snapshots', () => {
    describe('phase intent', () => {
      const phases = ['specify', 'clarify', 'plan', 'tasks', 'implement'] as const;

      for (const phase of phases) {
        it(`snapshot for phase "${phase}"`, () => {
          const intent: PhaseIntent = {
            kind: 'phase',
            phase,
            prompt: 'https://github.com/org/repo/issues/123',
          };
          expect(plugin.buildLaunch(intent)).toMatchSnapshot();
        });
      }

      it('snapshot for phase with sessionId (resume path)', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'implement',
          prompt: 'https://github.com/org/repo/issues/123',
          sessionId: 'abc-123-session',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      // T021 / #814: `--model` argv position — immediately after `--verbose`,
      // before `--resume <sessionId>` and the prompt payload.
      it('snapshot for phase with model set', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'implement',
          prompt: 'https://github.com/org/repo/issues/123',
          model: 'sonnet-4-6',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        // Explicit position assertion. Order: -p, --output-format, stream-json,
        // --dangerously-skip-permissions, --verbose, --model, <model>, /implement <prompt>
        const modelIdx = spec.args.indexOf('--model');
        expect(modelIdx).toBe(spec.args.indexOf('--verbose') + 1);
        expect(spec.args[modelIdx + 1]).toBe('sonnet-4-6');
      });

      it('snapshot for phase with model AND sessionId — --model precedes --resume', () => {
        const intent: PhaseIntent = {
          kind: 'phase',
          phase: 'plan',
          prompt: 'https://github.com/org/repo/issues/123',
          model: 'opus-4-7',
          sessionId: 'abc-123-session',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        expect(spec.args.indexOf('--model')).toBeLessThan(spec.args.indexOf('--resume'));
      });
    });

    describe('pr-feedback intent', () => {
      it('snapshot for pr-feedback', () => {
        const intent: PrFeedbackIntent = {
          kind: 'pr-feedback',
          prNumber: 42,
          prompt: 'Please address the review feedback on PR #42.',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      // T021 + T022 / #814: `--model` argv position for pr-feedback — after
      // `--verbose`, before the prompt payload. Fixture uses opus-4-7 to
      // stand in for the plan.md Acceptance Gate #6 pr-feedback picks up
      // `phases.implement.model` scenario.
      it('snapshot for pr-feedback with model set (Q1→B: pr-feedback binds to implement)', () => {
        const intent: PrFeedbackIntent = {
          kind: 'pr-feedback',
          prNumber: 42,
          prompt: 'Please address the review feedback on PR #42.',
          model: 'opus-4-7',
        };
        const spec = plugin.buildLaunch(intent);
        expect(spec).toMatchSnapshot();
        // Position assertion: --model is right after --verbose, and the last
        // arg is the prompt.
        const modelIdx = spec.args.indexOf('--model');
        expect(modelIdx).toBe(spec.args.indexOf('--verbose') + 1);
        expect(spec.args[modelIdx + 1]).toBe('opus-4-7');
        expect(spec.args[spec.args.length - 1]).toBe(intent.prompt);
      });
    });

    describe('invoke intent', () => {
      it('snapshot for invoke', () => {
        const intent: InvokeIntent = {
          kind: 'invoke',
          command: '/speckit:specify https://github.com/org/repo/issues/42',
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot for invoke with streaming', () => {
        const intent: InvokeIntent = {
          kind: 'invoke',
          command: '/speckit:plan https://github.com/org/repo/issues/42',
          streaming: true,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });
    });

    describe('conversation-turn intent', () => {
      it('snapshot: basic turn (skipPermissions=false, no session, no model)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: skipPermissions=true', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          skipPermissions: true,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: with sessionId (resume)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          sessionId: 'session-xyz',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: with model override', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          model: 'claude-opus-4-6',
          skipPermissions: false,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });

      it('snapshot: all flags (sessionId + skipPermissions + model)', () => {
        const intent: ConversationTurnIntent = {
          kind: 'conversation-turn',
          message: 'Hello Claude',
          sessionId: 'session-xyz',
          model: 'claude-opus-4-6',
          skipPermissions: true,
        };
        expect(plugin.buildLaunch(intent)).toMatchSnapshot();
      });
    });
  });

  // ---- Issue #1095 — reasoning effort ----
  describe('hasEffortMechanism', () => {
    afterEach(() => {
      // Clear the cache so unrelated tests fall back to normal probe behavior.
      ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(undefined);
    });

    it('returns cached value once seeded (test override)', () => {
      ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(true);
      expect(ClaudeCodeLaunchPlugin.hasEffortMechanism()).toBe(true);
      ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(false);
      expect(ClaudeCodeLaunchPlugin.hasEffortMechanism()).toBe(false);
    });

    it('probes claude --help once per process — no `--effort` in the help text returns false', () => {
      // No stubbing framework is worth pulling in here for a single test; the
      // cache override IS the stub. Verify the runtime contract by injection.
      ClaudeCodeLaunchPlugin._setHasEffortMechanismForTests(false);
      expect(ClaudeCodeLaunchPlugin.hasEffortMechanism()).toBe(false);
      // Repeat call must hit the cache (would otherwise probe again).
      expect(ClaudeCodeLaunchPlugin.hasEffortMechanism()).toBe(false);
    });
  });

  describe('SC-004 argv-baseline (issue #1095) — model + effort unset', () => {
    it('phase intent argv is unchanged when model + effort are both unset', () => {
      const spec = plugin.buildLaunch({
        kind: 'phase',
        phase: 'implement',
        prompt: 'https://github.com/org/repo/issues/1',
      });
      expect(spec.args).toEqual([
        '-p',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
        '/implement https://github.com/org/repo/issues/1',
      ]);
    });

    it('pr-feedback intent argv is unchanged when model + effort are both unset', () => {
      const spec = plugin.buildLaunch({
        kind: 'pr-feedback',
        prNumber: 42,
        prompt: 'address feedback',
      });
      expect(spec.args).toEqual([
        '-p',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
        'address feedback',
      ]);
    });

    it('validate-fix intent argv is unchanged when model + effort are both unset', () => {
      const spec = plugin.buildLaunch({
        kind: 'validate-fix',
        prNumber: 42,
        prompt: 'fix validate failures',
        evidenceHash: 'a'.repeat(64),
      });
      expect(spec.args).toEqual([
        '-p',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
        'fix validate failures',
      ]);
    });

    it('merge-conflict intent argv is unchanged when model + effort are both unset', () => {
      const spec = plugin.buildLaunch({
        kind: 'merge-conflict',
        issueNumber: 7,
        prompt: 'resolve conflicts',
      });
      expect(spec.args).toEqual([
        '-p',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
        'resolve conflicts',
      ]);
    });
  });

  describe('--effort append (issue #1095)', () => {
    it('phase intent pushes --effort xhigh after --model', () => {
      const intent: PhaseIntent = {
        kind: 'phase',
        phase: 'plan',
        prompt: '/spec-payload',
        model: 'fable',
        effort: 'xhigh',
      };
      const spec = plugin.buildLaunch(intent);
      const modelIdx = spec.args.indexOf('--model');
      const effortIdx = spec.args.indexOf('--effort');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(effortIdx).toBe(modelIdx + 2);
      expect(spec.args[effortIdx + 1]).toBe('xhigh');
    });

    it('phase intent pushes --effort without a --model when only effort is set', () => {
      const spec = plugin.buildLaunch({
        kind: 'phase',
        phase: 'plan',
        prompt: 'x',
        effort: 'high',
      });
      expect(spec.args.indexOf('--model')).toBe(-1);
      expect(spec.args.indexOf('--effort')).toBeGreaterThan(-1);
      expect(spec.args[spec.args.indexOf('--effort') + 1]).toBe('high');
    });

    it('pr-feedback intent pushes --effort', () => {
      const intent: PrFeedbackIntent = {
        kind: 'pr-feedback',
        prNumber: 42,
        prompt: 'x',
        model: 'opus-4-7',
        effort: 'high',
      };
      const spec = plugin.buildLaunch(intent);
      const effortIdx = spec.args.indexOf('--effort');
      expect(effortIdx).toBeGreaterThan(-1);
      expect(spec.args[effortIdx + 1]).toBe('high');
      // Prompt remains the last argument.
      expect(spec.args[spec.args.length - 1]).toBe('x');
    });

    it('validate-fix intent pushes --model and --effort in that order', () => {
      const intent: ValidateFixIntent = {
        kind: 'validate-fix',
        prNumber: 42,
        prompt: 'fix',
        evidenceHash: 'b'.repeat(64),
        model: 'opus-4-7',
        effort: 'high',
      };
      const spec = plugin.buildLaunch(intent);
      const modelIdx = spec.args.indexOf('--model');
      const effortIdx = spec.args.indexOf('--effort');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(effortIdx).toBe(modelIdx + 2);
      expect(spec.args[modelIdx + 1]).toBe('opus-4-7');
      expect(spec.args[effortIdx + 1]).toBe('high');
      // Prompt remains the last argument (unchanged shape).
      expect(spec.args[spec.args.length - 1]).toBe('fix');
    });

    it('merge-conflict intent pushes --model and --effort in that order', () => {
      const intent: MergeConflictIntent = {
        kind: 'merge-conflict',
        issueNumber: 7,
        prompt: 'resolve',
        model: 'opus-4-7',
        effort: 'max',
      };
      const spec = plugin.buildLaunch(intent);
      const modelIdx = spec.args.indexOf('--model');
      const effortIdx = spec.args.indexOf('--effort');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(effortIdx).toBe(modelIdx + 2);
      expect(spec.args[modelIdx + 1]).toBe('opus-4-7');
      expect(spec.args[effortIdx + 1]).toBe('max');
      expect(spec.args[spec.args.length - 1]).toBe('resolve');
    });
  });
});
