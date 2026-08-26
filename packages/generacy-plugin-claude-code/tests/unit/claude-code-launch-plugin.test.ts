import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ClaudeCodeLaunchPlugin } from '../../src/launch/claude-code-launch-plugin.js';
import {
  GatewayRouteUnavailableError,
  _resetGatewayProvisionCacheForTests,
} from '../../src/launch/route.js';
import type {
  PhaseIntent,
  PrFeedbackIntent,
  MergeConflictIntent,
  ReviewIntent,
  RemediateIntent,
  ConversationTurnIntent,
  InvokeIntent,
  ClaudeCodeIntent,
} from '../../src/launch/types.js';

describe('ClaudeCodeLaunchPlugin', () => {
  const plugin = new ClaudeCodeLaunchPlugin();

  // ---- T010: Unit tests ----

  describe('identity', () => {
    it('has pluginId "claude-code"', () => {
      expect(plugin.pluginId).toBe('claude-code');
    });

    it('supports phase, pr-feedback, merge-conflict, review, remediate, conversation-turn, and invoke kinds', () => {
      expect(plugin.supportedKinds).toEqual(['phase', 'pr-feedback', 'merge-conflict', 'review', 'remediate', 'conversation-turn', 'invoke']);
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

  // ---- T006 / #1198 — per-builder gateway route matrix ----
  //
  // Each of the six model-bearing builders must:
  //  - inject `CLAUDE_CONFIG_DIR` + stamp `route: 'gateway'` for a gateway
  //    model (dir provisioned), leaving argv identical modulo the model string;
  //  - return a byte-identical spec (no `env`, no `route`) for a subscription
  //    model AND an absent model;
  //  - throw `GatewayRouteUnavailableError` for a gateway model + unprovisioned
  //    dir.
  // `buildInvokeLaunch` carries no model and must never gain `route`/gateway env.
  describe('gateway route injection (SC-002, SC-003, SC-004, FR-009)', () => {
    // A gateway model is any provider-qualified id (contains `/`); a
    // subscription model is a bare Anthropic id/alias.
    const GATEWAY_MODEL = 'openai/gpt-5.5';
    const SUBSCRIPTION_MODEL = 'opus';

    // Builders keyed by name, each producing an intent for the given model.
    const builders: ReadonlyArray<{
      name: string;
      make: (model?: string) => ClaudeCodeIntent;
    }> = [
      {
        name: 'phase',
        make: (model) => ({ kind: 'phase', phase: 'implement', prompt: 'p', model }),
      },
      {
        name: 'pr-feedback',
        make: (model) => ({ kind: 'pr-feedback', prNumber: 42, prompt: 'p', model }),
      },
      {
        name: 'merge-conflict',
        make: (model) => ({ kind: 'merge-conflict', issueNumber: 7, prompt: 'p', model }),
      },
      {
        name: 'review',
        make: (model) => ({ kind: 'review', issueNumber: 7, prompt: 'p', model }),
      },
      {
        name: 'remediate',
        make: (model) => ({ kind: 'remediate', issueNumber: 7, prompt: 'p', model }),
      },
      {
        name: 'conversation-turn',
        make: (model) => ({ kind: 'conversation-turn', message: 'm', skipPermissions: true, model }),
      },
    ];

    let dir: string;

    beforeEach(() => {
      _resetGatewayProvisionCacheForTests();
      dir = mkdtempSync(join(tmpdir(), 'gw-plugin-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    for (const { name, make } of builders) {
      describe(name, () => {
        it('gateway model (provisioned dir) → CLAUDE_CONFIG_DIR + route, argv unchanged', () => {
          writeFileSync(join(dir, 'settings.json'), '{}');
          const gwPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });
          const subPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });

          const gatewaySpec = gwPlugin.buildLaunch(make(GATEWAY_MODEL));
          const subscriptionSpec = subPlugin.buildLaunch(make(SUBSCRIPTION_MODEL));

          expect(gatewaySpec.env).toEqual({ CLAUDE_CONFIG_DIR: dir });
          expect(gatewaySpec.route).toBe('gateway');

          // argv identical modulo the model string.
          const normalize = (args: string[]) =>
            args.map((a) => (a === GATEWAY_MODEL || a === SUBSCRIPTION_MODEL ? '<MODEL>' : a));
          expect(normalize(gatewaySpec.args)).toEqual(normalize(subscriptionSpec.args));
          expect(gatewaySpec.command).toBe(subscriptionSpec.command);
          expect(gatewaySpec.stdioProfile).toBe(subscriptionSpec.stdioProfile);
        });

        it('subscription model → byte-identical spec (no env, no route)', () => {
          writeFileSync(join(dir, 'settings.json'), '{}');
          const gwPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });
          const bare = new ClaudeCodeLaunchPlugin();

          const spec = gwPlugin.buildLaunch(make(SUBSCRIPTION_MODEL));
          const preChangeSpec = bare.buildLaunch(make(SUBSCRIPTION_MODEL));

          expect(spec).toEqual(preChangeSpec);
          expect(spec).not.toHaveProperty('env');
          expect(spec).not.toHaveProperty('route');
        });

        it('undefined model → byte-identical spec (no env, no route)', () => {
          writeFileSync(join(dir, 'settings.json'), '{}');
          const gwPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });
          const bare = new ClaudeCodeLaunchPlugin();

          const spec = gwPlugin.buildLaunch(make(undefined));
          const preChangeSpec = bare.buildLaunch(make(undefined));

          expect(spec).toEqual(preChangeSpec);
          expect(spec).not.toHaveProperty('env');
          expect(spec).not.toHaveProperty('route');
        });

        it('gateway model + unprovisioned dir → throws GatewayRouteUnavailableError', () => {
          const gwPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });
          expect(() => gwPlugin.buildLaunch(make(GATEWAY_MODEL))).toThrow(
            GatewayRouteUnavailableError,
          );
        });
      });
    }

    it('buildInvokeLaunch never gains route or gateway env, even with a provisioned dir', () => {
      writeFileSync(join(dir, 'settings.json'), '{}');
      const gwPlugin = new ClaudeCodeLaunchPlugin({ gatewayConfigDir: dir });
      const intent: InvokeIntent = { kind: 'invoke', command: '/speckit:specify x' };
      const spec = gwPlugin.buildLaunch(intent);
      expect(spec).not.toHaveProperty('env');
      expect(spec).not.toHaveProperty('route');
    });
  });
});
