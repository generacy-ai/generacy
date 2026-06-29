import type { EpicManifest, PhaseEntry } from '@generacy-ai/cockpit';
import type { ParsedEpicBody, ParsedPhase } from './parse-epic-body.js';

export interface PhaseRename {
  index: number;
  from: string;
  to: string;
}

export interface ChangeSet {
  phasesAdded: ParsedPhase[];
  phasesRemoved: PhaseEntry[];
  phasesRenamed: PhaseRename[];
  issuesAdded: Record<string, string[]>;
  issuesRemoved: Record<string, string[]>;
  planChanged: { from: string; to: string } | null;
}

const PHASE_INDEX_RE = /\bP(\d+)\b/i;

function extractIndex(name: string): number | null {
  const m = name.match(PHASE_INDEX_RE);
  if (m == null) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

export function isEmpty(c: ChangeSet): boolean {
  if (c.phasesAdded.length > 0) return false;
  if (c.phasesRemoved.length > 0) return false;
  if (c.phasesRenamed.length > 0) return false;
  if (c.planChanged != null) return false;
  for (const v of Object.values(c.issuesAdded)) if (v.length > 0) return false;
  for (const v of Object.values(c.issuesRemoved)) if (v.length > 0) return false;
  return true;
}

/**
 * Compute the diff between a parsed body and an existing manifest.
 *
 * Matching strategy:
 *   - Parsed phases are keyed by `index` (the N in `P\d+`).
 *   - Manifest phases are keyed by `extractIndex(name)`; phases with no
 *     extractable index fall back to display-name equality with parsed phases
 *     that share the same name (R6 legacy-compat).
 */
export function diffPhases(parsed: ParsedEpicBody, manifest: EpicManifest): ChangeSet {
  const parsedByIndex = new Map<number, ParsedPhase>();
  for (const p of parsed.phases) parsedByIndex.set(p.index, p);

  const manifestByIndex = new Map<number, PhaseEntry>();
  const manifestUnindexed: PhaseEntry[] = [];
  for (const m of manifest.phases) {
    const idx = extractIndex(m.name);
    if (idx != null && !manifestByIndex.has(idx)) {
      manifestByIndex.set(idx, m);
    } else if (idx == null) {
      manifestUnindexed.push(m);
    }
  }

  const phasesAdded: ParsedPhase[] = [];
  const phasesRemoved: PhaseEntry[] = [];
  const phasesRenamed: PhaseRename[] = [];
  const issuesAdded: Record<string, string[]> = {};
  const issuesRemoved: Record<string, string[]> = {};

  const consumedUnindexed = new Set<PhaseEntry>();

  for (const parsedPhase of parsed.phases) {
    let existing = manifestByIndex.get(parsedPhase.index);
    if (existing == null) {
      const fallback = manifestUnindexed.find(
        (m) => !consumedUnindexed.has(m) && m.name === parsedPhase.name,
      );
      if (fallback != null) {
        existing = fallback;
        consumedUnindexed.add(fallback);
      }
    }
    if (existing == null) {
      phasesAdded.push(parsedPhase);
      continue;
    }
    if (existing.name !== parsedPhase.name) {
      phasesRenamed.push({
        index: parsedPhase.index,
        from: existing.name,
        to: parsedPhase.name,
      });
    }
    const key = `P${parsedPhase.index}`;
    const existingSet = new Set(existing.issues);
    const parsedSet = new Set(parsedPhase.issues);
    const added = parsedPhase.issues.filter((r) => !existingSet.has(r));
    const removed = existing.issues.filter((r) => !parsedSet.has(r));
    if (added.length > 0) issuesAdded[key] = added;
    if (removed.length > 0) issuesRemoved[key] = removed;
  }

  for (const [idx, m] of manifestByIndex.entries()) {
    if (!parsedByIndex.has(idx)) phasesRemoved.push(m);
  }
  for (const m of manifestUnindexed) {
    if (!consumedUnindexed.has(m)) phasesRemoved.push(m);
  }

  const planChanged =
    parsed.plan !== manifest.epic.plan
      ? { from: manifest.epic.plan, to: parsed.plan }
      : null;

  return {
    phasesAdded,
    phasesRemoved,
    phasesRenamed,
    issuesAdded,
    issuesRemoved,
    planChanged,
  };
}

/**
 * Apply a ChangeSet to a manifest in body order. Mutates in place AND
 * returns the same reference. `autonomy` and unknown top-level keys are
 * never touched.
 */
export function applyChangeSet(
  manifest: EpicManifest,
  changes: ChangeSet,
  parsed: ParsedEpicBody,
): EpicManifest {
  for (const rename of changes.phasesRenamed) {
    const phase = manifest.phases.find((p) => extractIndex(p.name) === rename.index);
    if (phase != null) phase.name = rename.to;
  }

  for (const [key, refs] of Object.entries(changes.issuesAdded)) {
    const idx = Number.parseInt(key.slice(1), 10);
    const phase = manifest.phases.find((p) => extractIndex(p.name) === idx);
    if (phase != null) {
      for (const ref of refs) {
        if (!phase.issues.includes(ref)) phase.issues.push(ref);
      }
    }
  }

  for (const [key, refs] of Object.entries(changes.issuesRemoved)) {
    const idx = Number.parseInt(key.slice(1), 10);
    const phase = manifest.phases.find((p) => extractIndex(p.name) === idx);
    if (phase != null) {
      phase.issues = phase.issues.filter((r) => !refs.includes(r));
    }
  }

  if (changes.phasesRemoved.length > 0) {
    const removedNames = new Set(changes.phasesRemoved.map((p) => p.name));
    manifest.phases = manifest.phases.filter((p) => !removedNames.has(p.name));
  }

  if (changes.phasesAdded.length > 0) {
    const addedIndices = new Set(changes.phasesAdded.map((p) => p.index));
    for (const parsedPhase of parsed.phases) {
      if (!addedIndices.has(parsedPhase.index)) continue;
      const entry: PhaseEntry = {
        name: parsedPhase.name,
        ...(parsedPhase.tier != null ? { tier: parsedPhase.tier } : {}),
        repos: [],
        issues: [...parsedPhase.issues],
      };
      manifest.phases.push(entry);
    }
  }

  if (changes.planChanged != null) {
    manifest.epic.plan = changes.planChanged.to;
  }

  return manifest;
}
