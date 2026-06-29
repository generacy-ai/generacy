import chalk from 'chalk';
import type { CockpitState } from '@generacy-ai/cockpit';

export type ChalkFn = (s: string) => string;

export interface Colorizer {
  state(s: string, state: CockpitState): string;
  stuck(s: string, stuck: boolean): string;
}

export const STATE_COLOR: Record<CockpitState, ChalkFn> = {
  terminal: chalk.green,
  error: chalk.red,
  waiting: chalk.yellow,
  active: chalk.cyan,
  pending: chalk.dim,
  unknown: chalk.dim,
};

export const chalkColorizer: Colorizer = {
  state(s, state) {
    return STATE_COLOR[state](s);
  },
  stuck(s, stuck) {
    return stuck ? chalk.red(s) : s;
  },
};

export const identityColorizer: Colorizer = {
  state(s) {
    return s;
  },
  stuck(s) {
    return s;
  },
};
