// Payment states and the transitions allowed between them.
// Any transition not listed here is rejected.

export const STATUS = Object.freeze({
  CREATED: 'created',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAID: 'paid',
  CLAIMABLE: 'claimable',
  CLAIMED: 'claimed',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  FAILED: 'failed',
});

const TRANSITIONS = Object.freeze({
  [STATUS.CREATED]: [STATUS.AWAITING_PAYMENT, STATUS.FAILED],
  [STATUS.AWAITING_PAYMENT]: [STATUS.PAID, STATUS.EXPIRED, STATUS.FAILED],
  [STATUS.PAID]: [STATUS.CLAIMABLE],
  [STATUS.CLAIMABLE]: [STATUS.CLAIMED, STATUS.EXPIRED],
  [STATUS.CLAIMED]: [STATUS.COMPLETED, STATUS.FAILED],
  [STATUS.COMPLETED]: [],
  [STATUS.EXPIRED]: [],
  [STATUS.FAILED]: [],
});

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid payment transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
