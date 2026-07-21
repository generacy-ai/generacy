import { createHash } from 'node:crypto';
import type { IssueRef } from './schemas.js';
import type { GateType } from './types.js';

export interface DeriveGateKeyInput {
  issueRef: IssueRef;
  gateType: GateType;
  generation: string;
}

export function deriveGateKey(input: DeriveGateKeyInput): string {
  const { issueRef, gateType, generation } = input;
  return `${issueRef.owner}/${issueRef.repo}#${issueRef.number}:${gateType}:${generation}`;
}

export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}
