/** Mirrors the contract's `Status` enum. */
export const Status = { Active: 0, Funded: 1, Paid: 2, Cancelled: 3 } as const;
/** One of the {@link Status} values, as `getInvoice().status` returns it. */
export type StatusValue = (typeof Status)[keyof typeof Status];
/** Display label for each status. */
export const STATUS_LABEL: Record<StatusValue, string> = { 0: 'Active', 1: 'Funded', 2: 'Paid', 3: 'Cancelled' };
