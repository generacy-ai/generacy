export interface TierLimitErrorInput {
  requested: number;
  cap: number;
  tier: string;
}

export function formatTierLimitError(input: TierLimitErrorInput): string {
  const { requested, cap, tier } = input;
  const planQualifier = tier ? `${tier.charAt(0).toUpperCase() + tier.slice(1)} plan` : 'plan';
  return `Worker count of ${requested} exceeds your ${planQualifier} limit of ${cap}. Upgrade your plan or retry with --workers=${cap}.`;
}
