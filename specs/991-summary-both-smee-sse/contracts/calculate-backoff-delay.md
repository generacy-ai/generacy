# Contract: `calculateBackoffDelay`

**Package**: `@generacy-ai/smee-backoff`
**Export**: `calculateBackoffDelay(attempt: number, opts: BackoffOptions): number`

## Signature

```ts
export interface BackoffOptions {
  base: number;
  cap: number;
  random?: () => number;
}

export function calculateBackoffDelay(
  attempt: number,
  opts: BackoffOptions,
): number;
```

## Algorithm

Let `rng = opts.random ?? Math.random`.

1. `raw = opts.base * Math.pow(2, attempt)`
2. `capped = Math.min(raw, opts.cap)`
3. `return capped / 2 + rng() * (capped / 2)`

## Guarantees

| ID | Guarantee |
|----|-----------|
| G1 | For every `attempt >= 0`, return value ∈ `[capped/2, capped)`. |
| G2 | At `attempt = 0`, return value ∈ `[base/2, base)` (assuming `base <= cap`). |
| G3 | For any `attempt` such that `base * 2^attempt >= cap`, return value ∈ `[cap/2, cap)`. |
| G4 | For a fixed `attempt`, two calls with `rng` returning distinct values in `[0, 1)` produce distinct return values. |
| G5 | Return value never overshoots `cap`. |
| G6 | Return value is finite and non-negative. |

## Errors

| Precondition | Behaviour |
|--------------|-----------|
| `base <= 0` | Throw `RangeError('base must be > 0')`. |
| `cap < base` | Throw `RangeError('cap must be >= base')`. |
| `!Number.isFinite(attempt) \|\| attempt < 0` | Throw `RangeError('attempt must be a non-negative finite number')`. |

`opts.random`, if provided, is trusted to return values in `[0, 1)`. No runtime validation.

## Test cases

Each row is a required test in `packages/smee-backoff/tests/unit/calculate-backoff-delay.test.ts`.

| # | Input | Assertion | Covers |
|---|-------|-----------|--------|
| T1 | `attempt=0, base=5000, cap=30000, random=()=>0` | returns `2500` (exactly `base/2`) | G2 lower bound |
| T2 | `attempt=0, base=5000, cap=30000, random=()=>0.9999` | returns `< 5000` (approaches `base`) | G2 upper bound |
| T3 | `attempt=3, base=5000, cap=30000, random=()=>0` | returns `15000` (`cap/2`) — `raw=40000` capped at `30000` | G3 lower bound, G5 |
| T4 | `attempt=3, base=5000, cap=30000, random=()=>0.9999` | returns `< 30000` | G3 upper bound, G5 |
| T5 | `attempt=10, base=5000, cap=30000, random=()=>0.5` | returns exactly `22500` (`cap/2 + 0.5 * cap/2`) — regardless of how many times ladder doubled past cap | G1, G5 |
| T6 | `attempt=3, base=5000, cap=30000` called twice with `random` returning `0.1` then `0.9` | two distinct return values | G4 (SC-004) |
| T7 | `attempt=-1` or `attempt=NaN` | throws `RangeError` | error contract |
| T8 | `base=0` | throws `RangeError` | error contract |
| T9 | `cap=1000, base=5000` (cap < base) | throws `RangeError` | error contract |
| T10 | `attempt=2, base=5000, cap=30000, random=()=>0.5` | returns exactly `15000` (`raw=20000`, not yet capped; `capped/2 = 10000`; `10000 + 0.5*10000 = 15000`) | mid-ladder correctness (guards a common off-by-one where jitter is applied before the cap) |

## Non-goals

- No async surface — synchronous return.
- No caller-side rounding — return value may be fractional ms; `setTimeout` truncates as usual.
- No self-timing / no logging — pure function.
