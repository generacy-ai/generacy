import type { IssueRef } from '@generacy-ai/cockpit';

export class ScopeContendedError extends Error {
  readonly code = 'SCOPE_ADD_CONTENDED' as const;
  readonly attempts: number;
  readonly ref: IssueRef;
  readonly mutation: 'add' | 'remove';
  readonly scope: { repo: string; number: number };

  constructor(opts: {
    attempts: number;
    ref: IssueRef;
    mutation: 'add' | 'remove';
    scope: { repo: string; number: number };
  }) {
    super(
      `SCOPE_ADD_CONTENDED: ${opts.mutation} ${opts.ref.repo}#${opts.ref.number} on ` +
        `${opts.scope.repo}#${opts.scope.number} exhausted retry budget after ${opts.attempts} attempts`,
    );
    this.name = 'ScopeContendedError';
    this.attempts = opts.attempts;
    this.ref = opts.ref;
    this.mutation = opts.mutation;
    this.scope = opts.scope;
  }
}
