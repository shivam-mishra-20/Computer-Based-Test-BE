# Baselines

Frozen snapshots of what production looked like at a moment in time, so a change
can be shown to be additive rather than asserted to be.

Old baselines are **kept, not overwritten**. Overwriting one erases the evidence
it existed to provide.

| File | Taken | What it records |
|---|---|---|
| `api-contract-2026-08-17.txt` | before P1 | 486 endpoints, with the auth middleware guarding each. The pre-tenancy reference. |
| `api-contract-2026-08-18.txt` | end of P6 | 487 endpoints. **Current check target.** |
| `db-inventory-2026-08-17.json` | before P1 | Collection names, document counts, index definitions. |
| `legacy-client-surface-2026-08-17.txt` | before P1 | Every endpoint the installed mobile app and the web app actually call. |

## The contract diff, 2026-08-17 → 2026-08-18

One line, an addition:

```
+ GET    /api/org/branding                                           [PUBLIC]
```

Nothing was removed and nothing was altered, which is the property that matters:
the installed Abhigyan app calls a fixed set of endpoints, and a removed or
re-guarded one breaks it in the field with no way to roll the client back.

`[PUBLIC]` is accurate and deliberate. A login page has to be painted in an
institute's colours before the credential that would reveal them is submitted,
so this route is unauthenticated. It returns name, slug, status, branding and
locale — nothing an institute's own login page does not already show anyone who
loads it. It is recorded in `DELIBERATELY_NOT_ALLOWLISTED` with the reasoning,
including why allowlisting it would break rather than protect it.

## Re-checking

```
npm run safety:api-check
```

Re-snapshot only when an addition is intentional, and add a new dated file
rather than editing an existing one:

```
npx ts-node --transpile-only scripts/safety/api-contract-snapshot.ts --out docs/baselines/api-contract-YYYY-MM-DD.txt
```
