# Baselines

Frozen snapshots of what production looked like at a moment in time, so a change
can be shown to be additive rather than asserted to be.

Old baselines are **kept, not overwritten**. Overwriting one erases the evidence
it existed to provide.

| File | Taken | What it records |
|---|---|---|
| `api-contract-2026-08-17.txt` | before P1 | 486 endpoints, with the auth middleware guarding each. The pre-tenancy reference. |
| `api-contract-2026-08-18.txt` | end of P6 | 487 endpoints. Adds `GET /api/org/branding`. |
| `api-contract-2026-08-19.txt` | end of P8 | 487 endpoints. Same routes, 23 routers newly carrying `requireModule(...)`. |
| `api-contract-2026-08-21.txt` | end of P10A | 488 endpoints. Adds `POST /api/platform/login`. **Current check target.** |
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

## The contract diff, 2026-08-18 → 2026-08-19

No endpoint added, removed or re-pathed. 23 routers gained a
`requireModule(<module>)` guard, which is visible in the snapshot because the
guard list is part of each line. The legacy deployment is unaffected: an
organization with no subscription resolves to every module, so the new guard
admits exactly who the old route admitted.

## The contract diff, 2026-08-19 → 2026-08-21

One line, an addition:

```
+ POST   /api/platform/login                                         [authLimiter]
```

Nothing was removed and no other route's guard list changed — which is the
property that matters most for this particular addition, because it is
*unauthenticated by design* and sits on the same router as the rest of
`/api/platform/*`. A login route declared BELOW `router.use(platformAuthMiddleware)`
would require a platform session in order to create one, and the snapshot is
what proves it is declared above: `[authLimiter]` alone, with no
`platformAuthMiddleware`, is the whole assertion.

`authLimiter` is the same rate limiter the tenant login uses. It is the only
protection on the route besides bcrypt, so its presence in the contract is not
incidental detail.

## Re-checking

```
npm run safety:api-check
```

Re-snapshot only when an addition is intentional, and add a new dated file
rather than editing an existing one:

```
npx ts-node --transpile-only scripts/safety/api-contract-snapshot.ts --out docs/baselines/api-contract-YYYY-MM-DD.txt
```
