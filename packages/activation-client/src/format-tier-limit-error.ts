export interface TierLimitErrorInput {
  requested: number;
  cap: number;
  tier: string;
}

export function formatTierLimitError(input: TierLimitErrorInput): string {
  const { requested, cap, tier } = input;
  const titleCased = tier.charAt(0).toUpperCase() + tier.slice(1);
  return `Worker count of ${requested} exceeds your ${titleCased} plan limit of ${cap}. Upgrade your plan or retry with --workers=${cap}.`;
}
