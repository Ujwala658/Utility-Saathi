import { beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

const countTxns = (billId: string) => (ctx.db.prepare('SELECT COUNT(*) AS n FROM payment_transactions WHERE bill_id = ?').get(billId) as { n: number }).n;

describe('payments (simulated)', () => {
  it('11. a pending payment blocks a second attempt for the same bill', async () => {
    const first = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'key-first-0001' });
    expect(first.status).toBe(201);
    expect(first.body.payment.state).toBe('pending');
    expect(first.body.notice).toBe('SIMULATED — NO MONEY MOVES');

    const second = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'key-second-0002' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_PAYMENT_BLOCKED');
    expect(second.body.error.details.existingState).toBe('pending');
    expect(countTxns('bill_lv_wa_10')).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM blocked_payment_attempts').get()).toEqual({ n: 1 });
    // The unresolved payment is untouched by the blocked attempt.
    const after = await ctx.as('asha').get(`/api/payments/${first.body.payment.id}`);
    expect(after.body.payment.state).toBe('pending');
  });

  it('12. debit confirmed but utility credit pending stays unresolved and blocks retry', async () => {
    const bill = await ctx.as('asha').get('/api/bills/bill_lv_el_10');
    expect(bill.body.bill.paymentStatus).toBe('payment_in_progress');
    expect(bill.body.payments[0].state).toBe('debit_confirmed');

    const retry = await ctx.as('asha').post('/api/bills/bill_lv_el_10/payments', { idempotencyKey: 'retry-attempt-01' });
    expect(retry.status).toBe(409);
    expect(retry.body.error.message).toMatch(/bank has confirmed a debit/);
    expect(countTxns('bill_lv_el_10')).toBe(1);
    expect((await ctx.as('asha').get('/api/payments/txn_lv10')).body.payment.state).toBe('debit_confirmed');

    // Only a utility credit event resolves it; then a receipt exists and the bill is paid.
    const credit = await ctx.as('priya').post('/api/admin/payments/txn_lv10/events', { toState: 'credit_reconciled', source: 'simulated_utility' });
    expect(credit.status).toBe(200);
    expect(credit.body.payment.receiptRef).toMatch(/^SIM-RCPT-/);
    expect((await ctx.as('asha').get('/api/bills/bill_lv_el_10')).body.bill.paymentStatus).toBe('paid');
    const again = await ctx.as('asha').post('/api/bills/bill_lv_el_10/payments', { idempotencyKey: 'after-paid-0001' });
    expect(again.body.error.code).toBe('ALREADY_PAID');
  });

  it('13. a repeated idempotency key returns the original payment and creates nothing new', async () => {
    const a = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'same-key-12345' });
    const b = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'same-key-12345' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.payment.id).toBe(a.body.payment.id);
    expect(countTxns('bill_lv_wa_10')).toBe(1);
    const other = await ctx.as('asha').post('/api/bills/bill_lv_el_09/payments', { idempotencyKey: 'same-key-12345' });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('14a. retry is allowed only after the earlier attempt is confirmed failed', async () => {
    const a = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'attempt-one-001' });
    await ctx.as('priya').post(`/api/admin/payments/${a.body.payment.id}/events`, { toState: 'failed', source: 'simulated_gateway' });
    const b = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'attempt-two-002' });
    expect(b.status).toBe(201);
    expect(countTxns('bill_lv_wa_10')).toBe(2);
  });

  it('14b. retry is allowed after a confirmed reversal', async () => {
    await ctx.as('priya').post('/api/admin/payments/txn_lv10/events', { toState: 'reversed', source: 'simulated_gateway', note: 'Bank reversed debit' });
    const retry = await ctx.as('asha').post('/api/bills/bill_lv_el_10/payments', { idempotencyKey: 'after-reverse-01' });
    expect(retry.status).toBe(201);
  });

  it('rejects illegal transitions and wrong event sources', async () => {
    const a = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'illegal-test-01' });
    const id = a.body.payment.id;
    const skip = await ctx.as('priya').post(`/api/admin/payments/${id}/events`, { toState: 'credit_reconciled', source: 'simulated_utility' });
    expect(skip.status).toBe(409);
    const wrongSource = await ctx.as('priya').post(`/api/admin/payments/${id}/events`, { toState: 'debit_confirmed', source: 'simulated_utility' });
    expect(wrongSource.status).toBe(422);
    await ctx.as('priya').post(`/api/admin/payments/${id}/events`, { toState: 'failed', source: 'simulated_gateway' });
    const revive = await ctx.as('priya').post(`/api/admin/payments/${id}/events`, { toState: 'pending', source: 'simulated_gateway' });
    expect(revive.status).toBe(409);
    const tenant = await ctx.as('asha').post(`/api/admin/payments/${id}/events`, { toState: 'failed', source: 'simulated_gateway' });
    expect(tenant.status).toBe(403);
    const history = (await ctx.as('asha').get(`/api/payments/${id}`)).body.payment.events.map((e: any) => e.to_state);
    expect(history).toEqual(['initiated', 'pending', 'failed']);
  });

  it('refuses bills under review, other properties, and admins paying', async () => {
    expect((await ctx.as('karthik').post('/api/bills/bill_mr_wa_10/payments', { idempotencyKey: 'review-bill-01' })).body.error.code).toBe('BILL_UNDER_REVIEW');
    expect((await ctx.as('asha').post('/api/bills/bill_mr_el_10/payments', { idempotencyKey: 'not-mine-0001' })).status).toBe(404);
    expect((await ctx.as('priya').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'admin-pay-001' })).status).toBe(403);
  });

  it('the database itself enforces one open payment, legal transitions and append-only events', () => {
    const now = new Date().toISOString();
    const insert = (id: string, key: string) =>
      ctx.db
        .prepare("INSERT INTO payment_transactions (id, txn_ref, bill_id, user_id, idempotency_key, amount_paise, state, created_at, updated_at) VALUES (?, ?, 'bill_lv_el_10', 'u_asha', ?, 100, 'initiated', ?, ?)")
        .run(id, `REF-${id}`, key, now, now);
    expect(() => insert('txn_dup', 'raw-sql-key')).toThrow(/UNIQUE/);
    expect(() => ctx.db.prepare("UPDATE payment_transactions SET state = 'pending' WHERE id = 'txn_lv10'").run()).toThrow(/illegal payment state transition/);
    expect(() => ctx.db.prepare("UPDATE payment_transactions SET amount_paise = 1 WHERE id = 'txn_lv10'").run()).toThrow(/immutable/);
    expect(() => ctx.db.prepare('UPDATE payment_events SET note = ? WHERE txn_id = ?').run('x', 'txn_lv10')).toThrow(/append-only/);
    expect(() => ctx.db.prepare('DELETE FROM payment_events').run()).toThrow(/append-only/);
    expect(() =>
      ctx.db
        .prepare("INSERT INTO payment_transactions (id, txn_ref, bill_id, user_id, idempotency_key, amount_paise, state, created_at, updated_at) VALUES ('t2', 'R2', 'bill_lv_wa_10', 'u_asha', 'k2', 100, 'credit_reconciled', ?, ?)")
        .run(now, now),
    ).toThrow(/must start in initiated/);
  });

  it('payment requests never accept card or bank credentials', async () => {
    const res = await ctx.as('asha').post('/api/bills/bill_lv_wa_10/payments', { idempotencyKey: 'cred-test-0001', otp: 'otp-secret-731904', cvv: 'cvv-secret-482' });
    expect(res.status).toBe(201);
    const stored = JSON.stringify(ctx.db.prepare('SELECT * FROM payment_transactions').all()) + JSON.stringify(ctx.db.prepare('SELECT * FROM payment_events').all());
    expect(stored).not.toContain('otp-secret');
    expect(stored).not.toContain('cvv-secret');
  });
});
