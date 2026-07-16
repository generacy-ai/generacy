/**
 * #958 — `runClarifyRelay` — deterministic answer-relay path for cockpit's
 * clarify skill. Replaces the freehand `gh issue comment` invocation that
 * caused #958's answer-side lottery (four different agent-invented markers
 * observed on #5/#6/#7/#8 in one run).
 *
 * The tool posts a marker-stamped comment (via `formatClarificationAnswerComment`)
 * and applies `completed:clarification`. Idempotent: a second call with the
 * same batch is a no-op (`action: 'already-relayed'`).
 *
 * MUST NOT rewrite `clarifications.md` locally. MUST NOT remove
 * `waiting-for:clarification` (the worker owns that on resume).
 */
import {
  loadCockpitConfig,
  type CommandRunner,
  type GhWrapper,
} from '@generacy-ai/cockpit';
import { getLogger } from '../../utils/logger.js';
import { resolveIssueContext, type IssueRef } from './resolver.js';
import { CockpitExit } from './exit.js';
import { resolveCockpitIdentity } from './shared/identity.js';
import { formatClarificationAnswerComment } from './clarification-answer-marker.js';

export interface ClarifyRelayInput {
  issue: string;
  batch: number;
  answers: Record<number, string>;
  actor?: string;
}

export interface ClarifyRelayResult {
  ref: IssueRef;
  batch: number;
  action: 'relayed' | 'already-relayed';
  completedLabel: 'completed:clarification';
  commentUrl?: string;
  noop?: true;
}

export interface ClarifyRelayDeps {
  runner?: CommandRunner;
  gh?: GhWrapper;
  loadConfig?: typeof loadCockpitConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const COMPLETED_LABEL = 'completed:clarification' as const;

/**
 * Detect a prior stamped answer comment for the same batch. The marker header
 * carries the batch as the first attribute (`:<batch>`) — any comment whose
 * body starts a line with `<!-- generacy-clarification-answers:<batch>` matches.
 */
function hasPriorMarkerForBatch(body: string, batch: number): boolean {
  const prefix = `<!-- generacy-clarification-answers:${batch}`;
  for (const line of body.split('\n')) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}

export async function runClarifyRelay(
  input: ClarifyRelayInput,
  deps: ClarifyRelayDeps = {},
): Promise<ClarifyRelayResult> {
  const log = getLogger();

  const loaded = await (deps.loadConfig ?? loadCockpitConfig)({});
  for (const w of loaded.warnings) log.warn(w);

  let ref: IssueRef;
  let gh: GhWrapper;
  try {
    const resolvedCtx = await resolveIssueContext({
      issue: input.issue,
      ...(deps.runner != null ? { runner: deps.runner } : {}),
    });
    ref = resolvedCtx.ref;
    gh = deps.gh ?? resolvedCtx.gh;
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit clarify-relay: ${(err as Error).message}`);
  }

  // Resolve actor (optional). An unresolvable identity leaves the actor attr
  // off the marker header — the marker match rule is prefix-based so this is
  // a cosmetic degradation, not a functional one.
  const identityInput: Parameters<typeof resolveCockpitIdentity>[0] = {
    flag: undefined,
    configAssignee: loaded.config.assignee,
    gh,
    logger: log,
    verb: 'clarify-relay',
    mode: 'optional',
    ...(deps.env != null ? { env: deps.env } : {}),
  };
  const identity = await resolveCockpitIdentity(identityInput);
  const actor = input.actor ?? identity.login;

  // Idempotence — a comment carrying this batch's marker means we already
  // relayed. Return no-op without re-posting or re-labelling.
  let existingComments;
  try {
    existingComments = await gh.fetchIssueComments(ref.nwo, ref.number);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-relay: gh issue view (fetch comments): ${(err as Error).message}`,
    );
  }
  const alreadyRelayed = existingComments.some((c) =>
    hasPriorMarkerForBatch(c.body, input.batch),
  );
  if (alreadyRelayed) {
    return {
      ref,
      batch: input.batch,
      action: 'already-relayed',
      completedLabel: COMPLETED_LABEL,
      noop: true,
    };
  }

  const ts = (deps.now ?? (() => new Date()))().toISOString();
  let body: string;
  try {
    body = formatClarificationAnswerComment({
      batch: input.batch,
      answers: input.answers,
      ...(actor != null ? { actor } : {}),
      ts,
    });
  } catch (err) {
    throw new CockpitExit(2, `Error: cockpit clarify-relay: ${(err as Error).message}`);
  }

  let commentUrl: string;
  try {
    commentUrl = (await gh.postIssueComment(ref.nwo, ref.number, body)).url;
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-relay: gh issue comment: ${(err as Error).message}`,
    );
  }

  try {
    await gh.addLabel(ref.nwo, ref.number, COMPLETED_LABEL);
  } catch (err) {
    throw new CockpitExit(
      1,
      `Error: cockpit clarify-relay: gh issue edit (add ${COMPLETED_LABEL}): ${(err as Error).message}` +
        ` (comment posted: ${commentUrl})`,
    );
  }

  return {
    ref,
    batch: input.batch,
    action: 'relayed',
    completedLabel: COMPLETED_LABEL,
    commentUrl,
  };
}
