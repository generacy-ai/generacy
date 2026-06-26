/**
 * Gate vocabulary derived from `WORKFLOW_LABELS`.
 *
 * A gate is any `waiting-for:<x>` label that has a matching `completed:<x>` partner.
 * Labels with only one side of the pair are NOT valid gates.
 *
 * This is the single source of truth for `--gate <name>` validation in `cockpit advance`,
 * and for `--help-gates` output. Per SC-005, no other file in `cockpit/` may hard-code a
 * `completed:` literal list.
 */
import { WORKFLOW_LABELS } from '@generacy-ai/workflow-engine';

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
