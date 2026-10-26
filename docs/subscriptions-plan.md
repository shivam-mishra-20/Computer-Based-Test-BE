# Subscriptions

Status (2026-10-23): **self-serve added (uncommitted, undeployed).** An
institute's administrator can now start a free trial, switch plan during the
trial, order (buy / renew / upgrade / downgrade) and cancel at period end from
client-platform-web's new **Subscription & billing** page — see
[Self-serve](#self-serve-the-institutes-own-choices). An order is an invoice;
the plan still changes only when platform staff settle it.

Status (2026-10-21): **slices S1–S7 built, uncommitted, undeployed.** S4–S7
(2026-10-21, later the same day) added the admin screens — the console's
Plans, organization Subscription tab and Billing page; the institute
administrator's Plan & billing tab in client-platform-web; a plan choice on the
public institute application — and notices to an organization's
administrators. How to exercise all of it by hand:
[subscriptions-manual-testing.md](subscriptions-manual-testing.md).
The paragraph below describes S1–S3 as first built.

Status (S1–S3): **slices S1, S2 and S3 built, uncommitted, undeployed.**
The plan catalogue with versioning, the subscription lifecycle, manual payment
confirmation, server-side read-only enforcement, **usage limits** (students,
teachers, administrators, AI generations, app builds), **admin-managed invoices**
(GST-ready fields, financial-year numbering, settlement, printable/PDF document),
organization billing details, subscription requests and a provider-neutral
payment seam exist and are tested on isolated databases. Storage and
exams-per-month are not metered. There is no payment gateway (no provider is
registered and no webhook route exists), and **no console or organization-admin
screens** for any of this yet (S4–S5). None of it ships until
the production-readiness gaps are closed and the tenant-enforcement rollout is
evidenced ([tenant-enforcement-rollout.md](tenant-enforcement-rollout.md)).

## Decisions already made

| Topic | Decision |
| --- | --- |
| Plans | Starter ₹999/month (100 active students) · Growth ₹2,999/month (500) · Professional ₹7,999/month (1,500) · Enterprise custom |
| Trial | 14 days |
| Non-payment | 7-day grace period with full access, then **read-only** (read, export, sign in and renew still work) |
| First 1–3 customers | Payment confirmed manually by platform staff. No payment gateway. |
| What a plan controls | Configurable plans, limits and module entitlements, **enforced server-side** |
| Abhigyan Gurukul | Keeps its access, as a platform-owned organization: never billed, never downgraded |
| Approval vs payment | Organization approval (`Org.status`) stays separate from subscription status |
| Data | Nothing is deleted or disabled because of expiry or a downgrade |

## What exists

| Piece | Where | State |
| --- | --- | --- |
| Lifecycle table, clock, intervals (pure) | `src/core/subscriptions/lifecycle.ts` | **Built** |
| Plan catalogue, versioning, default plans | `src/core/subscriptions/catalogue.ts` | **Built** |
| Subscription service (transitions, payments, sweep, views) | `src/core/subscriptions/service.ts` | **Built** |
| `Plan` (catalogue head) | `src/models/Plan.ts` | + `isActive`, `selfServe`, `customPricing`, `trialDays`, `currentVersion` |
| `PlanVersion` (immutable terms) | `src/models/PlanVersion.ts` | **New** |
| `Subscription` | `src/models/Subscription.ts` | + `planKey`/`planVersion`, `billingInterval`, `resumeStatus`, `cancelledAt`, `expiredAt`, `revision`; status `expired` |
| `SubscriptionEvent` (append-only history) | `src/models/SubscriptionEvent.ts` | **New** |
| `Payment` (provider-neutral, idempotent) | `src/models/Payment.ts` | **New** — manual only |
| `Org.subscriptionRequired` | `src/models/Org.ts` | **New** — set by `createOrganization` |
| `Entitlement.nextTransitionAt`, `limitsEnforced` | `src/models/Entitlement.ts` | **New** |
| `Subscription.managedSince` | `src/models/Subscription.ts` | **New** (S2) — only a managed subscription is enforced; see below |
| Usage gate: counting rules, lease, seats, builds, AI ledger | `src/core/subscriptions/usage.ts` | **Built** (S2) |
| `UsageLock` (per-organization lease) | `src/models/UsageLock.ts` | **New** (S2) — a mutex, holds no usage |
| Module gating | `MODULE_GATED_ROUTES` in `app.ts`, `moduleRefusal` | Enforced (unchanged) |
| Subscription read-only | `subscriptionWriteRefusal` in `requireModule.ts`, called from `authMiddleware` | **Enforced** (`423 SUBSCRIPTION_READ_ONLY`) |
| Daily sweep | `src/services/SubscriptionLifecycleCron.ts` | Built; platform runtime, behind `PLATFORM_ENABLE_CRON` |
| Limits | `LIMIT_KEYS` in `catalogue.ts` | students, teachers, admins, AI generations, app builds **enforced**; storage, exams per month **not** |
| `UsageRecord` | `src/models/UsageRecord.ts` | The AI-generation ledger (reservation / refund) |
| GST arithmetic, GSTIN check, financial year, numbering (pure) | `src/core/billing/gst.ts` | **Built** (S3) |
| Invoices, billing profile, org billing details, document | `src/core/billing/invoices.ts`, `document.ts` | **Built** (S3) |
| Subscription requests | `src/core/billing/requests.ts` | **Built** (S3) |
| Payment-provider seam (registry, verified events, reconciliation) | `src/core/billing/provider.ts` | **Built** (S3) — only `manual` registered; no webhook route |
| `Invoice`, `InvoiceCounter`, `BillingProfile`, `SubscriptionRequest`, `ProviderEvent` | `src/models/` | **New** (S3) |
| `Payment.invoiceId`, `Org.billing` | `src/models/Payment.ts`, `src/models/Org.ts` | **New** (S3) |
| Console screens | platform-console `src/app/plans`, `src/app/billing`, `src/app/organizations/[id]/subscription.tsx`, `src/components/billing.tsx` | **Built** (S4) |
| Org-admin Plan & billing tab | client-platform-web `src/components/admin/organization/PlanTab.tsx`, `src/lib/orgAdmin.ts` | **Built** (S5) |
| Public catalogue, plan choice at registration | `GET /api/public/plans`, `listPublicPlans` in `catalogue.ts`, `planForApproval` in `registrations.ts`; abhigyan-gurukul-main `InstituteOnboarding.jsx` | **Built** (S6) |
| Notices to an organization's admins | `src/core/billing/notices.ts`; `remindTrialsEnding` in `service.ts`, `Subscription.trialReminderFor` | **Built** (S7) |
| Dashboard billing counts | `GET /api/platform/dashboard` → `summary.billing` | **Built** (S4) |

## Lifecycle

Statuses: `trialing`, `active`, `past_due` (grace), `suspended`, `cancelled`,
`expired`. (`terminated` is a legacy value kept so old records validate; no
transition leads to it.)

| Event | Who | From | To |
| --- | --- | --- | --- |
| `start_trial` | staff (reason) | none, `expired`, `cancelled` | `trialing` (14 days, or the plan's) |
| `extend_trial` | staff (reason) | `trialing`, `past_due` | `trialing`, from the later of now and the current end |
| `activate` | staff (reason) | `trialing`, `past_due`, `expired`, `cancelled` | `active` for one interval (or an explicit / open-ended period) |
| `payment_confirmed` | staff records a payment | none (only with a plan — a settled self-serve order), `trialing`, `active`, `past_due`, `expired`, `cancelled`, `suspended` | `active`; period starts where current access ends. From `suspended`: stays suspended, period extended, resumes `active`. Clears `cancelAtPeriodEnd` |
| `payment_failed` | staff | `active` (`past_due`: no change) | `past_due`, grace = now + 7 days |
| `trial_ended` | clock | `trialing`, at `trialEndsAt` | `past_due`, grace = trial end + 7 days — or `cancelled` (no grace) when `cancelAtPeriodEnd` |
| `period_ended` | clock | `active`, at `periodEnd` | `past_due`, grace = period end + 7 days — or `cancelled` (no grace) when `cancelAtPeriodEnd` |
| `grace_ended` | clock | `past_due`, at `graceEndsAt` | `expired` |
| `suspend` | staff (reason) | `trialing`, `active`, `past_due`, `expired` | `suspended` (remembers what to resume to) |
| `reactivate` | staff (reason) | `suspended`, `cancelled` | the remembered status, then the clock catches up |
| `cancel` | staff (reason) | `trialing`, `active`, `past_due`, `suspended`, `expired` | `cancelled` |
| `expire` | staff (reason) | `trialing`, `active`, `past_due`, `cancelled` | `expired` |

- **The table is the only way to change status.** `PUT /orgs/:orgId/subscription`
  with a `status` is translated into the event it means and validated like any
  other; `past_due` cannot be set by hand.
- **Atomic.** Every write is conditional on the subscription's `revision`; two
  simultaneous staff actions, or a staff action and the clock, cannot both
  apply. The losing request gets `409`.
- **The clock does not depend on cron.** The entitlement snapshot stores
  `nextTransitionAt`; any request after that moment advances the subscription
  first. The daily sweep (00:15 IST) makes the same change for organizations
  nobody is using. Both are idempotent.
- **Platform-owned** (`Org.isPlatformOwned` or `Subscription.isPlatformOwned`):
  every module, never advanced by the clock, and every lifecycle action and
  payment is refused with `409 PLATFORM_OWNED`. Clearing the flag is an explicit,
  audited edit.
- **Approval is separate.** `Org.status` (approval / administrative suspension)
  and `Subscription.status` (commercial) are independent; both must permit a
  write.
- **History.** Every change is a `SubscriptionEvent` (who, why, before/after);
  staff actions are also in `PlatformAudit`.

### Access by status

| Status | Read & export | Write |
| --- | --- | --- |
| `trialing`, `active`, `past_due` | yes | yes |
| `suspended`, `cancelled`, `expired` | yes | **no** — `423 SUBSCRIPTION_READ_ONLY` |

This applies to **managed** subscriptions only — see the next section.

Writes that stay open while read-only (`RESTRICTED_WRITE_ALLOWED`): in-progress
exam attempts (`/api/attempts/*`), `POST /api/auth/change-password`,
`POST /api/auth/logout-all`, `/api/org-admin/subscription*` and
`/api/org-admin/billing*` (reserved for renewal requests, S5), and the POST
exports (`/api/papers/temp/export/{pdf,doc}`, AI export-pdf, material download).
Sign-in and token refresh are unauthenticated routes and are never gated.

## Managed subscriptions — existing organizations keep their access

Only a subscription the lifecycle **manages** (`Subscription.managedSince`) has
its status enforced (read-only), its limits enforced, and its dates advanced by
the clock. Every lifecycle write sets it: a trial, an activation, a payment, a
plan assignment, any staff decision.

A subscription written **before** the lifecycle (by the old editor, a seed or a
script) has no `managedSince`. Before S1 its `writable: false` was computed but
enforced nowhere and its limits were display-only, so it keeps exactly that: it
stays writable whatever its status, its limits are shown (`enforced: false`)
but not applied, and neither the sweep nor a request moves its dates — even a
trial end in the past. Module gating, which predates the lifecycle, still
applies. **Deploying S1/S2 therefore changes nothing for an existing
subscription.**

Staff start enforcing one deliberately: `POST /orgs/:orgId/subscription/manage`
(reason required, audited), or any lifecycle action. The response carries the
resulting entitlement and usage — read them, because a subscription that was
quietly "suspended" becomes read-only at that moment.

## What "no subscription" means

| Organization | Entitlement |
| --- | --- |
| Platform-owned | every module, writable (ADR-12) |
| Created by the platform from now on (`subscriptionRequired: true`, set in the same insert as the org) | **core modules only** (`unassigned`) until a trial or payment grants more |
| Created before subscriptions (no marker) | every module, as before — until decision 3 below |

So a failure between creating an organization and creating its subscription
leaves it with less, never with everything, and re-running onboarding or
approval completes it (`onboardOrganization` step 7 is idempotent; the unique
`orgId` index prevents a second subscription; a retry never restarts the clock).

## Self-serve: the institute's own choices

`src/core/billing/selfServe.ts`, routes under `/api/org-admin/subscription`
(org.read to read, org.settings to act; the organization is the principal's).
What moves no money happens at once; what moves money is an **order**.

| Action | When it is offered | What happens |
| --- | --- | --- |
| Start a free trial | no subscription, never had a trial, self-serve plan with `trialDays` | `start_trial` on that plan, now. Once per institute (`hasHadTrial`) |
| Switch plan | `trialing` (managed), self-serve plan | `assignPlan` now; the trial end does not move; nothing is charged |
| Order (buy / renew / upgrade / downgrade) | not suspended, no other open order, plan on sale with a price for the interval | `createOrderInvoice` — `origin: 'self-serve'`, the plan's price for the period from where current access ends (or now), plus the setup fee on a first (`new`) order. **Nothing else changes** |
| Withdraw an order | unpaid | draft → deleted; issued → voided ("Withdrawn by the institute") |
| Cancel | `trialing` / `active` with an end date | `cancelAtPeriodEnd` — runs to the end, then the clock cancels (no grace). Withdrawn by **Keep** (`/resume`); cleared by any renewal |
| Cancel | `past_due` | `cancel` now. Any open order is withdrawn with it |

- **Paying applies the order.** `settleInvoice` passes the invoice's
  `planKey`/`planVersion` to `recordManualPayment` only for `origin:
  'self-serve'` invoices, so the plan changes in the same write as the period.
  Staff-drafted invoices never change the plan. With no subscription, the
  settled order creates it (`payment_confirmed` from none — only with a plan).
  A plan taken off sale after the order still applies (`allowInactivePlan`).
- **Issued at once, or reviewed first.** The order's invoice is issued
  immediately when the billing profile has a legal name **and** payment
  instructions (`canAutoIssue`); otherwise it stays a draft for staff to issue
  from the console's Billing page (the institute sees "invoice on its way").
  When GST is configured, an order needs the institute's billing state first
  (`400 BILLING_DETAILS_REQUIRED`).
- **Upgrades and downgrades are not prorated.** The new plan applies when the
  payment is confirmed; the paid period starts where the current one ends, so
  no days are lost (an upgrade is effectively free until then).
- **Custom-priced plans** are never ordered or trialled (`409 CUSTOM_PRICING`);
  the page sends a request (quote) instead.
- History: `order_placed`, `order_withdrawn`, `cancellation_scheduled`,
  `cancellation_withdrawn` (actor `tenant`), with notices to the admins.
  The console shows self-serve invoices as "Institute order" and a scheduled
  cancellation (who, when, why) on the organization's Subscription tab.
- **Staff act on orders** in the console — Billing → **Institute orders**
  (also counted on the dashboard) and at the top of the organization's
  Subscription tab ("Orders from the institute"):
  - **Record payment & apply** (`POST /api/platform/orders/:id/accept`,
    billing.manage): a draft is issued first, then settled with the payment —
    the plan is applied and the period extended. The payment is validated
    before anything is issued, so a refused payment leaves the order as it was.
  - **Apply plan now** (`/apply-plan`, subscription.manage): the plan before
    the money, for an agreed exception; the invoice stays open (`planApplied`).
    Needs an existing subscription; with none, recording the payment starts it.
    On a pre-lifecycle subscription this brings it under management.
  - **Decline** (`/decline`, billing.manage, reason required): a draft is
    deleted, an issued invoice voided; the institute sees the reason
    (`lastDecline`) until it orders again.
  - History: `order_applied`, `order_declined` (actor `platform`), with notices.
- Errors: `409 TRIAL_UNAVAILABLE` / `TRIAL_USED` / `TRIAL_NOT_OFFERED`,
  `NOT_IN_TRIAL`, `NOT_SELF_SERVE`, `ORDER_OPEN` (+ `order`),
  `SUBSCRIPTION_ON_HOLD`, `CANCEL_NOT_SCHEDULABLE`, `SUBSCRIPTION_UNMANAGED`,
  `PRICE_REQUIRED`, `CUSTOM_PRICING`; `404 ORDER_NOT_FOUND` (also another
  organization's invoice, or a staff-drafted one).

Test: `scripts/safety/self-serve-subscription.e2e.test.ts` (loopback
`iso_*_scratch_selfserve`; 70 checks, warn and enforce — including the staff
side and support being read-only).

## Plan catalogue

A plan's **terms** — modules, limits, price (monthly, annual, setup fee),
custom pricing, trial length — live in immutable `PlanVersion`s. Editing terms
writes version n+1 and moves `Plan.currentVersion`; existing subscriptions stay
pinned (`planKey` + `planVersion`) until staff move them
(`POST /orgs/:orgId/subscription/plan`). Name, description, order, `isPublic`,
`isActive` and `selfServe` are presentation and change in place. A plan created
before versioning gets version 1 (and its subscribers are pinned to it) the
first time it is edited. Taking a plan off sale (`isActive: false`) stops new
assignments; existing subscribers keep it. Custom-priced plans are never
self-served.

Limit keys are a closed list (`LIMIT_KEYS`): `students` (active students),
`teachers`, `admins`, `aiGenerationsMonthly`, `appBuildsMonthly` — **enforced**
(next section) — and `storageGb`, `examsMonthly` — recorded, **not enforced**.
`-1` = unlimited; absent = not limited; `0` = none allowed.

### Default catalogue — recommended terms (2026-10-24)

`POST /api/platform/plans/seed-defaults` creates whichever of these plans do not
exist yet and never overwrites one. Since 2026-10-24 every **enforced** limit is
set (before, only active students were, so everything else read "no limit").
Existing plans adopt these terms from the console — Plans → **Recommended
terms** (`POST /plans/apply-recommended`): each plan that differs gets a new
version; subscribers stay on theirs until staff use **Move N to vX**
(`POST /plans/:key/move-subscribers`). Prices and student limits are the agreed
ones; the other limits, yearly prices and the module split are recommendations
for review. Only modules a real feature backs are used.

| Module | Starter | Growth | Professional | Enterprise | Server-side gate |
| --- | --- | --- | --- | --- | --- |
| Students, Teachers, Classes, Subjects | ✓ | ✓ | ✓ | ✓ | not route-gated (`/api/users` is core) |
| Exams | ✓ | ✓ | ✓ | ✓ | not route-gated (`/api/exams` mixes three modules) |
| Question Bank | ✓ | ✓ | ✓ | ✓ | `/api/ai/questions/class/*`, `/api/ai/save-questions` (per route, S2) |
| CBT player | ✓ | ✓ | ✓ | ✓ | `/api/attempts`, `/api/practice-tests` |
| Results | ✓ | ✓ | ✓ | ✓ | `/api/results` |
| Homework, Materials, Scheduling, Doubts | ✓ | ✓ | ✓ | ✓ | their routes |
| Offline Tests, Evaluation, Rankings, Analytics, Courses, Question Import | — | ✓ | ✓ | ✓ | their routes |
| AI Generation | — | — | ✓ | ✓ | `/api/ai` generation routes and `/api/teacher/ai/generate`, `/regenerate`, `/blueprint/approve` (per route, S2) |
| Active students | 100 | 500 | 1,500 | 5,000 base, raised per contract (`overrides.limits`) | **enforced** |
| Teachers | 10 | 40 | 120 | unlimited | **enforced** |
| Administrators | 2 | 5 | 15 | unlimited | **enforced** |
| AI generations / month | 0 — not included | 0 — not included | 500 | 2,000 | **enforced** |
| App builds / month | 1 | 2 | 4 | 10 | **enforced** |
| Price / month | ₹999 | ₹2,999 | ₹7,999 | custom | — |
| Price / year | ₹9,990 | ₹29,990 | ₹79,990 | custom | ten months — two free |

Storage and exams per month stay unset: neither is measured (see "Not metered").

Left out on purpose:
- `whiteLabel`, `customDomain`, `apiAccess`, `advancedAnalytics`, `aiAnalysis`:
  registry entries no code checks. (White-label app **builds** do exist, but are
  started by platform staff and gated by nothing commercial except the
  builds-per-month limit; whether they should also require `whiteLabel` is an
  open decision.)
- `integrations`: its only route is Abhigyan's own Firestore bridge, restricted
  to the legacy data owner.
- `attendance` (**removed in S2**): every way to *record* attendance — upload,
  biometric sync, auto-sync — is restricted to the legacy data owner, so for any
  other organization the module would be read screens over empty data.

Corrected in S2, verified against the routes:
- `/api/ai` was gated as a whole on `ai`, but also serves the class question
  bank — Starter and Growth (which sell `questionBank`, not `ai`) were refused
  their own question bank. It is now gated per route. Every organization with
  `ai` already has `questionBank` (a dependency), so this only adds access.
- The teacher AI content generator (`/api/teacher/ai/*`) had **no** module gate:
  any organization could generate. Starting a generation now needs `ai`;
  reading, exporting, cancelling or deleting existing generated content does
  not, so a downgrade never takes away what was already made.

## Usage and limits (S2)

### What counts — the canonical rules

| Limit | Counted from | What counts | What does not |
| --- | --- | --- | --- |
| `students` | `users`, counted live | `role: student`, `status: approved`, not `PUBLIC_LEARNER`, in the organization — including an invited student who has not set a password | pending, rejected, deleted; public learners; parents |
| `teachers` | `users`, counted live | `role: teacher`, `status: approved` | pending, rejected, deleted |
| `admins` | `users`, counted live | `role: admin`, `status: approved` | as above |
| `appBuildsMonthly` | `appbuildjobs`, counted live | builds queued this calendar month (IST) that are live, completed, or reached EAS (`easBuildId`) | cancelled or failed before EAS saw them; earlier months |
| `aiGenerationsMonthly` | `UsageRecord` ledger | each accepted generation request this calendar month (IST) | requests answered ≥ 400, async jobs that fail or are cancelled (refunded), re-renders that call no model |

Seats and builds are counted from the records themselves — there is no
counter to drift — so deleting, rejecting, re-approving or moving a user between
organizations is reflected the moment it happens. AI has no single record every
path shares (sync routes leave none; jobs live in two collections), so it uses
the ledger: a `reservation` (+1) per accepted request and one `refund` (−1) per
failed one, with a unique index guaranteeing a reservation is refunded at most
once.

There is **no branch model** (rooms and policy carry a `branchId`, but no
`Branch` collection exists), so there is no branch limit.

### Where it is enforced

| Resource | Endpoint / operation | Behaviour at the limit |
| --- | --- | --- |
| students, teachers, admins | `POST /api/users` (create) | `402 PLAN_LIMIT_REACHED` |
| | `PUT /api/users/:id/approve` (pending or rejected → approved) | 402; approving someone already approved is not a second seat |
| | `PUT /api/users/:id` when a role change moves an approved user into another pool | 402; any other edit consumes nothing |
| | `POST /api/org-admin/invitations` | 402 |
| students | `POST /api/auth/register` under an **open** policy | the account is created **pending** instead (no refusal, no numbers to an anonymous caller); approving it is then limit-checked |
| appBuildsMonthly | `startBuild` (console "Start build", "Activate and build") | 402; returning an already-live build consumes nothing |
| aiGenerationsMonthly | `/api/ai` generate, ai-generate, refine, solve, solve-batch, evaluate; `/api/teacher/ai/generate`, `/regenerate` | 402, before the model is called |

Not limited, deliberately: the first administrator created by onboarding
(platform), Abhigyan's Firestore teacher sync (legacy data owner only), parents,
public learners. Who is limited at all: only a **managed** subscription
(`entitlement.limitsEnforced`). Platform-owned organizations, organizations
without a subscription, and pre-lifecycle subscriptions are not.

### Concurrency and idempotency

- **Count, then write, under a lease.** `withCapacity` / `reserveMetered` take a
  per-(organization, resource) lease (`UsageLock`, unique index; 20 s lease,
  10 s wait, both env-overridable), count, and only then write. Six requests for
  the last seat produce one seat. A lease that cannot be had answers
  `503 USAGE_CHECK_BUSY` and writes nothing; an abandoned lease expires.
- **Retries and duplicates.** A request for something that already holds its
  seat (approving an approved user, a re-sent request) is not counted again.
  Unique email/empCode already stop a duplicate account. A failed write leaves
  no record, so it consumed nothing. A retried app build returns the live build.
  Two AI requests are two generations (each runs the model); a failed one is
  refunded.
- **Async AI jobs.** The reservation is linked to its job (`subject`) before the
  response; every terminal failure path (job failure, interruption, liveness
  sweep, the PPT worker's final failure, cancellation) refunds it, and linking
  re-checks the job, so a job that failed before it was linked is refunded too.
- **Resolution failure is not a lockout.** As with module gating, if the
  entitlement cannot be resolved the operation proceeds (logged).

### Over the limit (after a downgrade)

Nothing is deleted, disabled or hidden. Existing students keep signing in and
using the app; everything stays readable and exportable; existing records can
be edited and removed. Only **new** consumption is refused, until usage is
under the limit or the limit is raised. Usage views report `over: true`.

### Seeing usage

- Organization admins: `GET /api/org-admin/plan` → `usage.resources` (used,
  limit, enforced, over, per limit key; `used: null` for unmetered keys).
- Console: `GET /api/platform/orgs/:orgId/subscription` → `usage`.
- Every refusal is written to the organization's audit log
  (`plan.limit.refused`).

### Not metered

| Resource | Why | What it would take |
| --- | --- | --- |
| `storageGb` | No per-organization byte record exists; `/upload-url` lets clients upload straight to the bucket, so the server never sees the size. | A per-prefix size scan into `UsageRecord` (daily), size-capped signed URLs, and a decision on soft vs hard enforcement. |
| `examsMonthly` | No plan sets it; the limit is undecided. | A count of exams created per month at exam creation — straightforward once decided. |
| Smart Import AI extraction, schedule-image extraction | They call AI but belong to `questionImport` / `scheduling`, not `ai`. | A decision on whether they count as AI generations. |
| Branches | No branch model exists. | — |

## Payments (manual, provider-neutral)

- `POST /api/platform/orgs/:orgId/payments` — staff with `billing.manage`
  record a confirmed payment (amount, method, reference, received date,
  optional covered period). It is applied as `payment_confirmed`.
- **Idempotent** on (provider, organization, reference): a retry, a double
  click or two staff members produce one `Payment` and one period extension.
  Concurrent submissions are serialized by a short apply claim, and a crash
  between "extended" and "marked applied" cannot extend twice (the history is
  checked first). Same reference, different amount → `409 PAYMENT_DUPLICATE`.
- `POST /api/platform/orgs/:orgId/payments/failed` — a bounced cheque or
  reversed transfer. An `active` subscription enters grace; during a trial it is
  only recorded.
- Amounts are integer paise (`amountMinor`). No amount is checked against the
  plan price: staff may record discounts or part-payments.
- There is **no tenant route** that records or confirms a payment, and no flag
  a client can send that marks anything paid.
- Organization deletion **retains** `payments`, `invoices` and `providerevents`
  (with `platformaudits`).

## Invoices (S3)

Admin-managed: platform staff (`billing.manage`) draft, issue and void
invoices, and record the payment that settles one.

```
draft ──issue──▶ issued ──settled in full──▶ paid
  └─delete         └──void (unpaid, with a reason)
```

- **Drafts** have no number and can be edited or deleted. `{ fromSubscription:
  true }` bills the subscription's pinned plan price for the next period — from
  where current access ends (trial end or period end), one billing interval
  long. Custom-priced plans and one-off items are entered as lines.
- **Issuing** takes the next number in the Indian financial year
  (`INV/26-27/0001`; prefix ≤ 5 characters, never more than 16 in total),
  freezes lines and totals, and copies the seller (billing profile) and buyer
  (`Org.billing`) onto the invoice — later edits of either never rewrite an
  issued invoice. Numbers come from an atomic per-year counter. A draft is
  claimed before a number is taken, so two simultaneous issues of one draft use
  one number, and an issue refused for missing details takes none. A voided
  number is never reused.
- **Settling** records one payment for the **full balance** through the same
  idempotent path as any manual payment (`Payment.invoiceId`, unique among
  confirmed payments) and marks the invoice paid; the subscription is extended
  to the invoice's period. The same reference again is the same payment; a
  different payment for a paid invoice is `409 INVOICE_ALREADY_PAID`; three
  simultaneous settlements produce one. Partial payments are refused
  (`400 PAYMENT_AMOUNT_MISMATCH`, with the amount due).
- **Voiding** is for unpaid issued invoices only, with a reason. A paid invoice
  cannot be voided: refunds and credit notes are not supported yet.
- **Overdue** is derived (issued and past `dueAt`), listed by
  `GET /api/platform/invoices?overdue=true`. Payment terms come from the
  profile (7 days unless set — a default, not a decision).
- **The document** (`/document`, HTML by default, `?format=pdf`) is
  self-contained, escapes every value, and is served with
  `Content-Security-Policy: default-src 'none'`. The PDF goes through the shared
  locked renderer, and a host without Chromium answers `503 PDF_UNAVAILABLE`.

### GST — fields and arithmetic, not a compliance claim

- The **seller** is the platform's billing profile
  (`/api/platform/billing/profile`): legal name, address, state code, GSTIN,
  PAN, GST rate, SAC code, whether plan prices include GST, invoice prefix,
  payment terms and instructions. **It is empty by default**; nothing is
  defaulted to a real-looking value.
- **No GSTIN or no rate → no GST**: `tax.regime: 'none'`, titled "Invoice", and
  the document says "This is not a GST tax invoice". With both, it is titled
  "Tax invoice": CGST + SGST (half the rate each) when the buyer's state is the
  seller's, IGST otherwise; place of supply is the buyer's state; each component
  is rounded to the paisa, half up; prices are treated as exclusive unless the
  profile says they include GST, in which case the tax is carved out of them.
- GST needs both states: an organization without a billing state cannot be
  issued a GST invoice (`400 BILLING_DETAILS_REQUIRED`).
- GSTINs are checked for **form only** — shape, state code, check character, that
  the GSTIN contains the PAN and matches the state — never for registration.
- The **buyer** is `Org.billing`, editable by the organization's own admins
  (`/api/org-admin/billing/details`) and by staff. A GSTIN fills in its state.

**Needs review before any invoice is sent to a customer:** the legal entity,
GSTIN, rate and SAC code; whether plan prices include GST; the invoice format
(mandatory fields, signature, reverse-charge wording, HSN/SAC summary,
e-invoicing thresholds); and the payment terms. Nothing in the code claims GST
compliance.

### Subscription requests

Organization admins ask to renew, upgrade, downgrade or cancel
(`POST /api/org-admin/subscription/requests`), one open request per kind
(asking again returns it). A request changes **nothing**: staff act through the
lifecycle endpoints, then close it (`/api/platform/subscription-requests/:id/resolve`,
resolved or declined, with a note). Organization deletion deletes requests.

### Billing while read-only

`/api/org-admin/billing*` and `/api/org-admin/subscription*` are on the
read-only allowlist: a suspended or expired organization can still read its
invoices, update its billing details and ask to renew.

### The payment-provider seam (S3)

`src/core/billing/provider.ts`. Only `manual` is registered (no webhooks). A
gateway is added by registering a provider whose `verify()` checks the
webhook's signature over the raw body and returns a verified event; everything
after that is shared:

1. **Signature** — refused (`SIGNATURE_INVALID`) before anything is written.
2. **Replay window** — an event more than `BILLING_WEBHOOK_TOLERANCE_MS`
   (5 minutes) from now is refused (`EVENT_STALE`).
3. **Store once** — `ProviderEvent` (provider, eventId) is unique; a redelivery
   is a no-op, and a redelivery of a `failed` event is retried once, under a
   claim.
4. **Settle** — `payment.succeeded` settles the named invoice through
   `settleInvoice` (the same checks as staff: full amount, not void,
   idempotent); `payment.failed` goes through `recordPaymentFailure`. A wrong
   amount is recorded as `rejected` and nothing is paid.
5. **Reconcile** — `reconcileProvider` compares the provider's settlement rows
   with recorded payments and reports matches, mismatched amounts and payments
   missing on either side. It fixes nothing.

**Not built, deliberately:** a webhook route (it needs the raw body, mounted
before the JSON parser, and a chosen provider), checkout or payment links, and
provider credentials. Choosing a provider is a business decision (below).

## API

All under `/api/platform` (platform token; tenant tokens are refused by
audience). Every mutation is recorded in `PlatformAudit` and, for
subscriptions, in `SubscriptionEvent`.

| Method & path | Capability | Body |
| --- | --- | --- |
| `GET /orgs/:orgId/subscription` | `org.read` | — detail, terms, history, payments, available events, entitlement, `usage`, `managed` |
| `POST /orgs/:orgId/subscription/manage` | `subscription.manage` | `reason` — bring a pre-lifecycle subscription under enforcement, as it stands |
| `POST /orgs/:orgId/subscription/trial` | `subscription.manage` | `reason`, `days?`, `planKey?`, `planVersion?`, `billingInterval?` |
| `POST /orgs/:orgId/subscription/plan` | `subscription.manage` | `planKey`, `planVersion?`, `billingInterval?`, `reason?` |
| `POST /orgs/:orgId/subscription/transition` | `subscription.manage` | `event` (activate·suspend·reactivate·cancel·expire), `reason`, `periodEnd?` |
| `PUT /orgs/:orgId/subscription` | `subscription.manage` | modules / overrides / platform-owned; `status` is applied as its event |
| `POST /orgs/:orgId/payments` | `billing.manage` | `amount`, `method`, `reference`, `receivedAt?`, `periodEnd?`, `billingInterval?`, `notes?` |
| `POST /orgs/:orgId/payments/failed` | `billing.manage` | `reference`, `reason`, `method?`, `amount?` |
| `GET /subscriptions?status=&dueWithinDays=&withUsage=true&overLimit=true` | `org.read` | — trials ending, renewals and grace ends within N days; `withUsage` adds `usage` and `overLimits` per row; `overLimit` keeps only organizations over a limit |
| `GET /dashboard` | `org.read` | — now also `summary.billing`: `overdueInvoices`, `openInvoices`, `openRequests`, `dueWithinWeek` |
| `GET /plans` | `org.read` | — plans, subscribers per version, `limitKeys` |
| `GET /plans/:key/versions` | `org.read` | — |
| `PUT /plans` | `plan.manage` | plan; a terms change writes a version |
| `POST /plans/:key/active` | `plan.manage` | `active: boolean` |
| `POST /plans/seed-defaults` | `plan.manage` | — |
| `GET /billing/profile` | `org.read` | — seller profile, GST readiness (what is missing), state codes, providers |
| `PUT /billing/profile` | `billing.manage` | legal name, address, `stateCode`, `gstin`, `pan`, `gstRatePercent`, `sacCode`, `planPricesIncludeGst`, `invoicePrefix`, `paymentTermsDays`, contact, `paymentInstructions` |
| `GET` / `PUT /orgs/:orgId/billing-details` | `org.read` / `billing.manage` | the buyer: `legalName`, `gstin`, `address`, `city`, `pincode`, `stateCode`, `email`, `phone` |
| `GET` / `POST /orgs/:orgId/invoices` | `org.read` / `billing.manage` | POST: `{ fromSubscription: true }` or `{ lines: [{ description, quantity?, unitPrice, sacCode? }], periodStart?, periodEnd?, notes? }` |
| `GET /invoices?status=&overdue=true` | `org.read` | — |
| `GET` / `PATCH` / `DELETE /invoices/:id` | `org.read` / `billing.manage` | PATCH and DELETE: drafts only |
| `POST /invoices/:id/issue` | `billing.manage` | — |
| `POST /invoices/:id/void` | `billing.manage` | `reason` |
| `POST /invoices/:id/payments` | `billing.manage` | `amount` (the full balance), `method`, `reference`, `receivedAt?`, `notes?` |
| `GET /invoices/:id/document?format=html\|pdf` | `org.read` | — |
| `GET /subscription-requests?status=` | `org.read` | — |
| `POST /subscription-requests/:id/resolve` | `subscription.manage` | `status` (resolved·declined), `note` |

Organization admins (`/api/org-admin`, the principal's own organization only):
`GET`/`PUT /billing/details` (`org.read`/`org.settings`), `GET /billing/invoices`,
`/billing/invoices/:id` and `/billing/invoices/:id/document` (issued, paid and
void only — never drafts; another organization's invoice is a 404),
`GET`/`POST /subscription/requests` (`org.read`/`org.settings`).

`GET /api/org-admin/plans` (`org.read`): the public catalogue, each plan marked
`current` when it is the organization's — what the Plan & billing tab offers as
upgrades. Read-only: choosing one creates a request.

Public (no account, platform deployment only, rate limited):
`GET /api/public/plans` — plans on sale AND listed (`isActive`, `isPublic`), in
order, with current terms; a custom-priced plan shows no price. Used by the
institute application form.

Registration: `application.commercial.planPreference` is validated when a draft
is saved (`400`, field `commercial.planPreference`, unless it names a plan in
the public catalogue; stored as its key; empty clears it). At approval
(`planForApproval`): staff's `subscription` wins; an organization that already
has a subscription is left alone (a retried approval never moves it back to the
asked-for plan); a self-serve plan still on sale starts a dated trial on it,
keeping the application's requested modules as add-ons; a custom-priced or
non-self-serve plan, or one taken off sale, starts nothing and says so. The
approval response carries `plan: { preference, applied, note }`.

Notices (S7): `type: 'general'`, `data: { type: 'subscription', event }`, to the
organization's approved admins (at most 25), in its own tenant context, never
blocking the change: trial started/extended/ending (once per trial end, within
3 days, from the sweep), trial or period ended (grace), read-only (grace ended,
expired), suspended, reactivated, cancelled, activated / payment received,
payment failed, plan changed, invoice issued/paid/voided, request answered. No
`screen`: the apps have no billing route and the notification service strips
any screen that is not one.

Organization admins: `GET /api/org-admin/plan` (`org.read`) now returns the real
plan name, status and period (it used to read fields a Subscription never had,
so the plan always showed "—"), plus `billing` (plan and version, dates, grace
end, own payment history), `usage.resources` and `limitsEnforced`. Read-only;
the organization comes from the principal, never a parameter.

### Error codes

| Status | Code | When |
| --- | --- | --- |
| 403 | `MODULE_NOT_ENABLED` (+ `module`) | the organization's entitlement lacks the route's module |
| 423 | `SUBSCRIPTION_READ_ONLY` (+ `subscriptionStatus`) | a write while suspended, cancelled or expired |
| 423 | `ORG_READ_ONLY` | a write while the organization is administratively suspended (unchanged) |
| 409 | `INVALID_TRANSITION` (+ `event`, `from`) | the lifecycle table does not allow it |
| 409 | `PLATFORM_OWNED` | a lifecycle action or payment on a platform-owned organization |
| 409 | `SUBSCRIPTION_CONFLICT` | it kept changing underneath the request; reload and retry |
| 404 | `SUBSCRIPTION_NOT_FOUND` | plan change or payment before a trial/activation exists |
| 400 | `REASON_REQUIRED` | a staff decision without a reason |
| 400 | `SUBSCRIPTION_INVALID` | unknown status, module, limit or interval |
| 404 / 409 / 400 | `PLAN_NOT_FOUND`, `PLAN_VERSION_NOT_FOUND` / `PLAN_INACTIVE`, `PLAN_VERSION_CONFLICT` / `PLAN_INVALID` | catalogue |
| 400 / 409 | `PAYMENT_INVALID` / `PAYMENT_DUPLICATE` | payments |
| 402 | `PLAN_LIMIT_REACHED` (+ `resource`, `limit`, `current`, `requested`) | a creation, approval, role change, build or AI generation beyond an enforced limit — the caller's own organization's numbers only |
| 503 | `USAGE_CHECK_BUSY` (+ `resource`, `Retry-After: 1`) | the usage lease could not be had in time; nothing was written |
| 400 | `BILLING_INVALID` (+ `field`) | a malformed GSTIN, PAN, state code, PIN, SAC, rate, prefix or invoice line |
| 400 | `BILLING_DETAILS_REQUIRED` | issuing a GST invoice without the seller's or buyer's state |
| 400 | `INVOICE_EMPTY` / `PAYMENT_AMOUNT_MISMATCH` (+ `expected`) | a ₹0 invoice; a payment that is not the full balance |
| 404 | `INVOICE_NOT_FOUND` | also another organization's invoice, and drafts, on the organization side |
| 409 | `INVOICE_NOT_DRAFT` / `INVOICE_NOT_ISSUED` / `INVOICE_PAID` / `INVOICE_VOID` / `INVOICE_ALREADY_PAID` / `INVOICE_CONFLICT` | invoice state does not allow it, or it changed underneath |
| 409 | `PLAN_REQUIRED` / `PRICE_REQUIRED` | drafting from a subscription with no plan, or a custom-priced plan |
| 400 / 404 / 409 | `REQUEST_INVALID` / `REQUEST_NOT_FOUND` / `REQUEST_CLOSED` | subscription requests |
| 503 | `PDF_UNAVAILABLE` | no Chromium on the host; the HTML document still works |
| 401 / 400 / 404 | `SIGNATURE_INVALID` / `EVENT_STALE`, `EVENT_INVALID` / `PROVIDER_UNKNOWN` | provider events (no route yet) |

## Testing

- `npx ts-node --transpile-only scripts/safety/subscriptions.test.ts` — pure:
  the whole table from every status, clock edges (exactly at `trialEndsAt` /
  `graceEndsAt`), month-end and leap-year intervals, payment anchoring,
  resolution for every kind of organization, the default catalogue, versioning
  rules, the read-only allowlist.
- `scripts/safety/subscriptions.e2e.test.ts` — the real app on an isolated
  loopback database it drops afterwards; refuses anything but
  `SCRATCH_DB_NAME=iso_*_scratch_subs` on loopback. Run under `warn` and
  `enforce`. Covers RBAC (owner/billing/support/tenant), unassigned vs legacy
  vs platform-owned, trials, trial end → grace → read-only, exam attempts and
  sign-in while read-only, payments (idempotent, six concurrent submissions),
  failures, suspend races, the editor not bypassing the table, plan versioning,
  upgrades and downgrades, the sweep, onboarding retries, tenant isolation of
  billing views, and the audit trail.
- `scripts/safety/usage-limits.test.ts` — pure: what holds a seat, which limits
  are enforced, the effective limit (0, -1, absent, unmanaged), IST month
  boundaries, the refusal body, and the sweep's cron gating
  (`PLATFORM_ENABLE_CRON`, platform realm only).
- `scripts/safety/usage-limits.e2e.test.ts` — refuses anything but loopback
  `iso_*_scratch_usage`; AI runs against a fake model server on loopback. Under
  `warn` and `enforce`: students/teachers/admins at and over the limit, six
  concurrent creations for one seat, deactivation and reactivation, duplicate
  approvals, failed creations, role changes, transfers between organizations,
  downgrade and upgrade without data loss, permissions before limits,
  platform-owned and unsubscribed organizations, a pre-lifecycle subscription
  keeping its access until `/manage`, open registration falling back to
  pending, app-build counting and a four-way race, AI success / failure / limit /
  five-way race / async job refund / the link-after-fail race, per-route module
  gates, tenant isolation, the lease (busy and expired), two simultaneous
  sweeps, and every lifecycle and payment action refused on a platform-owned
  organization.
- `scripts/safety/billing.test.ts` — pure: GSTIN check character against six
  published GSTINs and typo detection, no GST without a GSTIN and rate,
  CGST/SGST vs IGST, inclusive prices, per-component rounding, missing states,
  the financial-year boundary at 00:00 IST on 1 April, the 16-character number
  limit, rupee formatting, and the document (every value escaped, no external
  loads, tax/non-tax titles, PAID/VOID stamps).
- `scripts/safety/invoices.e2e.test.ts` — refuses anything but loopback
  `iso_*_scratch_billing`. Under `warn` and `enforce`: the empty profile, RBAC
  (billing vs support vs tenant), GSTIN/state validation for seller and buyer,
  drafts from the subscription and by hand, issuing with and without GST,
  snapshots surviving profile edits, five simultaneous issues numbered
  consecutively, one draft issued twice at once, no number taken by a refused
  issue, IGST and CGST+SGST, settlement (short amount, idempotent replay,
  second payment refused, three-way race), voiding rules, overdue, the
  organization's own view (no drafts, no other organization's invoices, HTML and
  PDF), requests, billing while read-only, the provider seam (tampered
  signature, stale event, unknown provider, settlement, redelivery, wrong amount,
  failure → grace, reconciliation) and the audit trail.
- `scripts/safety/subscription-admin.e2e.test.ts` — refuses anything but
  loopback `iso_*_scratch_subadmin`. Under `warn` and `enforce`: the public
  catalogue (order, prices, Enterprise without a price, unlisted and off-sale
  plans hidden, nothing internal leaked); a plan preference refused when it
  names no offered plan, normalised to its key, cleared when empty; approval
  starting a Growth trial from the preference, a reviewer's choice winning, a
  retry not undoing a staff plan change or restarting the clock, Enterprise and
  off-sale preferences starting nothing; the org-admin catalogue (own plan
  marked, no write path); notices (trial extended, invoice issued, request
  answered, suspension) reaching only that organization's admins, the
  "trial ends in N days" reminder once per trial end; billing and requests
  still open while read-only and every other write refused; the dashboard's
  billing counts; the over-limit and due-soon lists.
- `org-deletion.e2e.test.ts` — also proves payments and invoices are retained,
  and the subscription, its history and its requests deleted; run against the
  Firebase Storage emulator (`FIREBASE_STORAGE_EMULATOR_HOST`), not a real bucket.
- `isolation-audit.ts` classifies the new cron; `index-audit.ts` lists the new
  platform collections; `api-contract-snapshot.ts` now records route-level
  module keys and meters (baseline `api-contract-2026-10-23.txt`).

## Open decisions (needed before shipping)

1. **Module matrix** — confirm or change the draft above (attendance is now out;
   whether Starter should include Scheduling and Doubts; whether app builds
   should require `whiteLabel`).
2. **Limits other than students** — recommended values are now set on every
   plan (see the default catalogue, 2026-10-24); confirm or adjust them in the
   console before customers are moved onto them. Storage and exams per month need a measurement decision
   first (see "Not metered").
2a. **Organizations without a subscription** can add any number of students
   (core access has no limits). Decide whether an unassigned organization
   should have a small default limit.
2b. **What one AI generation is** — today one accepted request (so a
   solve-batch of 30 questions is 1); and whether Smart Import / schedule
   extraction count as AI.
2c. **The month** for monthly limits is the calendar month in IST, not the
   billing period.
3. **Existing organizations without a subscription** (they keep every module):
   start each on a 14-day trial at launch, grandfather them onto a plan, or
   mark some platform-owned. Abhigyan's platform organization should be
   confirmed as `isPlatformOwned: true` in production before launch.
4. **Existing subscriptions** created by the old editor are `trialing` with no
   end date and never expire on their own. Decide whether staff date them.
5. **Invoice details** — legal entity, GSTIN, SAC code, place of supply,
   invoice numbering per financial year. Nothing tax-related is filled in until
   provided and reviewed; nothing here claims GST compliance.
6. **Payment gateway** — whether and which; credentials; webhook URL. The seam
   exists; the route and checkout are built once a provider is chosen.
6a. **Before the first invoice goes out**: fill in the billing profile (legal
   entity, GSTIN, PAN, rate, SAC code), decide whether plan prices include GST,
   and have the invoice format reviewed by whoever handles the platform's GST
   filings. Payment terms default to 7 days.
6b. **Partial payments, refunds and credit notes** are not supported: an
   invoice is settled by one payment for its full balance and a paid invoice
   cannot be voided.
7. **Annual pricing** and discounts — recommended yearly prices are ten months
   (two free); confirm.
8. **Retention** — payments are kept when an organization is deleted; confirm
   the period.
9. **`PLATFORM_ENABLE_CRON`** turns on the daily sweep **and** the existing
   attendance auto-sync and teacher EOD reminders in the platform runtime
   (they share the switch). The sweep is not needed for correctness — requests
   advance subscriptions themselves — so either leave it off, or give the sweep
   its own switch before turning it on.
10. **Downgrading a module** blocks that module's routes, reads included (e.g.
   historical rankings after leaving Growth). The AI generator is the exception
   (history stays readable). Decide whether removed modules should stay
   read-only instead.

## Phasing

| Phase | Scope | State |
| --- | --- | --- |
| S1 | Catalogue + versioning, lifecycle + history, manual payments, read-only enforcement, platform-owned guard, unassigned default, platform API, tests | **Built** |
| S2 | Limits at the growth points (students, staff, AI, app builds), race-safe counting, `402 PLAN_LIMIT_REACHED`, over-limit handling without deleting data, managed-only enforcement, per-route module gating fixes | **Built** (storage, exams/month not metered) |
| S3 | Invoices (GST-ready fields, financial-year numbering, settlement, HTML/PDF), seller profile, buyer details, subscription requests, provider seam (verify, replay, idempotency, reconcile) | **Built** (backend; no webhook route) |
| S4 | Console: plan catalogue editor (versions), subscription panel (lifecycle, manage, usage), billing profile, invoices (draft, issue, void, settle), requests, renewal/overdue/over-limit lists | **Built** (type-checked; exercised by hand, not by an automated browser test) |
| S5 | Organization admin: Plan & billing tab — plan, status, dates, usage bars, modules, plans to move to, renewal/upgrade/cancellation requests, invoices (view/PDF), payment history, billing details, read-only banner | **Built** (type-checked, linted) |
| S6 | Plan selection at registration (self-serve → trial at approval; Enterprise = agreed by staff); console approval shows and can override it | **Built** |
| S7 | Notices (trial started/extended/ending, grace, read-only, suspension, payments, plan change, invoices, requests) | **Built** — in-app; push only where a device is registered |
