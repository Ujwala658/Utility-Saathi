# Utility Saathi

Electricity and water bills, payments, outage reports and complaints in one place, for tenants, property owners and utility administrators in India. It's a hackathon prototype, and **P0 is complete**.

> **Demo build.** Every person, property, account, bill, payment, report and complaint is fictional (`synthetic_demo`). Payments are **SIMULATED — NO MONEY MOVES**. Tariffs are synthetic and are not any state's published tariff. The app has not been endorsed by any utility or government body, and it is not production-certified.

## Quick start

Requires Node 22+.

```bash
npm run setup      # installs root, server and client dependencies
npm start          # builds the client and serves app + API on http://localhost:3001
# or, for development with hot reload:
npm run dev        # API on :3001, web on http://localhost:5173
npm test           # 54 automated tests (Vitest + Supertest)
npm run seed       # reset the SQLite demo database to the synthetic fixtures
```

The database (`server/utility-saathi.db`) is created and seeded on first start. See `.env.example` for the optional settings. No secrets are needed.

### Demo accounts (fictional, password `demo1234`)

| Role | Email | Sees |
|---|---|---|
| Tenant | asha.tenant@demo.utilitysaathi.in | Flat 3B, Lakeview only |
| Tenant | karthik.tenant@demo.utilitysaathi.in | House 7A, Mill Road only |
| Owner | ravi.owner@demo.utilitysaathi.in | Lakeview + Mill Road, manages tenant access |
| Owner | meera.owner@demo.utilitysaathi.in | Riverside only |
| Admin | priya.admin@demo.utilitysaathi.in | Everything, plus Administration |
| Admin | arjun.admin@demo.utilitysaathi.in | Case handler for assignments |

The sign-in page has one-click buttons for each account.

## Hackathon demo script (about 6 minutes)

Before each run, use **Administration → Reset demo data**, or run `npm run seed`. Report times are relative to "now", so live grouping works on every run.

1. **High bill, explained.** Sign in as Asha and open **Bills → SIM-LVEL-20260902** (₹1,924 against a usual ~₹600). It shows:
   - each slab line, the duty, and rounding to the rupee,
   - every calculation step and the tariff version and source,
   - four explained notes: tariff version change on 1 Sep, a possible catch-up after two estimated readings (combined use 6.11 kWh/day against a baseline of 5.08), usage 130% above baseline, and a crossing into the ₹6.50 slab.

   Each note lists evidence, possible explanations, confidence and limitations, and safe checks. None of them claims an error.
2. **Duplicate payment blocked.** Open **SIM-LVEL-20261002**. Its payment is *Bank debit confirmed, utility credit pending*. Click Pay and confirm. The app answers "Second payment blocked" and explains why. The timeline shows each state with its source and timestamp.
3. **Incident grouping.** Go to **Service Reports**. Three Lakeview West reports form INC-00001. A Lakeview East outage (different feeder) and a low-voltage report stay separate. Submit a power outage at T-LV-01A. It joins INC-00001 with the grouping reason, and it stays **UNVERIFIED** no matter how many reports arrive.
4. **Complaint.** From the high bill, click *Raise a billing complaint*. You get an ID like `US-2026-000003`, a progress stepper and a history. It is marked as not sent to the utility (simulated).
5. **Owner isolation.** Sign in as Meera. She sees only the two Riverside bills. Opening a Lakeview bill URL returns "Bill not found". Sign in as Ravi and use **My Properties** to grant or revoke tenant access, with a confirmation before revoking.
6. **Admin.** Sign in as Priya and open **Administration → Alerts**. There are 13 explainable alerts, for example "Needs review: bill SIM-MREL-20261002" (printed total ₹899 against ₹799 reconstructed) and "Potential duplicate transaction blocked". Under **Incidents**, set INC-00001 to *Verified fault*. This needs an evidence source, and an ETA needs its own source. Under **Payments**, record the simulated utility credit for SIMTXN-LV10, which creates a simulated receipt. **Audit log** shows every change.
7. **Usage and data.** **Consumption & Savings** shows billed usage per day, with estimated periods hatched. **Reports & Data** shows the source registry with freshness. The savings calculator is P1 (not built yet).

## Architecture

```
client/  React 18 + TypeScript (Vite), React Router. No UI framework; plain CSS with tokens.
server/  Express 5 + TypeScript (tsx), better-sqlite3, zod validation at every API boundary.
  src/domain/    pure, tested business rules
    billing.ts     bill reconstruction + anomaly rules
    tariffs.ts     versioned synthetic tariff configuration
    money.ts       integer-paise rounding helpers
    payments.ts    payment state machine
    incidents.ts   report-grouping rules
    complaints.ts  complaint lifecycle
  src/services/  persistence + orchestration (bills, payments, incidents, complaints, admin alerts, sources)
  src/db/        schema.sql (reproducible), seed.ts (resettable fixtures)
  src/access.ts  the single place that decides which properties a user may see
  src/auth.ts    scrypt password hashing, hashed bearer-token sessions, role guard, rate limiter
  test/          54 tests
```

Why this stack: it's one language end to end, and there are no external services, so a judge can run it with `npm start`. SQLite (WAL) is enough for a single-node demo. For multi-user deployment, move to PostgreSQL. The partial unique indexes and triggers below port directly.

### Safety rules enforced in the database, not just the UI

- `one_open_payment_per_bill`: a partial unique index allows at most one `initiated|pending|debit_confirmed` transaction per bill. `one_reconciled_payment_per_bill` allows at most one credit per bill.
- `payment_legal_transition`: a trigger checks every state change against the `payment_transitions` table. Identity fields (bill, user, amount, idempotency key, reference) are immutable. New rows must start as `initiated`.
- `UNIQUE (user_id, idempotency_key)`: replaying a key returns the original transaction.
- `payment_events`, `complaint_events` and `audit_log` are append-only. Triggers reject UPDATE and DELETE.
- An incident ETA must come with its source (CHECK constraint).

### Authorization

Every bill, payment and complaint query goes through `access.ts`. Admins see all properties. Owners see the properties they own. Tenants see properties with an active, unrevoked membership. A resource the user can't access returns **404**, so its existence isn't revealed. Admin routes need the `admin` role. Owners alone can grant or revoke access to their properties. Tokens are random 256-bit values. Only their SHA-256 hash is stored, they expire after 8 h, and they are sent as `Authorization: Bearer`. No auth cookies are used, so CSRF does not apply. Login and payment initiation are rate-limited in memory. Account numbers are masked to their last four digits.

### Billing assumptions (explicit and tested)

- Money is held as integer paise. Each line is rounded half-up to the paisa. The payable amount is rounded half-up to the whole rupee, with a visible adjustment line.
- Slabs apply per bill without proration. Unusual period lengths (outside 27–33 days) are flagged instead.
- If a tariff version changes mid-period, the version in force on the reading date applies, and the change is flagged. Many regulators prorate instead; that is a refinement for later.
- A reading decrease is **never** billed as zero. The bill is held as `needs_review` with four hypotheses: rollover (with the implied units and a plausibility check against the baseline), meter replacement, transcription error, and date mismatch.
- The baseline is the user's own last 2–3 actual readings, per day. With fewer than two, there is no baseline comparison.
- Credits larger than the charges carry forward. A bill is never negative.

### Incident grouping rules

A report joins an open incident only if **all** of these match: same utility, same issue family (`power_outage`, `low_voltage`, `water_supply` = interruption/low pressure/irregular, `water_leak`), within 3 h of the incident's latest report, and the same feeder or water zone. When either side has no network ID, the normalised locality must match instead. Report volume only changes the count. Only an admin can change status, and *verified fault / planned maintenance / restoration in progress / service restored* require an evidence source. Public incident views never include reporter identities, and residents do not see other residents' descriptions.

## Data sources

In the app, see **Reports & Data**. The table is `dataset_sources`.

| Source | Type | Status |
|---|---|---|
| [CEA CO2 Baseline Database v20.0](https://cea.nic.in/wp-content/uploads/2021/03/User_Guide_Version_20.0.pdf) | official_historical | Verified 2026-10-24 from the published user guide: FY 2023-24 weighted average **0.727 tCO2/MWh**, published Dec 2024. National annual average only. Manual constant for P1 emissions estimates. |
| [data.gov.in: Pattern of Electricity Consumption (Utilities)](https://www.data.gov.in/catalog/pattern-electricity-consumption-utilities) | official_historical | Verified catalog page. National % shares by sector, dated 2013–14, NDSAP licence. Context only, not used in calculations. |
| SERC tariff order | manual | **Not integrated.** A state must be chosen and its order verified. Until then, tariffs are synthetic. |
| Synthetic tariffs, customers, bills, payments, reports, infrastructure topology | synthetic_demo | Active and resettable |

The build sandbox's network blocked direct access to `cea.nic.in` and `data.gov.in`, so these entries were verified through web search and fetch tools, and nothing is auto-refreshed. Before relying on them, confirm reuse terms and download the files directly.

**Can't be real without provider authorization:** customer bills and meter data, payment initiation and confirmation (gateway and utility settlement), live outage feeds and ETAs, network topology, and filing complaints with the utility. All of these are simulated and labelled.

## Test results

`npm test` gives **4 files, 54 tests, all passing** (last run 2026-10-24). Expected bill amounts were worked out by hand from the tariff tables, and each test's comment shows the arithmetic. None of them come from calling the engine.

| Test-plan item | Covered by |
|---|---|
| 1–10 bills (normal elec/water, catch-up, increase, slab boundary, version change, period length, rollover, mismatch, credits/subsidies/arrears/rounding) | `billing.test.ts` cases 1–10b, plus missing reading, CT multiplier, sub-paisa rounding, top slab, no-baseline, input validation (19 tests) |
| 11–14 payments | `payments.test.ts`: pending blocks duplicate, debit-confirmed stays unresolved, idempotency replay, safe retry after failed/reversed, illegal transitions, DB-level constraints, credential fields not stored |
| 15–18 incidents | `incidents.test.ts`: unrelated not grouped (feeder, type, utility, time window ±1 min, closed), related grouped, 10 reports don't verify, admin-only verified status with evidence and ETA source, no reporter identities |
| 19 tenant isolation | `access.test.ts`: tenant/owner bill isolation, other tenants' complaints, grant/revoke takes effect immediately, cross-owner management blocked, admin-only endpoints, masking |
| 21 complaint lifecycle | `access.test.ts`: full lifecycle, illegal jumps, resolution note required, history, audit entries, append-only |
| 23 provenance | `access.test.ts`: fresh/stale/never-refreshed/not-applicable boundaries, registry labelling |
| Admin alerts | `access.test.ts`: every alert has trigger, rule, limitations, checks and data basis; no "fraud" wording; blocked attempts recorded |
| **20 priority assistance, 22 savings calculator** | **Not built yet (P1)** |

The full demo sequence above was also run end to end in headless Chromium at desktop and 390 px mobile widths. There were no JS errors, and the only failed requests were the expected 409 duplicate block and 404 forbidden bill.

## Known limitations and P1 next steps

- **P1 not built yet:** consumption charts with thresholds, savings calculator, consent-based priority assistance, exportable reports and sustainability summaries, automatic dataset refresh.
- Optional photos on service reports are not implemented, because file storage needs a privacy and retention design.
- Rate limiting and sessions are per process, in memory and SQLite. Use Redis or Postgres for more than one instance. Production would also need HTTPS, secure headers via a reverse proxy, real identity verification, and retention and deletion policies.
- The admin console's payment buttons stand in for gateway and utility callbacks. A real integration would verify signed webhooks.
- The complaint "overdue" threshold (7 days) and the reconciliation warning (2 h) are demo values, not regulatory timelines.
