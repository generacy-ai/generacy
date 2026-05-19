import type { CredentialEntry } from '../schemas/credentials.js';

export interface OverlayResult {
  merged: CredentialEntry[];
  overlayIds: string[];
}

export function mergeCredentialOverlay(
  committed: CredentialEntry[],
  overlay: CredentialEntry[],
): OverlayResult {
  const map = new Map(committed.map((c) => [c.id, c]));
  const overlayIds: string[] = [];

  for (const entry of overlay) {
    map.set(entry.id, entry);
    overlayIds.push(entry.id);
  }

  return { merged: [...map.values()], overlayIds };
}
