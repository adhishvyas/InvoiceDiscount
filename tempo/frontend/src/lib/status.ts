/** Mirrors the contract's `Status` enum. */
export const Status = { Active: 0, Funded: 1, Paid: 2, Cancelled: 3 } as const;
export type StatusValue = (typeof Status)[keyof typeof Status];
export const STATUS_LABEL: Record<StatusValue, string> = { 0: 'Active', 1: 'Funded', 2: 'Paid', 3: 'Cancelled' };
