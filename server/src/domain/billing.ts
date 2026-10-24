// Transparent bill reconstruction and explainable anomaly checks.
//
// Assumptions (stated so they can be tested and challenged):
// - Slabs apply to the whole bill and are NOT prorated by period length.
//   Unusual period lengths are flagged instead.
// - If a tariff version changes inside a billing period, the version in force
//   on the current reading date applies to the whole bill, and the change is
//   flagged. Many regulators prorate instead; that is a P1 refinement.
// - Each line item is rounded half-up to the paisa; the final payable amount
//   is rounded half-up to the whole rupee with an explicit adjustment line.

import { z } from 'zod';
import { chargeForMilliUnits, formatINR, percentOf, roundToRupee } from './money.js';
import { findTariff, TariffVersion, versionChangesWithin, TARIFFS } from './tariffs.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-mm-dd').refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}, 'Not a real calendar date');

const paise = z.number().int().nonnegative();

export const historyEntrySchema = z.object({
  periodStart: isoDate,
  periodEnd: isoDate,
  units: z.number().nonnegative(),
  readingType: z.enum(['actual', 'estimated']),
  tariffVersion: z.string().optional(),
});

export const billInputSchema = z
  .object({
    utility: z.enum(['electricity', 'water']),
    tariffCode: z.string().min(1),
    periodStart: isoDate,
    periodEnd: isoDate,
    previousReading: z.number().nonnegative().nullable(),
    currentReading: z.number().nonnegative().nullable(),
    readingType: z.enum(['actual', 'estimated']),
    meter: z.object({ digits: z.number().int().min(3).max(9), multiplier: z.number().positive() }),
    credits: z.array(z.object({ label: z.string().min(1), amountPaise: paise, kind: z.enum(['credit', 'subsidy']) })).default([]),
    arrearsPaise: paise.default(0),
    adjustments: z.array(z.object({ label: z.string().min(1), amountPaise: z.number().int() })).default([]),
    statedTotalPaise: paise.optional(),
    history: z.array(historyEntrySchema).default([]),
  })
  .refine((b) => b.periodEnd > b.periodStart, { message: 'Billing period end must be after its start', path: ['periodEnd'] });

export type BillInput = z.input<typeof billInputSchema>;
type ParsedBill = z.output<typeof billInputSchema>;

export type Severity = 'info' | 'warning' | 'review';

export interface Anomaly {
  code:
    | 'ESTIMATED_CATCHUP'
    | 'CONSUMPTION_INCREASE'
    | 'SLAB_CROSSING'
    | 'TARIFF_VERSION_CHANGE'
    | 'UNUSUAL_PERIOD_LENGTH'
    | 'MISSING_READING'
    | 'READING_DECREASE'
    | 'ARITHMETIC_MISMATCH';
  severity: Severity;
  title: string;
  evidence: string[];
  explanations: string[];
  confidence: 'low' | 'medium' | 'high';
  limitations: string;
  checks: string[];
}

export interface LineItem {
  kind: 'slab' | 'fixed' | 'tax' | 'credit' | 'subsidy' | 'arrears' | 'adjustment' | 'rounding';
  label: string;
  quantity?: number;
  ratePaise?: number;
  amountPaise: number;
}

export interface BillResult {
  status: 'ok' | 'needs_review';
  periodDays: number;
  consumption: number | null;
  unit: 'kWh' | 'kL';
  tariff: { code: string; version: string; category: string; jurisdiction: string; source: TariffVersion['source'] };
  lineItems: LineItem[];
  totals: {
    energyPaise: number;
    fixedPaise: number;
    taxPaise: number;
    currentChargesPaise: number;
    creditsPaise: number;
    arrearsPaise: number;
    adjustmentsPaise: number;
    beforeRoundingPaise: number;
    roundingPaise: number;
    payablePaise: number;
    carryForwardCreditPaise: number;
  } | null;
  steps: string[];
  anomalies: Anomaly[];
}

export class BillValidationError extends Error {
  constructor(public issues: { path: string; message: string }[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  }
}

const DAY_MS = 86_400_000;
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

/** Readings are stored to 3 decimals (litres for kL meters); work in thousandths to avoid float drift. */
const toMilli = (n: number) => Math.round(n * 1000);
const fromMilli = (n: number) => n / 1000;

/** Split milli-units across slabs. Returns one entry per slab that has units. */
export function splitIntoSlabs(milliUnits: number, slabs: TariffVersion['slabs']) {
  const parts: { from: number; to: number | null; milliUnits: number; ratePaise: number }[] = [];
  let remaining = milliUnits;
  let lower = 0;
  for (const slab of slabs) {
    if (remaining <= 0) break;
    const capacity = slab.upTo === null ? Infinity : toMilli(slab.upTo) - lower;
    const used = Math.min(remaining, capacity);
    parts.push({ from: fromMilli(lower), to: slab.upTo, milliUnits: used, ratePaise: slab.ratePaise });
    remaining -= used;
    lower += used;
  }
  return parts;
}

function highestSlabIndex(units: number, slabs: TariffVersion['slabs']): number {
  const idx = slabs.findIndex((s) => s.upTo === null || units <= s.upTo);
  return idx === -1 ? slabs.length - 1 : idx;
}

function baselineFrom(history: ParsedBill['history']) {
  const actual = history.filter((h) => h.readingType === 'actual').slice(-3);
  if (actual.length < 2) return null;
  const units = actual.reduce((s, h) => s + h.units, 0);
  const days = actual.reduce((s, h) => s + daysBetween(h.periodStart, h.periodEnd), 0);
  return { dailyUnits: units / days, periods: actual.length, days };
}

const fmtUnits = (n: number, unit: string) => `${Number(n.toFixed(3)).toLocaleString('en-IN')} ${unit}`;

export function calculateBill(raw: BillInput): BillResult {
  const parsed = billInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BillValidationError(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const b = parsed.data;
  const tariff = findTariff(b.tariffCode, b.periodEnd, TARIFFS);
  if (tariff.utility !== b.utility) {
    throw new BillValidationError([{ path: 'tariffCode', message: `${b.tariffCode} is a ${tariff.utility} tariff` }]);
  }

  const periodDays = daysBetween(b.periodStart, b.periodEnd);
  const anomalies: Anomaly[] = [];
  const steps: string[] = [];
  const tariffInfo = {
    code: tariff.code,
    version: tariff.version,
    category: tariff.category,
    jurisdiction: tariff.jurisdiction,
    source: tariff.source,
  };
  steps.push(`Tariff ${tariff.code} version ${tariff.version} (${tariff.category}, ${tariff.jurisdiction}) applies on reading date ${b.periodEnd}. Source: ${tariff.source.label}.`);
  steps.push(`Billing period ${b.periodStart} to ${b.periodEnd} = ${periodDays} days.`);

  // Checks that do not depend on consumption.
  if (periodDays < tariff.cycleDays.min || periodDays > tariff.cycleDays.max) {
    anomalies.push({
      code: 'UNUSUAL_PERIOD_LENGTH',
      severity: 'warning',
      title: `Billing period is ${periodDays} days (usual ${tariff.cycleDays.min}–${tariff.cycleDays.max})`,
      evidence: [`Period ${b.periodStart} to ${b.periodEnd} is ${periodDays} days.`],
      explanations: [
        'The meter reader visited earlier or later than usual.',
        'A reading was missed and this bill covers more than one cycle.',
        'The connection started or a meter was replaced mid-cycle.',
      ],
      confidence: 'high',
      limitations: 'Slabs are not prorated in this engine, so a longer period can push units into higher-rate slabs. A shorter period can make usage look lower than usual.',
      checks: ['Compare the reading dates printed on this and the previous bill.', 'Ask the utility whether slab limits should be prorated for this period length.'],
    });
  }
  const changes = versionChangesWithin(b.tariffCode, b.periodStart, b.periodEnd);
  const prevVersion = b.history.at(-1)?.tariffVersion;
  if (changes.length > 0 || (prevVersion && prevVersion !== tariff.version)) {
    anomalies.push({
      code: 'TARIFF_VERSION_CHANGE',
      severity: 'info',
      title: `Tariff changed to version ${tariff.version}`,
      evidence: [
        ...changes.map((c) => `Version ${c.version} took effect on ${c.effectiveFrom}, inside this billing period.`),
        ...(prevVersion && prevVersion !== tariff.version ? [`Your previous bill used version ${prevVersion}.`] : []),
      ],
      explanations: ['Rates or fixed charges changed under a new tariff version, so the same usage can cost a different amount.'],
      confidence: 'high',
      limitations: 'This engine applies the version in force on the reading date to the whole period. The utility may instead prorate across the change date.',
      checks: ['Check the tariff order effective date with your utility.', 'Ask whether the bill was prorated across the change.'],
    });
  }

  if (b.previousReading === null || b.currentReading === null) {
    anomalies.push({
      code: 'MISSING_READING',
      severity: 'review',
      title: 'A meter reading is missing',
      evidence: [b.previousReading === null ? 'No previous reading recorded.' : 'No current reading recorded.'],
      explanations: ['The meter was not accessible.', 'The reading was not entered into the system.'],
      confidence: 'high',
      limitations: 'Consumption cannot be calculated without both readings, so no charges are reconstructed.',
      checks: ['Note your meter reading and the date yourself.', 'Ask the utility how the billed units were derived.'],
    });
    steps.push('Consumption cannot be calculated: a reading is missing. Bill needs review.');
    return { status: 'needs_review', periodDays, consumption: null, unit: tariff.unit, tariff: tariffInfo, lineItems: [], totals: null, steps, anomalies };
  }

  const baseline = baselineFrom(b.history);
  const prevMilli = toMilli(b.previousReading);
  const currMilli = toMilli(b.currentReading);

  if (currMilli < prevMilli) {
    const rolloverMilli = toMilli(10 ** b.meter.digits) - prevMilli + currMilli;
    const rolloverUnits = fromMilli(Math.round(rolloverMilli * b.meter.multiplier));
    const expected = baseline ? baseline.dailyUnits * periodDays : null;
    const rolloverPlausible = expected === null ? null : rolloverUnits <= expected * 3;
    anomalies.push({
      code: 'READING_DECREASE',
      severity: 'review',
      title: 'Current reading is lower than the previous reading',
      evidence: [
        `Previous reading ${b.previousReading}, current reading ${b.currentReading}.`,
        `If the ${b.meter.digits}-digit meter rolled over, usage would be ${fmtUnits(rolloverUnits, tariff.unit)}.`,
        ...(expected !== null ? [`Your usual usage for ${periodDays} days is about ${fmtUnits(expected, tariff.unit)}.`] : []),
      ],
      explanations: [
        `Meter rollover past ${'9'.repeat(b.meter.digits)}${rolloverPlausible === false ? ' (unlikely: implied usage is far above your usual usage)' : rolloverPlausible ? ' (consistent with your usual usage)' : ''}.`,
        'The meter was replaced and the new meter started from zero.',
        'A digit was misread or mistyped (transcription error).',
        'The two readings were recorded against the wrong dates.',
      ],
      confidence: 'low',
      limitations: 'Usage is NOT set to zero and the bill is not reconstructed until a person confirms which explanation applies.',
      checks: ['Photograph the meter display with the date.', 'Ask the utility whether the meter was replaced.', 'Raise a reading/meter complaint with this bill reference.'],
    });
    steps.push('Consumption not calculated: current reading is below the previous reading. Bill needs review.');
    return { status: 'needs_review', periodDays, consumption: null, unit: tariff.unit, tariff: tariffInfo, lineItems: [], totals: null, steps, anomalies };
  }

  const milliUnits = Math.round((currMilli - prevMilli) * b.meter.multiplier);
  const units = fromMilli(milliUnits);
  steps.push(`Consumption = (${b.currentReading} − ${b.previousReading}) × multiplier ${b.meter.multiplier} = ${fmtUnits(units, tariff.unit)} (${b.readingType} reading).`);

  const lineItems: LineItem[] = [];
  let energyPaise = 0;
  for (const part of splitIntoSlabs(milliUnits, tariff.slabs)) {
    const amount = chargeForMilliUnits(part.milliUnits, part.ratePaise);
    energyPaise += amount;
    const range = part.to === null ? `above ${part.from}` : `${part.from}–${part.to}`;
    const label = `Slab ${range} ${tariff.unit}`;
    lineItems.push({ kind: 'slab', label, quantity: fromMilli(part.milliUnits), ratePaise: part.ratePaise, amountPaise: amount });
    steps.push(`${label}: ${fmtUnits(fromMilli(part.milliUnits), tariff.unit)} × ${formatINR(part.ratePaise)} = ${formatINR(amount)} (rounded half-up to the paisa).`);
  }
  lineItems.push({ kind: 'fixed', label: 'Fixed charge', amountPaise: tariff.fixedChargePaise });
  steps.push(`Fixed charge = ${formatINR(tariff.fixedChargePaise)}.`);

  let taxPaise = 0;
  for (const tax of tariff.taxes) {
    const base = tax.on === 'energy' ? energyPaise : energyPaise + tariff.fixedChargePaise;
    const amount = percentOf(base, tax.basisPoints);
    taxPaise += amount;
    lineItems.push({ kind: 'tax', label: tax.label, amountPaise: amount });
    steps.push(`${tax.label}: ${tax.basisPoints / 100}% of ${formatINR(base)} = ${formatINR(amount)}.`);
  }
  const currentChargesPaise = energyPaise + tariff.fixedChargePaise + taxPaise;
  steps.push(`Current charges = ${formatINR(energyPaise)} + ${formatINR(tariff.fixedChargePaise)} + ${formatINR(taxPaise)} = ${formatINR(currentChargesPaise)}.`);

  let creditsPaise = 0;
  for (const c of b.credits) {
    creditsPaise += c.amountPaise;
    lineItems.push({ kind: c.kind, label: c.label, amountPaise: -c.amountPaise });
    steps.push(`${c.kind === 'subsidy' ? 'Subsidy' : 'Credit'} "${c.label}": −${formatINR(c.amountPaise)}.`);
  }
  if (b.arrearsPaise > 0) {
    lineItems.push({ kind: 'arrears', label: 'Arrears from previous bills', amountPaise: b.arrearsPaise });
    steps.push(`Arrears: +${formatINR(b.arrearsPaise)}.`);
  }
  let adjustmentsPaise = 0;
  for (const a of b.adjustments) {
    adjustmentsPaise += a.amountPaise;
    lineItems.push({ kind: 'adjustment', label: a.label, amountPaise: a.amountPaise });
    steps.push(`Adjustment "${a.label}": ${a.amountPaise >= 0 ? '+' : '−'}${formatINR(Math.abs(a.amountPaise))}.`);
  }

  const beforeRoundingPaise = currentChargesPaise - creditsPaise + b.arrearsPaise + adjustmentsPaise;
  let payablePaise = 0;
  let roundingPaise = 0;
  let carryForwardCreditPaise = 0;
  if (beforeRoundingPaise <= 0) {
    carryForwardCreditPaise = -beforeRoundingPaise;
    steps.push(`Net amount is ${formatINR(beforeRoundingPaise)}; nothing is payable and ${formatINR(carryForwardCreditPaise)} carries forward as credit.`);
  } else {
    payablePaise = roundToRupee(beforeRoundingPaise);
    roundingPaise = payablePaise - beforeRoundingPaise;
    if (roundingPaise !== 0) lineItems.push({ kind: 'rounding', label: 'Rounding to nearest rupee', amountPaise: roundingPaise });
    steps.push(`Net ${formatINR(beforeRoundingPaise)} rounded half-up to the nearest rupee = ${formatINR(payablePaise)} (adjustment ${formatINR(roundingPaise)}).`);
  }

  // Consumption-based checks.
  const estimatedRun: ParsedBill['history'] = [];
  for (let i = b.history.length - 1; i >= 0 && b.history[i].readingType === 'estimated'; i--) estimatedRun.unshift(b.history[i]);
  if (b.readingType === 'actual' && estimatedRun.length > 0) {
    const estUnits = estimatedRun.reduce((s, h) => s + h.units, 0);
    const estDays = estimatedRun.reduce((s, h) => s + daysBetween(h.periodStart, h.periodEnd), 0);
    const combinedDaily = (estUnits + units) / (estDays + periodDays);
    const ratio = baseline ? combinedDaily / baseline.dailyUnits : null;
    const consistent = ratio !== null && ratio >= 0.8 && ratio <= 1.25;
    anomalies.push({
      code: 'ESTIMATED_CATCHUP',
      severity: 'warning',
      title: 'Possible catch-up after estimated readings',
      evidence: [
        `The previous ${estimatedRun.length} bill(s) used estimated readings totalling ${fmtUnits(estUnits, tariff.unit)} over ${estDays} days.`,
        `This bill uses an actual reading: ${fmtUnits(units, tariff.unit)} over ${periodDays} days.`,
        `Across the estimated and current periods together, average use is ${combinedDaily.toFixed(2)} ${tariff.unit}/day${baseline ? ` against your usual ${baseline.dailyUnits.toFixed(2)} ${tariff.unit}/day` : ''}.`,
      ],
      explanations: [
        consistent
          ? 'Combined usage matches your usual pattern, so this bill most likely includes usage that earlier estimates under-counted.'
          : 'Earlier estimates may have under-counted usage, and actual usage may also have changed.',
      ],
      confidence: consistent ? 'medium' : 'low',
      limitations: 'We only see billed units, not the meter itself. Catch-up billing concentrated in one bill can also push units into higher slabs.',
      checks: [
        'Check the previous bills are marked as estimated.',
        'Ask the utility whether catch-up units can be spread across the estimated periods for slab purposes.',
      ],
    });
  }

  if (baseline) {
    const expected = baseline.dailyUnits * periodDays;
    const currentDaily = units / periodDays;
    if (currentDaily > baseline.dailyUnits * 1.5) {
      const pct = Math.round((currentDaily / baseline.dailyUnits - 1) * 100);
      anomalies.push({
        code: 'CONSUMPTION_INCREASE',
        severity: 'warning',
        title: `Usage is about ${pct}% above your usual daily average`,
        evidence: [
          `This period: ${currentDaily.toFixed(2)} ${tariff.unit}/day. Your baseline from the last ${baseline.periods} actual readings (${baseline.days} days): ${baseline.dailyUnits.toFixed(2)} ${tariff.unit}/day.`,
          `At your usual rate, ${periodDays} days would be about ${fmtUnits(expected, tariff.unit)}; this bill is ${fmtUnits(units, tariff.unit)}.`,
        ],
        explanations: [
          'More people at home, guests, or a change in routine.',
          b.utility === 'electricity' ? 'Seasonal use such as air-conditioning, coolers or water heaters.' : 'Seasonal use such as gardening or extra washing.',
          'A new or faulty appliance.',
          ...(b.utility === 'water' ? ['A leak inside the property (for example a running toilet cistern).'] : []),
          ...(estimatedRun.length > 0 ? ['Catch-up after estimated readings (see above).'] : []),
        ],
        confidence: 'low',
        limitations: 'Higher usage alone does not prove a meter fault, leakage, billing error or misconduct. The baseline is your own history and does not account for changes in occupancy.',
        checks: [
          'Compare your meter display with the current reading on the bill.',
          b.utility === 'water'
            ? 'Close all taps and check whether the meter still moves over 30 minutes.'
            : 'Switch off all loads at the main switch and check whether the meter still advances.',
        ],
      });
    }
    const usualSlab = highestSlabIndex(expected, tariff.slabs);
    const thisSlab = highestSlabIndex(units, tariff.slabs);
    if (thisSlab > usualSlab) {
      const prevLimit = tariff.slabs[thisSlab - 1].upTo as number;
      anomalies.push({
        code: 'SLAB_CROSSING',
        severity: 'info',
        title: `Usage reached a higher-rate slab (${formatINR(tariff.slabs[thisSlab].ratePaise)}/${tariff.unit})`,
        evidence: [
          `${fmtUnits(units, tariff.unit)} is above the ${prevLimit} ${tariff.unit} slab limit.`,
          `Your usual ${periodDays}-day usage of about ${fmtUnits(expected, tariff.unit)} stays within slab ${usualSlab + 1}.`,
        ],
        explanations: ['Under block tariffs, each extra unit above a limit is charged at a higher rate, so the bill grows faster than usage.'],
        confidence: 'high',
        limitations: 'Slab limits are applied per bill without proration in this engine.',
        checks: ['See the slab lines in the reconstruction above.'],
      });
    }
  }

  if (b.statedTotalPaise !== undefined && Math.abs(b.statedTotalPaise - payablePaise) > 100) {
    const diff = b.statedTotalPaise - payablePaise;
    anomalies.push({
      code: 'ARITHMETIC_MISMATCH',
      severity: 'review',
      title: `Printed total differs from reconstruction by ${formatINR(Math.abs(diff))}`,
      evidence: [`Printed total ${formatINR(b.statedTotalPaise)}; reconstructed total ${formatINR(payablePaise)}.`],
      explanations: [
        'A payment, credit or adjustment was posted that this reconstruction does not know about.',
        'A different tariff version or category was applied.',
        'A data-entry or calculation error.',
      ],
      confidence: 'medium',
      limitations: 'The reconstruction uses only the readings, tariff and adjustments recorded here. Differences of up to ₹1 are treated as rounding.',
      checks: ['Compare each line item with the printed bill.', 'Raise a billing complaint with this bill reference if the difference is unexplained.'],
    });
  }

  const status = anomalies.some((a) => a.severity === 'review') ? 'needs_review' : 'ok';
  return {
    status,
    periodDays,
    consumption: units,
    unit: tariff.unit,
    tariff: tariffInfo,
    lineItems,
    totals: {
      energyPaise,
      fixedPaise: tariff.fixedChargePaise,
      taxPaise,
      currentChargesPaise,
      creditsPaise,
      arrearsPaise: b.arrearsPaise,
      adjustmentsPaise,
      beforeRoundingPaise,
      roundingPaise,
      payablePaise,
      carryForwardCreditPaise,
    },
    steps,
    anomalies,
  };
}
