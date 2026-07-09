import chalk from 'chalk';
import type { CockpitState } from '@generacy-ai/cockpit';

export type ChalkFn = (s: string) => string;

export interface Colorizer {
  state(s: string, state: CockpitState): string;
  doneMerged(s: string): string;
  doneNotPlanned(s: string): string;
}

export const STATE_COLOR: Record<CockpitState, ChalkFn> = {
  terminal: chalk.green,
  error: chalk.red,
  waiting: chalk.yellow,
  active: chalk.cyan,
  pending: chalk.dim,
  'stage-complete': chalk.dim,
  unknown: chalk.dim,
};

export const chalkColorizer: Colorizer = {
  state(s, state) {
    return STATE_COLOR[state](s);
  },
  doneMerged(s) {
    return chalk.green(s);
  },
  doneNotPlanned(s) {
    return chalk.gray(s);
  },
};

export const identityColorizer: Colorizer = {
  state(s) {
    return s;
  },
  doneMerged(s) {
    return s;
  },
  doneNotPlanned(s) {
    return s;
  },
};
