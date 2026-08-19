export type ForkStatusChip = { key: string; text: string };

const USAGE_CHIP = /grok|usage/i;

export function isForkUsageChip(status: ForkStatusChip): boolean {
  return USAGE_CHIP.test(`${status.key} ${status.text}`);
}

export function forkUsageChips(statuses: ForkStatusChip[]): ForkStatusChip[] {
  return statuses.filter((status) => isForkUsageChip(status) && status.text.trim().length > 0);
}

export function forkStatusBarStatuses(statuses: ForkStatusChip[]): ForkStatusChip[] {
  return statuses.filter((status) => !USAGE_CHIP.test(status.key));
}
