/**
 * `cockpit_scope_add` MCP tool handler.
 *
 * Appends a task-list ref to a scope (epic or tracking) issue's body,
 * concurrency-safe via bounded retry (see scope/retry.ts).
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitScopeAddInputSchema,
  type CockpitScopeAddInput,
} from '../schemas.js';
import { writeScopeWithRetry } from '../../scope/retry.js';
import { ScopeContendedError } from '../../scope/errors.js';
import type { BodyShape } from '../../scope/writer.js';

export interface CockpitScopeAddData {
  scope: { owner: string; repo: string; number: number };
  ref: { owner: string; repo: string; number: number };
  shape: BodyShape;
  alreadyPresent: boolean;
  attempts: number;
}

export interface CockpitScopeAddDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
}

function isScopeNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|not found|no such/i.test(msg);
}

export function cockpitScopeAdd(
  input: CockpitScopeAddInput,
  deps: CockpitScopeAddDeps = {},
): Promise<ToolResult<CockpitScopeAddData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitScopeAddInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        status: 'error',
        class: 'invalid-args',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }

    const scopeN = await normalizeIssueRef(parsed.data.scope, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!scopeN.ok) return scopeN.error;

    const refN = await normalizeIssueRef(parsed.data.issue, {
      expects: 'issue',
      ...(deps.runner != null ? { runner: deps.runner } : {}),
      ...(deps.gh != null ? { gh: deps.gh } : {}),
    });
    if (!refN.ok) return refN.error;

    const gh = deps.gh ?? scopeN.value.gh;
    const scope = { repo: scopeN.value.ref.nwo, number: scopeN.value.ref.number };
    const ref = { repo: refN.value.ref.nwo, number: refN.value.ref.number };

    try {
      const result = await writeScopeWithRetry({
        gh,
        scope,
        mutation: { kind: 'add', ref },
      });
      return {
        status: 'ok',
        data: {
          scope: {
            owner: scopeN.value.ref.owner,
            repo: scopeN.value.ref.repo,
            number: scopeN.value.ref.number,
          },
          ref: {
            owner: refN.value.ref.owner,
            repo: refN.value.ref.repo,
            number: refN.value.ref.number,
          },
          shape: result.shape,
          alreadyPresent: result.noop,
          attempts: result.attempts,
        },
      };
    } catch (err) {
      if (err instanceof ScopeContendedError) {
        return {
          status: 'error',
          class: 'contended',
          detail: `${err.code} after ${err.attempts} attempts`,
        };
      }
      if (isScopeNotFoundError(err)) {
        return {
          status: 'error',
          class: 'scope-not-found',
          detail: `scope issue ${scope.repo}#${scope.number} not found`,
        };
      }
      throw err;
    }
  });
}
