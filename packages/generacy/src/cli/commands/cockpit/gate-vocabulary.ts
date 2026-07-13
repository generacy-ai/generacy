/**
 * Gate vocabulary derived from `WORKFLOW_LABELS`.
 *
 * A gate is any `waiting-for:<x>` label that has a matching `completed:<x>` partner.
 * Labels with only one side of the pair are NOT valid gates.
 *
 * This is the single source of truth for `--gate <name>` validation in `cockpit advance`,
 * and for `--help-gates` output. Per SC-005, no other file in `cockpit/` may hard-code a
 * `completed:` literal list.
 *
 * Also exposes `resolvePrecedingGate(phase, workflowName?)` — the inverse view of
 * `GATE_MAPPING` keyed by `resumeFrom` — used by `cockpit resume` (#891) to
 * derive the gate whose completion causes the resolver to pick `<phase>` as
 * `startPhase`.
 */
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';
import {
  GATE_MAPPING,
  WORKFLOW_GATE_MAPPING,
  PHASE_SEQUENCE,
  type WorkflowPhase,
} from '@generacy-ai/orchestrator';

export interface GateDefinition {
  /** Gate name (e.g. "clarification", "plan-review"). */
  name: string;
  /** Full label name "waiting-for:<name>". */
  waitingLabel: string;
  /** Full label name "completed:<name>". */
  completedLabel: string;
}

function buildGates(): ReadonlyMap<string, GateDefinition> {
  const gates = new Map<string, GateDefinition>();
  const completedNames = new Set<string>();
  for (const label of WORKFLOW_LABELS) {
    if (label.name.startsWith('completed:')) {
      completedNames.add(label.name.slice('completed:'.length));
    }
  }
  for (const label of WORKFLOW_LABELS) {
    if (!label.name.startsWith('waiting-for:')) continue;
    const name = label.name.slice('waiting-for:'.length);
    if (!completedNames.has(name)) continue;
    gates.set(name, {
      name,
      waitingLabel: `waiting-for:${name}`,
      completedLabel: `completed:${name}`,
    });
  }
  return gates;
}

export const GATES: ReadonlyMap<string, GateDefinition> = buildGates();

/** List gate names in `WORKFLOW_LABELS` order — stable for `--help-gates`. */
export function listGates(): string[] {
  return Array.from(GATES.keys());
}

// --- resolvePrecedingGate (#891) -------------------------------------------

/**
 * A gate whose completion causes the resolver to pick the failed phase as
 * `startPhase`. Returned by `resolvePrecedingGate`.
 */
export interface PrecedingGate {
  /** Gate name — e.g. "implementation-review", "tasks-review". */
  name: string;
  /** Full label name "waiting-for:<name>". */
  waitingLabel: string;
  /** Full label name "completed:<name>". */
  completedLabel: string;
  /** The phase this gate belongs to (from GATE_MAPPING[name].phase). */
  sourcePhase: WorkflowPhase;
  /** True when sourcePhase === the phase being re-entered (documented tie-break). */
  isSelfLoop: boolean;
}

export type ResolvePrecedingGateResult =
  | { kind: 'found'; gate: PrecedingGate }
  | { kind: 'no-preceding-gate'; targetPhase: WorkflowPhase };

/**
 * Resolve the preceding gate for a failed phase.
 *
 * Algorithm (deterministic; mirrors `PhaseResolver.getEffectiveGateMapping`):
 *  1. Build effective mapping = GATE_MAPPING overlaid with WORKFLOW_GATE_MAPPING[workflowName].
 *  2. Filter entries where `resumeFrom === phase`.
 *  3. If empty: return `no-preceding-gate`.
 *  4. Partition into `crossPhase` (gatePhase !== phase) and `selfLoop`.
 *  5. If crossPhase non-empty: pick nearest predecessor by PHASE_SEQUENCE.indexOf descending.
 *  6. Otherwise: pick the first selfLoop entry in stable Object.entries order.
 */
export function resolvePrecedingGate(
  phase: WorkflowPhase,
  workflowName?: string,
): ResolvePrecedingGateResult {
  const effective: Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }> =
    workflowName && WORKFLOW_GATE_MAPPING[workflowName]
      ? { ...GATE_MAPPING, ...WORKFLOW_GATE_MAPPING[workflowName] }
      : GATE_MAPPING;

  const candidates: { name: string; sourcePhase: WorkflowPhase }[] = [];
  for (const [gateName, entry] of Object.entries(effective)) {
    if (entry.resumeFrom === phase) {
      candidates.push({ name: gateName, sourcePhase: entry.phase });
    }
  }

  if (candidates.length === 0) {
    return { kind: 'no-preceding-gate', targetPhase: phase };
  }

  const crossPhase = candidates.filter((c) => c.sourcePhase !== phase);
  if (crossPhase.length > 0) {
    crossPhase.sort(
      (a, b) => PHASE_SEQUENCE.indexOf(b.sourcePhase) - PHASE_SEQUENCE.indexOf(a.sourcePhase),
    );
    const winner = crossPhase[0]!;
    return {
      kind: 'found',
      gate: {
        name: winner.name,
        waitingLabel: `waiting-for:${winner.name}`,
        completedLabel: `completed:${winner.name}`,
        sourcePhase: winner.sourcePhase,
        isSelfLoop: false,
      },
    };
  }

  const selfLoop = candidates[0]!;
  return {
    kind: 'found',
    gate: {
      name: selfLoop.name,
      waitingLabel: `waiting-for:${selfLoop.name}`,
      completedLabel: `completed:${selfLoop.name}`,
      sourcePhase: selfLoop.sourcePhase,
      isSelfLoop: true,
    },
  };
}
