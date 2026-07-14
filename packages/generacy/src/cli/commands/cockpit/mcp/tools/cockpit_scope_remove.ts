/**
 * `cockpit_scope_remove` MCP tool handler.
 *
 * Removes the first task-list line matching the ref from a scope issue's
 * body. Same envelope and error classes as `cockpit_scope_add`; the shared
 * `SCOPE_ADD_CONTENDED` code covers both mutations per spec Q5.
 */
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';
import { normalizeIssueRef } from '../ref-input.js';
import { wrapToolBoundary, type ToolResult } from '../errors.js';
import {
  CockpitScopeRemoveInputSchema,
  type CockpitScopeRemoveInput,
} from '../schemas.js';
import { writeScopeWithRetry } from '../../scope/retry.js';
import { ScopeContendedError } from '../../scope/errors.js';

export interface CockpitScopeRemoveData {
  scope: { owner: string; repo: string; number: number };
  ref: { owner: string; repo: string; number: number };
  alreadyAbsent: boolean;
  attempts: number;
}

export interface CockpitScopeRemoveDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
}

function isScopeNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|not found|no such/i.test(msg);
}

export function cockpitScopeRemove(
  input: CockpitScopeRemoveInput,
  deps: CockpitScopeRemoveDeps = {},
): Promise<ToolResult<CockpitScopeRemoveData>> {
  return wrapToolBoundary(async () => {
    const parsed = CockpitScopeRemoveInputSchema.safeParse(input);
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
        mutation: { kind: 'remove', ref },
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
          alreadyAbsent: result.noop,
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
