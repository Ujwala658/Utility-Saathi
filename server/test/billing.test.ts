// Expected values in this file were worked out by hand from the synthetic
// tariff tables (see comments on each case), not by calling the engine.
import { describe, expect, it } from 'vitest';
import { BillInput, BillValidationError, calculateBill } from '../src/domain/billing.js';
import { divRoundHalfUp, roundToRupee } from '../src/domain/money.js';

const meter5 = { digits: 5, multiplier: 1 };
const elec = (over: Partial<BillInput>): BillInput => ({
  utility: 'electricity',
  tariffCode: 'SYN-ELEC-DOM',
  periodStart: '2026-06-01',
  periodEnd: '2026-07-01',
  previousReading: 12000,
  currentReading: 12150,
  readingType: 'actual',
  meter: meter5,
  ...over,
});
const water = (over: Partial<BillInput>): BillInput => ({
  utility: 'water',
  tariffCode: 'SYN-WATER-DOM',
  periodStart: '2026-06-01',
  periodEnd: '2026-07-01',
  previousReading: 1000,
  currentReading: 1015,
  readingType: 'actual',
  meter: { digits: 6, multiplier: 1 },
  ...over,
});
// Two 30-day actual periods at 150 kWh -> baseline 5 kWh/day.
const elecHistory = [
  { periodStart: '2026-02-01', periodEnd: '2026-03-03', units: 150, readingType: 'actual' as const, tariffVersion: '2025-26' },
  { periodStart: '2026-03-03', periodEnd: '2026-04-02', units: 150, readingType: 'actual' as const, tariffVersion: '2025-26' },
];
const codes = (r: ReturnType<typeof calculateBill>) => r.anomalies.map((a) => a.code).sort();

describe('rounding helpers', () => {
  it('rounds halves up and keeps exact values', () => {
    expect(divRoundHalfUp(15, 10)).toBe(2);
    expect(divRoundHalfUp(14, 10)).toBe(1);
    expect(divRoundHalfUp(20, 10)).toBe(2);
    expect(roundToRupee(60125)).toBe(60100);
    expect(roundToRupee(26250)).toBe(26300);
  });
});

describe('bill reconstruction', () => {
  it('1. normal electricity bill: 150 kWh on 2025-26', () => {
    // 100×3.00=300.00, 50×4.50=225.00, fixed 50.00, duty 5%×525=26.25 -> 601.25 -> ₹601
    const r = calculateBill(elec({ history: elecHistory }));
    expect(r.status).toBe('ok');
    expect(r.consumption).toBe(150);
    expect(r.tariff.version).toBe('2025-26');
    expect(r.totals).toMatchObject({ energyPaise: 52500, fixedPaise: 5000, taxPaise: 2625, currentChargesPaise: 60125, roundingPaise: -25, payablePaise: 60100 });
    expect(r.anomalies).toEqual([]);
    expect(r.steps.some((s) => s.includes('Synthetic demo tariff'))).toBe(true);
  });

  it('2. normal water bill: 18.25 kL', () => {
    // 10×7=70.00, 8.25×15=123.75, fixed 30.00, sewerage 20%×193.75=38.75 -> 262.50 -> ₹263 (half up)
    const r = calculateBill(water({ previousReading: 1234.5, currentReading: 1252.75 }));
    expect(r.consumption).toBe(18.25);
    expect(r.totals).toMatchObject({ energyPaise: 19375, taxPaise: 3875, beforeRoundingPaise: 26250, roundingPaise: 50, payablePaise: 26300 });
  });

  it('3. estimated-to-actual catch-up is explained, not diagnosed', () => {
    // Two estimates of 100 kWh then an actual 250 kWh. Combined (200+250)/90 days = 5.0/day = baseline.
    // 300 + 450 + 50×6=300 -> 1050; fixed 50; duty 52.50 -> 1152.50 -> ₹1153
    const history = [
      ...elecHistory,
      { periodStart: '2026-04-02', periodEnd: '2026-05-02', units: 100, readingType: 'estimated' as const },
      { periodStart: '2026-05-02', periodEnd: '2026-06-01', units: 100, readingType: 'estimated' as const },
    ];
    const r = calculateBill(elec({ previousReading: 12000, currentReading: 12250, history }));
    expect(r.totals?.payablePaise).toBe(115300);
    expect(codes(r)).toEqual(['CONSUMPTION_INCREASE', 'ESTIMATED_CATCHUP', 'SLAB_CROSSING']);
    const catchup = r.anomalies.find((a) => a.code === 'ESTIMATED_CATCHUP')!;
    expect(catchup.confidence).toBe('medium');
    expect(catchup.evidence.join(' ')).toContain('5.00 kWh/day');
    expect(r.status).toBe('ok');
  });

  it('4. consumption increase is flagged without an unsupported diagnosis', () => {
    // Baseline 15 kL/30 days = 0.5/day; now 27 kL/30 days = 0.9/day (+80%).
    // 70 + 150 + 7×25=175 -> 395; fixed 30; sewerage 79 -> ₹504
    const history = [
      { periodStart: '2026-04-01', periodEnd: '2026-05-01', units: 15, readingType: 'actual' as const },
      { periodStart: '2026-05-01', periodEnd: '2026-05-31', units: 15, readingType: 'actual' as const },
    ];
    const r = calculateBill(water({ periodStart: '2026-05-31', periodEnd: '2026-06-30', previousReading: 2000, currentReading: 2027, history }));
    expect(r.totals?.payablePaise).toBe(50400);
    const inc = r.anomalies.find((a) => a.code === 'CONSUMPTION_INCREASE')!;
    expect(inc.title).toContain('80%');
    expect(inc.severity).toBe('warning');
    expect(inc.confidence).toBe('low');
    expect(inc.limitations).toContain('does not prove');
    expect(inc.title.toLowerCase()).not.toMatch(/leak|fault|fraud/);
    expect(r.status).toBe('ok');
  });

  it('5. slab boundary: 100 kWh stays in slab 1, 101 kWh enters slab 2', () => {
    // 100: 300.00 + 50 + 15.00 = 365.00
    const at = calculateBill(elec({ currentReading: 12100 }));
    expect(at.lineItems.filter((l) => l.kind === 'slab')).toHaveLength(1);
    expect(at.totals?.payablePaise).toBe(36500);
    // 101: 300.00 + 4.50 = 304.50; duty 15.225 -> 15.23; 369.73 -> ₹370
    const over = calculateBill(elec({ currentReading: 12101 }));
    expect(over.lineItems.filter((l) => l.kind === 'slab').map((l) => l.quantity)).toEqual([100, 1]);
    expect(over.totals).toMatchObject({ taxPaise: 1523, beforeRoundingPaise: 36973, payablePaise: 37000 });
  });

  it('6. tariff version change inside the period uses the reading-date version and is flagged', () => {
    // 2026-27: 100×3.20=320, 50×4.80=240 -> 560; fixed 60; duty 28 -> ₹648
    const r = calculateBill(elec({ periodStart: '2026-08-15', periodEnd: '2026-09-14', history: elecHistory }));
    expect(r.tariff.version).toBe('2026-27');
    expect(r.totals?.payablePaise).toBe(64800);
    const change = r.anomalies.find((a) => a.code === 'TARIFF_VERSION_CHANGE')!;
    expect(change.evidence.join(' ')).toContain('2026-09-01');
    expect(change.evidence.join(' ')).toContain('previous bill used version 2025-26');
  });

  it('7. unusual billing-period length is flagged', () => {
    // 45 days, 220 kWh: 300 + 450 + 20×6=120 -> 870; fixed 50; duty 43.50 -> 963.50 -> ₹964
    const r = calculateBill(elec({ periodStart: '2026-05-01', periodEnd: '2026-06-15', currentReading: 12220 }));
    expect(r.periodDays).toBe(45);
    expect(codes(r)).toContain('UNUSUAL_PERIOD_LENGTH');
    expect(r.totals?.payablePaise).toBe(96400);
  });

  it('8a. reading decrease is held for review with a plausible rollover hypothesis', () => {
    // 5-digit meter: 100000 − 99950 + 30 = 80 kWh, within 3× the usual 150 kWh.
    const r = calculateBill(elec({ previousReading: 99950, currentReading: 30, history: elecHistory }));
    expect(r.status).toBe('needs_review');
    expect(r.consumption).toBeNull();
    expect(r.totals).toBeNull();
    const dec = r.anomalies.find((a) => a.code === 'READING_DECREASE')!;
    expect(dec.evidence.join(' ')).toContain('80 kWh');
    expect(dec.explanations[0]).toContain('consistent with your usual usage');
    expect(dec.explanations.join(' ')).toMatch(/replaced/);
    expect(dec.explanations.join(' ')).toMatch(/transcription/);
  });

  it('8b. reading decrease with an implausible rollover says so', () => {
    // 100000 − 5000 + 4900 = 99,900 kWh, far above 3 × 150.
    const r = calculateBill(elec({ previousReading: 5000, currentReading: 4900, history: elecHistory }));
    const dec = r.anomalies.find((a) => a.code === 'READING_DECREASE')!;
    expect(dec.explanations[0]).toContain('unlikely');
    expect(r.consumption).toBeNull();
  });

  it('9. arithmetic mismatch above ₹1 is flagged; rounding-sized differences are not', () => {
    const off = calculateBill(elec({ statedTotalPaise: 70100 }));
    expect(off.status).toBe('needs_review');
    expect(off.anomalies.find((a) => a.code === 'ARITHMETIC_MISMATCH')?.title).toContain('₹100.00');
    const close = calculateBill(elec({ statedTotalPaise: 60150 }));
    expect(codes(close)).not.toContain('ARITHMETIC_MISMATCH');
  });

  it('10a. credits, subsidies, arrears, adjustments and rounding', () => {
    // 180 kWh: 300 + 80×4.5=360 -> 660; fixed 50; duty 33 -> 743.00
    // −150.00 subsidy −20.35 credit +112.10 arrears −5.00 adjustment = 679.75 -> ₹680 (+0.25)
    const r = calculateBill(
      elec({
        currentReading: 12180,
        credits: [
          { label: 'State domestic subsidy', amountPaise: 15000, kind: 'subsidy' },
          { label: 'Excess payment last cycle', amountPaise: 2035, kind: 'credit' },
        ],
        arrearsPaise: 11210,
        adjustments: [{ label: 'Meter rent correction', amountPaise: -500 }],
      }),
    );
    expect(r.totals).toMatchObject({ currentChargesPaise: 74300, creditsPaise: 17035, beforeRoundingPaise: 67975, roundingPaise: 25, payablePaise: 68000 });
  });

  it('10b. credits larger than charges carry forward instead of a negative bill', () => {
    // 100 kWh = 365.00; credit 400.00 -> nothing payable, 35.00 carried forward
    const r = calculateBill(elec({ currentReading: 12100, credits: [{ label: 'Refund', amountPaise: 40000, kind: 'credit' }] }));
    expect(r.totals).toMatchObject({ payablePaise: 0, carryForwardCreditPaise: 3500, roundingPaise: 0 });
  });

  it('11. missing reading needs review and is not billed', () => {
    const r = calculateBill(elec({ previousReading: null }));
    expect(r.status).toBe('needs_review');
    expect(codes(r)).toEqual(['MISSING_READING']);
    expect(r.totals).toBeNull();
  });

  it('12. CT meter multiplier is applied to consumption', () => {
    // (575 − 500) × 2 = 150 kWh -> same as case 1, ₹601
    const r = calculateBill(elec({ previousReading: 500, currentReading: 575, meter: { digits: 5, multiplier: 2 } }));
    expect(r.consumption).toBe(150);
    expect(r.totals?.payablePaise).toBe(60100);
  });

  it('13. sub-paisa water charges round half-up per line', () => {
    // 10.001 kL: 70.00 + 0.001×15.00 = 0.015 -> 0.02; sewerage 20%×70.02 = 14.004 -> 14.00; 114.02 -> ₹114
    const r = calculateBill(water({ previousReading: 0, currentReading: 10.001 }));
    expect(r.totals).toMatchObject({ energyPaise: 7002, taxPaise: 1400, beforeRoundingPaise: 11402, payablePaise: 11400 });
  });

  it('14. top open-ended slab', () => {
    // 450 kWh: 300 + 450 + 1200 + 50×8=400 -> 2350; fixed 50; duty 117.50 -> 2517.50 -> ₹2518
    const r = calculateBill(elec({ currentReading: 12450 }));
    expect(r.lineItems.filter((l) => l.kind === 'slab').map((l) => l.ratePaise)).toEqual([300, 450, 600, 800]);
    expect(r.totals?.payablePaise).toBe(251800);
  });

  it('15. no baseline comparison without at least two actual readings', () => {
    const r = calculateBill(elec({ currentReading: 12450, history: [elecHistory[0]] }));
    expect(codes(r)).not.toContain('CONSUMPTION_INCREASE');
    expect(codes(r)).not.toContain('SLAB_CROSSING');
  });

  it('16. invalid input is rejected', () => {
    expect(() => calculateBill(elec({ currentReading: -1 }))).toThrow(BillValidationError);
    expect(() => calculateBill(elec({ periodEnd: '2026-05-01' }))).toThrow(/after its start/);
    expect(() => calculateBill(elec({ periodEnd: '2026-02-30' }))).toThrow(/calendar date/);
    expect(() => calculateBill(elec({ credits: [{ label: 'x', amountPaise: -5, kind: 'credit' }] }))).toThrow(BillValidationError);
    expect(() => calculateBill(elec({ tariffCode: 'SYN-WATER-DOM' }))).toThrow(/water tariff/);
    expect(() => calculateBill(elec({ periodStart: '2020-01-01', periodEnd: '2020-02-01' }))).toThrow(/No SYN-ELEC-DOM tariff/);
  });
});
