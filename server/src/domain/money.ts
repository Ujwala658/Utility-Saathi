// Money is always held as integer paise. These helpers make every rounding
// step explicit so it can be tested on its own.

/** Round a non-negative rational a/b to the nearest integer, halves rounding up. */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    throw new Error('divRoundHalfUp expects integers and a positive denominator');
  }
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  return sign * Math.floor((2 * abs + denominator) / (2 * denominator));
}

/** Amount for `milliUnits` (units × 1000) at `ratePaise` per unit, rounded half-up to the paisa. */
export function chargeForMilliUnits(milliUnits: number, ratePaise: number): number {
  return divRoundHalfUp(milliUnits * ratePaise, 1000);
}

/** basisPoints of amount, rounded half-up to the paisa. */
export function percentOf(amountPaise: number, basisPoints: number): number {
  return divRoundHalfUp(amountPaise * basisPoints, 10000);
}

/** Round to the nearest whole rupee; 50 paise and above round up. */
export function roundToRupee(paise: number): number {
  return divRoundHalfUp(paise, 100) * 100;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

export function formatINR(paise: number): string {
  return inr.format(paise / 100);
}
