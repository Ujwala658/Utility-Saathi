import { randomBytes } from 'node:crypto';
import type { SessionUser } from '../auth.js';
import { getAccessibleBill } from '../access.js';
import { audit, DB, newId } from '../db/index.js';
import { canTransition, duplicateBlockReason, EVENT_SOURCES, PaymentState, STATE_LABELS, TRANSITIONS } from '../domain/payments.js';
import { AppError, notFound } from '../errors.js';
import { billPaymentStatus } from './bills.js';

export const SIMULATION_NOTICE = 'SIMULATED — NO MONEY MOVES';

interface TxnRow {
  id: string;
  txn_ref: string;
  bill_id: string;
  user_id: string;
  idempotency_key: string;
  amount_paise: number;
  state: PaymentState;
  receipt_ref: string | null;
  created_at: string;
  updated_at: string;
}

const ref = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

function insertEvent(db: DB, txnId: string, from: PaymentState | null, to: PaymentState, source: string, note: string | null, actorId: string | null, at: string) {
  db.prepare('INSERT INTO payment_events (txn_id, from_state, to_state, source, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    txnId, from, to, source, note, actorId, at,
  );
}

export function getTxn(db: DB, id: string) {
  return db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id) as TxnRow | undefined;
}

export function presentTxn(db: DB, t: TxnRow) {
  const events = db.prepare('SELECT from_state, to_state, source, note, created_at FROM payment_events WHERE txn_id = ? ORDER BY id').all(t.id);
  const bill = db.prepare('SELECT bill_number FROM bills WHERE id = ?').get(t.bill_id) as { bill_number: string };
  return {
    id: t.id,
    txnRef: t.txn_ref,
    billId: t.bill_id,
    billNumber: bill.bill_number,
    amountPaise: t.amount_paise,
    state: t.state,
    stateLabel: STATE_LABELS[t.state],
    allowedNext: TRANSITIONS[t.state],
    receiptRef: t.receipt_ref,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    events,
    simulated: true,
    notice: SIMULATION_NOTICE,
  };
}

/**
 * Start a (simulated) payment for a bill.
 * - The same idempotency key from the same user returns the original transaction.
 * - Any unresolved transaction on the bill blocks a new one (409) and is recorded.
 * - The partial unique index in the database backs this up under concurrency.
 */
export function initiatePayment(db: DB, user: SessionUser, billId: string, idempotencyKey: string, now = new Date()) {
  const at = now.toISOString();
  // A blocked attempt must be recorded even though the request fails, so the
  // transaction returns it and we throw only after commit.
  const outcome = db.transaction((): { replayed: boolean; txn: TxnRow } | { blocked: AppError } => {
    const existing = db.prepare('SELECT * FROM payment_transactions WHERE user_id = ? AND idempotency_key = ?').get(user.id, idempotencyKey) as TxnRow | undefined;
    if (existing) {
      if (existing.bill_id !== billId) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different bill');
      return { replayed: true, txn: existing };
    }
    const bill = getAccessibleBill(db, user, billId);
    if (user.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Administrators cannot pay customer bills');
    const status = billPaymentStatus(db, bill);
    if (status === 'paid') throw new AppError(409, 'ALREADY_PAID', 'This bill has already been paid and credited');
    if (status === 'on_hold_review') throw new AppError(409, 'BILL_UNDER_REVIEW', 'This bill needs review before it can be paid. You can raise a complaint with the bill reference.');
    if (status === 'nothing_due') throw new AppError(409, 'NOTHING_DUE', 'Nothing is payable on this bill');
    const open = db
      .prepare("SELECT * FROM payment_transactions WHERE bill_id = ? AND state IN ('initiated', 'pending', 'debit_confirmed')")
      .get(billId) as TxnRow | undefined;
    if (open) {
      const reason = duplicateBlockReason(open.state);
      db.prepare('INSERT INTO blocked_payment_attempts (bill_id, user_id, existing_txn_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(billId, user.id, open.id, reason, at);
      audit(db, user.id, 'payment.duplicate_blocked', 'bill', billId, { existingTxn: open.txn_ref, existingState: open.state }, at);
      return { blocked: new AppError(409, 'DUPLICATE_PAYMENT_BLOCKED', reason, { existingTxnRef: open.txn_ref, existingState: open.state }) };
    }
    const id = newId('txn');
    db.prepare(
      `INSERT INTO payment_transactions (id, txn_ref, bill_id, user_id, idempotency_key, amount_paise, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'initiated', ?, ?)`,
    ).run(id, ref('SIMTXN'), billId, user.id, idempotencyKey, bill.payable_paise, at, at);
    insertEvent(db, id, null, 'initiated', 'user', 'Payment started in Utility Saathi (simulated)', user.id, at);
    // The simulated gateway accepts the request immediately; real gateways would call back.
    db.prepare("UPDATE payment_transactions SET state = 'pending', updated_at = ? WHERE id = ?").run(at, id);
    insertEvent(db, id, 'initiated', 'pending', 'simulated_gateway', 'Simulated gateway accepted the request', null, at);
    audit(db, user.id, 'payment.initiated', 'payment', id, { billId, amountPaise: bill.payable_paise }, at);
    return { replayed: false, txn: getTxn(db, id)! };
  })();
  if ('blocked' in outcome) throw outcome.blocked;
  return outcome;
}

/** Record a simulated provider event (admin console stands in for gateway/utility callbacks). */
export function recordPaymentEvent(db: DB, actor: SessionUser, txnId: string, to: PaymentState, source: string, note: string | null, now = new Date()) {
  const at = now.toISOString();
  return db.transaction(() => {
    const t = getTxn(db, txnId);
    if (!t) throw notFound('Transaction');
    if (!canTransition(t.state, to)) {
      throw new AppError(409, 'ILLEGAL_TRANSITION', `A payment that is "${STATE_LABELS[t.state]}" cannot move to "${STATE_LABELS[to]}"`);
    }
    if (!EVENT_SOURCES[to].includes(source)) {
      throw new AppError(422, 'WRONG_EVENT_SOURCE', `"${to}" can only be reported by ${EVENT_SOURCES[to].join(' or ')}`);
    }
    const receipt = to === 'credit_reconciled' ? ref('SIM-RCPT') : null;
    db.prepare('UPDATE payment_transactions SET state = ?, updated_at = ?, receipt_ref = COALESCE(?, receipt_ref) WHERE id = ?').run(to, at, receipt, txnId);
    insertEvent(db, txnId, t.state, to, source, note, actor.id, at);
    audit(db, actor.id, 'payment.event_recorded', 'payment', txnId, { from: t.state, to, source }, at);
    return getTxn(db, txnId)!;
  })();
}
