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
| `api-contract-2026-08-21.txt` | end of P10A | 488 endpoints. Adds `POST /api/platform/login`. |
| `api-contract-2026-08-24.txt` | P11 hardening | 488 endpoints. All 23 `/api/platform/*` routes gain `requirePlatformDeployment`. **Current check target.** |
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

## The contract diff, 2026-08-21 -> 2026-08-24

No endpoint added, removed or re-pathed. Every one of the 23 `/api/platform/*`
routes gained one leading guard:

```
- POST   /api/platform/login    [authLimiter]
+ POST   /api/platform/login    [requirePlatformDeployment authLimiter]
```

`requirePlatformDeployment` makes the whole platform surface invisible unless
`TENANT_MODE=claim`. api-legacy — the institute-facing deployment on a public
hostname — therefore stops serving organization, plan, subscription and staff
administration. It was serving all of it before, inert only because production
has no platform staff yet; cutover Step 25 would have removed that accident.

Note it lands on `login` too. A gate that closed the authenticated routes and
left the door itself open would be no gate at all, so the contract showing
`requirePlatformDeployment` **before** `authLimiter` on that line is the thing
worth reading here.

Nothing outside `/api/platform` changed — the diff is 46 lines, 23 pairs.

### The parser needed fixing first

`readMounts()` matched exactly two arguments, so
`app.use('/api/platform', requirePlatformDeployment, platformRoutes)` stopped
matching altogether: every platform route fell back to `(unmounted)` and the
first run reported **25 endpoints REMOVED**. A contract tool that reports a
guard addition as a mass deletion is one nobody will trust the next time it
goes red, so mount-level middleware is now parsed and attributed to every route
under the prefix.

## The contract diff, 2026-09-29 → 2026-10-21

Reviewed line by line before re-snapshotting. **No endpoint was removed.**
577 → 619 endpoints.

- **38 altered, all guard additions or re-keying, none a loosening:**
  - `/api/ai/*` (25): gated per route instead of as a router — generation and
    guidance on `requireModule(ai)`, the class question bank on
    `requireModule(questionBank)`; generation routes also carry
    `meter(aiGenerationsMonthly)`. Organizations with `ai` always hold
    `questionBank` (a dependency), so the only access this adds is the
    question bank for plans without AI.
  - `/api/teacher/ai/generate`, `/regenerate`, `/blueprint/approve` (3): now
    `requireModule(ai)` (they had no module gate); the first two are metered.
    History, export, cancel and delete are deliberately not gated.
  - `/api/import-paper/*` (10): `requireModule(questionImport)` — an earlier
    phase.
  - `POST /api/public/brand-preview`: `publicFormLimiter` → `previewLimiter` —
    an earlier phase.
- **42 added:** subscriptions and billing (11: `/api/platform/orgs/:orgId/subscription*`,
  `/payments*`, `/api/platform/subscriptions`, `/api/platform/plans/*`), and
  from earlier uncommitted phases: console MFA and sessions (9), app design
  (11), notification devices (3), parent ward views (2), attendance sync status
  (2), organization-application drafts (2), and the background AI job
  read/discard pair (2).

**Re-snapshotted the same day after S3 (invoices), 619 → 642, 23 additions, no
removals or alterations:** `/api/platform/billing/profile` (GET org.read, PUT
billing.manage); `/api/platform/orgs/:orgId/billing-details` and
`/orgs/:orgId/invoices`; `/api/platform/invoices` and `/invoices/:id`
(GET/PATCH/DELETE), `/issue`, `/void`, `/payments`, `/document` — reads on
`org.read`, every write on `billing.manage`; `/api/platform/subscription-requests`
(GET org.read) and `/:id/resolve` (subscription.manage). Organization side,
behind `authMiddleware` with staff permissions checked in the router:
`/api/org-admin/billing/details` (GET/PUT), `/billing/invoices`,
`/billing/invoices/:id`, `/billing/invoices/:id/document`,
`/subscription/requests` (GET/POST). Nothing records a payment or changes a
plan from the organization side.

**Re-snapshotted again after S4–S7 (admin screens), 642 → 644, 2 additions, no
removals or alterations:** `GET /api/public/plans` (the catalogue the
registration form shows; read-only, rate limited, platform deployment only)
and `GET /api/org-admin/plans` (the same catalogue for an organization admin,
marked with its current plan). Both read; neither changes a plan.

## The contract diff, 2026-10-21 → 2026-10-23 (self-serve subscription)

`api-contract-2026-10-23.txt`, 644 → 655: **11 additions, no removals or
alterations.** All under `/api/org-admin/subscription`, behind
`authMiddleware`, with staff permissions checked in the router (`org.read` for
the GET, `org.settings` for every POST), and the organization taken from the
principal: `GET /subscription` (what the institute may do now), `POST
/subscription/trial`, `/switch-plan`, `/orders`, `/orders/:id/withdraw`,
`/cancel`, `/resume`. They stay open while read-only (the existing
`/api/org-admin/subscription*` allowlist entry). An order creates an invoice;
nothing on this side records a payment — the plan changes when staff settle the
invoice. See core/billing/selfServe.ts and docs/subscriptions-plan.md.

Staff side, the same day (4): `GET /api/platform/orders` (org.read — institute
orders, open by default, `?status=all`, `?orgId=`), `POST /orders/:id/accept`
(billing.manage — issues a draft if needed, then settles it with the payment
staff record, which applies the ordered plan), `POST /orders/:id/apply-plan`
(subscription.manage — the plan before payment; the invoice stays open),
`POST /orders/:id/decline` (billing.manage — reason required, shown to the
institute). Only invoices with `origin: 'self-serve'` are orders; any other id
is a 404.

## The contract diff, 2026-10-23 → 2026-10-24 (recommended plan terms)

`api-contract-2026-10-24.txt`, 655 → 658: **3 additions, no removals or
alterations.** `GET /api/platform/plans/recommended` (org.read — the
recommended catalogue next to each plan's terms and subscribers per version),
`POST /plans/apply-recommended` (plan.manage — a new version of each plan whose
terms differ; nobody is moved), `POST /plans/:key/move-subscribers`
(subscription.manage, reason required — older-version subscribers to the
current version; platform-owned and pre-lifecycle subscriptions skipped unless
`includeUnmanaged`).

### The parser now reads route-level gate keys

A route-level `requireModule('ai')` used to print as a bare `requireModule`, so
changing a module key — the exact change above — was invisible. Keys are read
for `requireModule(...)` and `meterRequest(...)`. Seat limits are checked inside
handlers (core/subscriptions/usage) and do not appear here.

## The contract diff, 2026-10-24 → 2026-10-25 (admissions pipeline)

`api-contract-2026-10-25.txt`, 658 → 677: **19 additions, no removals or
alterations**, all under the new `/api/admissions` mount. Seven are public and
allowlisted in core/tenancy/publicRoutes: `GET /seats`, `POST /enquiry`
(publicFormLimiter), the four `/application/:token` routes (the family's
personal link; admissionApplicationLimiter) and `GET /registration/:registrationId`
(the fee page; admissionLookupLimiter). Twelve are staff routes under
`/admin/*`, each `authMiddleware` + `requireStaffPermission('enquiries.manage')`
(the parser prints the first guard only); creating a student login from
`POST /admin/leads/:leadId/enrol` additionally checks `students.create` inside
the handler. The existing `/api/agts` routes are unchanged.

## Re-checking

```
npm run safety:api-check
```

Re-snapshot only when an addition is intentional, and add a new dated file
rather than editing an existing one:

```
npx ts-node --transpile-only scripts/safety/api-contract-snapshot.ts --out docs/baselines/api-contract-YYYY-MM-DD.txt
```
