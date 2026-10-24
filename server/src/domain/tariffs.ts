// Versioned tariff configuration.
//
// IMPORTANT: every tariff here is SYNTHETIC. The slab structure mimics the
// shape of Indian domestic tariffs (increasing block rates, fixed charge,
// duty), but the numbers are invented for the demo and are not any state's
// published tariff. To add a real tariff, add a new version with
// `sourceType: 'official_historical'`, the tariff-order URL and the order date.

export type UtilityType = 'electricity' | 'water';

export interface Slab {
  /** Upper bound of the slab in billing units (inclusive). null = no upper bound. */
  upTo: number | null;
  /** Rate in paise per unit (kWh for electricity, kL for water). */
  ratePaise: number;
}

export interface TariffVersion {
  code: string;
  version: string;
  utility: UtilityType;
  jurisdiction: string;
  category: string;
  /** Inclusive ISO date from which this version applies. */
  effectiveFrom: string;
  /** Inclusive ISO date until which this version applies, or null if current. */
  effectiveTo: string | null;
  unit: 'kWh' | 'kL';
  slabs: Slab[];
  /** Fixed charge per bill, in paise. */
  fixedChargePaise: number;
  /** Tax/duty applied to energy/volumetric charges, in basis points (500 = 5%). */
  taxes: { label: string; basisPoints: number; on: 'energy' | 'energy_and_fixed' }[];
  /** Expected billing cycle length in days, used for period-length checks. */
  cycleDays: { min: number; max: number };
  source: { label: string; sourceType: 'synthetic_demo' | 'official_historical'; url: string | null };
}

const SYNTHETIC_SOURCE = {
  label: 'Synthetic demo tariff (not a published tariff order)',
  sourceType: 'synthetic_demo' as const,
  url: null,
};

export const TARIFFS: TariffVersion[] = [
  {
    code: 'SYN-ELEC-DOM',
    version: '2025-26',
    utility: 'electricity',
    jurisdiction: 'Demo State (synthetic)',
    category: 'Domestic LT-1',
    effectiveFrom: '2025-04-01',
    effectiveTo: '2026-08-31',
    unit: 'kWh',
    slabs: [
      { upTo: 100, ratePaise: 300 },
      { upTo: 200, ratePaise: 450 },
      { upTo: 400, ratePaise: 600 },
      { upTo: null, ratePaise: 800 },
    ],
    fixedChargePaise: 5000,
    taxes: [{ label: 'Electricity duty (5% of energy charges)', basisPoints: 500, on: 'energy' }],
    cycleDays: { min: 27, max: 33 },
    source: SYNTHETIC_SOURCE,
  },
  {
    code: 'SYN-ELEC-DOM',
    version: '2026-27',
    utility: 'electricity',
    jurisdiction: 'Demo State (synthetic)',
    category: 'Domestic LT-1',
    effectiveFrom: '2026-09-01',
    effectiveTo: null,
    unit: 'kWh',
    slabs: [
      { upTo: 100, ratePaise: 320 },
      { upTo: 200, ratePaise: 480 },
      { upTo: 400, ratePaise: 650 },
      { upTo: null, ratePaise: 850 },
    ],
    fixedChargePaise: 6000,
    taxes: [{ label: 'Electricity duty (5% of energy charges)', basisPoints: 500, on: 'energy' }],
    cycleDays: { min: 27, max: 33 },
    source: SYNTHETIC_SOURCE,
  },
  {
    code: 'SYN-WATER-DOM',
    version: '2025-26',
    utility: 'water',
    jurisdiction: 'Demo City Water Board (synthetic)',
    category: 'Domestic metered',
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    unit: 'kL',
    slabs: [
      { upTo: 10, ratePaise: 700 },
      { upTo: 20, ratePaise: 1500 },
      { upTo: 30, ratePaise: 2500 },
      { upTo: null, ratePaise: 4000 },
    ],
    fixedChargePaise: 3000,
    taxes: [{ label: 'Sewerage charge (20% of water charges)', basisPoints: 2000, on: 'energy' }],
    cycleDays: { min: 27, max: 33 },
    source: SYNTHETIC_SOURCE,
  },
];

export class TariffNotFoundError extends Error {}

/** The version of `code` in effect on `date` (ISO yyyy-mm-dd). */
export function findTariff(code: string, date: string, tariffs: TariffVersion[] = TARIFFS): TariffVersion {
  const match = tariffs.find(
    (t) => t.code === code && t.effectiveFrom <= date && (t.effectiveTo === null || date <= t.effectiveTo),
  );
  if (!match) throw new TariffNotFoundError(`No ${code} tariff in effect on ${date}`);
  return match;
}

/** Versions of `code` whose start date falls strictly inside (start, end]. */
export function versionChangesWithin(code: string, start: string, end: string, tariffs: TariffVersion[] = TARIFFS) {
  return tariffs.filter((t) => t.code === code && t.effectiveFrom > start && t.effectiveFrom <= end);
}
