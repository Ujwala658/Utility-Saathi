// Payment state machine. The same transition table is enforced by a database
// trigger (see schema.sql); this module gives the application readable
// errors and explanations before the database has to refuse.

export const PAYMENT_STATES = ['initiated', 'pending', 'debit_confirmed', 'credit_reconciled', 'failed', 'reversed'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  initiated: ['pending', 'failed'],
  pending: ['debit_confirmed', 'failed'],
  debit_confirmed: ['credit_reconciled', 'reversed'],
  credit_reconciled: [],
  failed: [],
  reversed: [],
};

/** Which simulated party may report each state. Bank debit and utility credit are separate events. */
export const EVENT_SOURCES: Record<PaymentState, string[]> = {
  initiated: ['user'],
  pending: ['simulated_gateway'],
  debit_confirmed: ['simulated_gateway'],
  failed: ['simulated_gateway'],
  reversed: ['simulated_gateway'],
  credit_reconciled: ['simulated_utility'],
};

export const UNRESOLVED: PaymentState[] = ['initiated', 'pending', 'debit_confirmed'];

export const isUnresolved = (s: PaymentState) => UNRESOLVED.includes(s);
export const canTransition = (from: PaymentState, to: PaymentState) => TRANSITIONS[from].includes(to);

export const STATE_LABELS: Record<PaymentState, string> = {
  initiated: 'Initiated',
  pending: 'Pending with payment gateway',
  debit_confirmed: 'Bank debit confirmed, utility credit pending',
  credit_reconciled: 'Credited to utility account',
  failed: 'Failed (no debit)',
  reversed: 'Debit reversed to your bank',
};

/** Why a second payment is blocked while `state` is unresolved. */
export function duplicateBlockReason(state: PaymentState): string {
  switch (state) {
    case 'debit_confirmed':
      return 'Your bank has confirmed a debit for this bill, but the utility has not yet confirmed the credit. Paying again could charge you twice. Wait for the credit to be reconciled or for the debit to be reversed.';
    case 'pending':
    case 'initiated':
      return 'An earlier payment for this bill is still being processed. Paying again could charge you twice. You can retry only if that payment is confirmed failed.';
    default:
      return 'An earlier payment for this bill is unresolved.';
  }
}
