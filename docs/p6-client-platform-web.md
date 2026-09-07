# P6 — client-platform-web

`cbt-exam` evolved into the tenant-aware client. Not rewritten: the application
that existed on the `phase/p6-client-platform-web` branch's parent is the
application that runs now, with a context layer added underneath it and a
handful of hardcoded lists replaced by that context.

The claim this phase makes is narrow and testable:

> One build, served from one process at one URL, correctly serves two
> organizations. Nothing changes between them except who logs in.

`scripts/safety/client-platform-web.e2e.test.ts` drives exactly that, in a real
browser, against real APIs, and reads the build identifier before the first
tenant and after the last to prove no rebuild happened in between.

---

## 1. The rule the whole layer rests on

There are three states, and collapsing the third into the second is the single
most damaging mistake available here:

| | meaning | client behaviour |
|---|---|---|
| **allowed** | the org has the module / the user holds the permission | show it |
| **denied** | context resolved and does not include it | hide it, and explain at the route |
| **unknown** | no context at all | **show it** |

Every Abhigyan user today is **unknown**. Their deployment is pinned,
`/api/me/context` answers `organization: null`, and the arrays come back empty.
Reading empty as "no modules, no permissions" would have presented them a blank
application on the day this shipped.

This is the sixth time this exact shape has come up in this programme, after the
defaulted cron disable, the defaulted-pinned 503, the no-subscription
entitlement, the empty configuration, and the unconditional `orgId` filter:

> **A safe default for the NEW model is not a safe default for BEHAVIOUR.**
> Absent context must mean "as before", never "nothing".

Being permissive here is not a security hole, because this was never the
security boundary. `requirePermission` on the server fails **closed**; a
permission this client wrongly believes the user holds buys them a 403, not
access. The client controls whether a user is shown a door they cannot open —
hiding it is a courtesy, the lock is elsewhere.

`scripts/verify-tenant-access.ts` asserts this directly: all 32 navigation
entries and all 12 feature gates survive an api-legacy context.

---

## 2. Backend changes P6 required

The client could not have been tenant-aware without these. Each is additive and
each is inert on today's production, which sets no `TENANT_*` variables at all.

### 2.1 `orgId` in the session token — the blocker

`login` issued `{ id, role }`. In claim mode that leaves an authenticated
request with no organization, so `/api/me/context` answers `organization: null`
and **no client can ever be tenant-aware**.

`signSessionToken()` (`core/auth/tokens.ts`) adds `orgId`, and only when the
user has one. Deliberately NOT `signTenantToken`: that mints a 15-minute token
with an `aud` claim, and the installed Abhigyan app has no refresh logic — it
would log every user out fifteen minutes after deploy with no way back. Same
shape, same 3650-day expiry, one extra claim.

### 2.2 Pre-authentication organization resolution

`tenantContext.ts`'s docstring said a host or header is consulted "when there is
no token at all, which is the pre-authentication case". The code computed the
hint, used it only for a mismatch check, and discarded it. Two things broke:

1. **Login was ambiguous.** `User.email` is unique *per organization* now, so
   two institutes may hold the same address and `User.findOne({ email })` with
   no context returns whichever the index reaches first.
2. **A login page could not be branded.** Colours have to be on screen before
   the credential that would reveal them is submitted.

`core/tenancy/hostResolution.ts` resolves `X-Org-Id` or the request `Host`
against `Org.slug` / `Org.domains`, with a 60-second cache (negative results
included, so an unknown Host cannot turn the cache into an amplifier).

Platform routes are excluded outright — a PlatformUser's token carries no
`orgId` by design, and without the exclusion every platform request served from
a tenant's domain would run inside that tenant's context.

A hint that disagrees with a signed claim is still rejected, but compared
*resolved*: a client may hold the slug while the claim carries the id.

### 2.3 `GET /api/org/branding`

The only thing readable without a credential: name, slug, status, branding,
locale. No modules (a competitor could enumerate what an institute pays for), no
limits (a headcount), no configuration. Answers `{ organization: null }` with a
200 whenever the organization cannot be determined, so a client never needs an
error branch for the ordinary case.

Recorded in `DELIBERATELY_NOT_ALLOWLISTED` with the reasoning — allowlisting it
would **break** it, because an allowlisted route runs inside
`withoutTenantScope` and `currentOrgId()` would always be null.

### 2.4 `batchConfigService` — a destructive cross-tenant path

This service was Abhigyan expressed as code: classes 7–12 in a constant,
`Batch.find({})` across the whole collection, and a merge step that hunted for
batches literally named "Advanced" and "Basic" and **deleted** them.

In a shared database under `warn` — where reads are not filtered — one Abhigyan
admin opening a user form would have merged and then deleted another institute's
batches, and rewritten their students' `batch` field.

All three inputs now come from configuration: classes and batches from
`getOrgConfiguration()`, merge rules from `getOrgPolicy().batch.mergeRules`.
Abhigyan resolves to the same classes, the same batches and the same merge rule,
because `PLATFORM_DEFAULTS` transcribes the constant this file used to hold.

### 2.5 `tenantScope()` — explicit scoping, safely conditional

`core/tenancy/queryScope.ts`. The obvious fix for an unscoped read is to add
`{ orgId }`. On api-legacy, pinned but not yet backfilled, that does not isolate
anything — it **empties every picker in production**.

So it scopes only when the data is known to carry `orgId`:

| condition | scoped? | why |
|---|---|---|
| claim mode | yes | every org here was created through onboarding, which stamps `orgId` |
| `TENANT_ENFORCEMENT=enforce` | yes | enforcement is flipped only after a verified backfill |
| otherwise | **no** | today's production, and pinned-before-backfill |

Applied to the reads that feed the surfaces this phase owns. It is a **stopgap
with a known end date** — the general answer is the enforce flip, which filters
every read rather than the ones named by callers.

---

## 3. Leaks the browser suite actually found

None of these were theorised. Each was visible on screen.

| Leak | Symptom | Fix |
|---|---|---|
| `GET /schedule/batches` | Abhigyan's schedule form offered ABC's "NEET" and "JEE Advanced" | `tenantScope()` |
| `GET /schedule/teachers` | ABC's teacher picker offered "Abhigyan Gurukull Teacher" by name | `tenantScope()` |
| `GET /users/dashboard` | "Total users **9**" for two organizations of four | `tenantScope()` |
| `GET /users` | admin user list spanned both institutes | `tenantScope()` |
| `PUT`/`DELETE /schedule/batches/:id` | one org could rename or delete another's batch by id | scoped by `{ _id, ...tenantScope() }` |
| `GET /schedule/rooms` | hardcoded `Room 1..11` — Abhigyan's rooms as a loop | reads `getOrgConfiguration()` |
| `"Class dropper"` | `Class ${key}` synthesised for a non-numeric level | renders the configured label |
| `?classLevel=Dropper` | `normalizeClassValue` digit-extraction returned null, then a case-sensitive exact match found nobody, silently | `resolveClassKey` + every configured spelling |

---

## 4. Client architecture

Five new files under `src/lib/tenant/`, and edits — mostly one or two lines —
to the components that consume them.

| File | Responsibility |
|---|---|
| `types.ts` | the `/api/me/context` payload, transcribed from what the server returns |
| `access.ts` | **no React.** `moduleDecision` / `permissionDecision` / `gateDecision`. The rules, unit-testable without a browser |
| `context.tsx` | `TenantProvider` + `useTenant()`. One fetch; sessionStorage cache keyed by token; refetch on login/logout |
| `branding.ts` | branding → CSS custom properties, with derived hover/tint/contrast tokens |
| `registry.ts` | every nav entry and feature, with the module and permissions it needs, in one readable table |
| `guards.tsx` | `ModuleGate` / `Can` / `GatedScreen` / `GatedButton`, and the three distinct explanations |
| `orgHint.ts` | the pre-auth organization hint — **learned at runtime, never compiled in** |

### Why CSS custom properties

The application is several hundred components deep and almost none of them take
a colour. Threading a theme object through would be the rewrite this phase was
told not to do. Custom properties reach every descendant without any component
knowing branding exists.

The three legacy palette names (`--sage-green`, `--moss-green`, `--dark-olive`)
are **repointed** by branding, so every existing component and every
`.bg-primary` utility became tenant-aware without being edited.

### Why the hint is never compiled in

A `NEXT_PUBLIC_ORG` baked at build time would quietly turn one build into one
build *per tenant* — the exact thing this phase exists to eliminate. The hint
comes from `?org=<slug>`, or a slug remembered from the last resolved context in
this browser, or nothing at all (production resolves the Host server-side).

### Three denials, three different messages

Conflating these produces the two worst support tickets a platform can generate.

| | cause | what the message says |
|---|---|---|
| **Module disabled** | the org's plan | the fix is commercial; *no role change will make it appear* |
| **Not authorized** | this person's role | the module exists here; names the role they hold; their own admin can grant it |
| **Read-only** | suspended/past-due subscription | the work is intact and editable once billing is settled |

Navigation **hides** a denied entry; the **route still explains**, because links
are shared, bookmarked and typed, and a blank page at a real URL reads as a
broken product. Actions inside a visible screen are **disabled with a reason**
rather than removed — removing them makes the screen look incomplete.

### Tiles are navigation too

The app-management dashboard's Quick Action tiles link to the same routes as the
sidebar and are driven by the same gate table, so the two cannot drift into a
state where a working-looking card lands on "not in your plan".

---

## 5. The fixture

`scripts/safety/seed-p6-fixture.ts`, against a **scratch database** — guarded by
the same `assertNotProduction()` the other safety scripts use, which refuses the
production host+database *and* requires a scratch marker in the name.

Production's `abhigyangurukul` has **zero** Org, Plan and Subscription
documents. P1–P5 never migrated it and P6 does not either.

| | Abhigyan Gurukull (control) | ABC Coaching Institute |
|---|---|---|
| classes | 7, 8, 9, 10, 11, 12 | 9, 10, 11, 12, **dropper** |
| subjects | 15 | 4 |
| rooms | Room 1–11, real capacities | Hall A/B, Lab 1/2 |
| batches | Aarambh, Advanced/Basic, Sankalp | Foundation, JEE Main, JEE Advanced, NEET |
| marking | +1 / 0 / 0 | +4 / −1 / 0 |
| submit lock | 50% | 75% |
| violations | 10 | 3 |
| branding | none — renders as it always has | `#E8590C` / `#1B3A5C`, "ABC Coaching" |
| modules | 34 (unsubscribed → all) | 30 (plan withholds ai, aiAnalysis, questionImport, integrations) |

The differences are chosen so a client that *ignored* the context would fail
visibly rather than pass by coincidence: eleven "Room N" options cannot be
mistaken for four halls, and `dropper` is precisely the value the old
digit-extracting normalizer dropped on the floor.

Three principals, three different reasons to be denied:

- **ABC admin** — every permission, restricted plan → *module* denials
- **ABC front desk** — full plan, 7 permissions → *permission* denials
- **Abhigyan admin** — everything → the control

A suite that only varied the plan would never notice a permission gate wired to
nothing, and vice versa.

---

## 6. Running it

```bash
# platform-core
P6_MONGO_URI=<scratch uri> npm run p6:seed
P6_MONGO_URI=<scratch uri> npm run p6:serve          # claim mode, :5055

# client-platform-web
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5055/api npm run build
npx next start -p 3200

# back in platform-core
npm run safety:web                                    # 109 checks, 12 screenshots
```

Pure-logic checks need nothing running:

```bash
cd client-platform-web && npm run verify              # 27 + 78 checks
```

---

## 7. Results

| Suite | Result |
|---|---|
| `safety:all` (tenancy, webhook, entitlements, org-config, RBAC, deployment, contract, coverage, lookups) | **176 checks green** |
| API contract | **487 endpoints, +1, nothing removed or altered** |
| `verify:public-tests` (web) | 27/27 |
| `verify:tenant` (web) | 78/78 |
| `client-platform-web.e2e` (two tenants, one build) | **109/109** |
| `platform-onboarding.e2e` | 46/46 |
| `custom-roles.e2e` | 22/22 |
| `two-org-isolation` | 9/9 |
| `console-ui.e2e` | 39/39 |
| `legacy-regression` | 28/28 workflows; **31/32 checks — see below** |

### The one non-green check

`legacy-regression` reports `AppSetting.findOne ×3` as an unscoped tenant
operation. Verified **pre-existing**: the same suite on the pre-P6 tree produces
the identical result — 28/28 workflows, the same single finding.

It is a real multi-tenancy defect and it is recorded rather than patched at the
tail of this phase: `AppSetting` stores schedule time slots keyed by a
**globally unique** `key`, so two organizations cannot hold different time
slots. Fixing it means making the key compound and scoping the reads, which is
its own change with its own migration.

---

## 8. What is NOT done

- **The enforce flip.** Reads are unfiltered under `warn`. `tenantScope()`
  covers the surfaces this phase owns; every other read of a tenant collection
  is still unscoped in claim mode. This is the single largest remaining gap and
  it is deployment-gated.
- **`AppSetting` per-organization time slots** (above).
- **Public-learning pickers** deliberately left on their own class lists. That
  catalogue serves learners who are *not enrolled anywhere*, so narrowing it to
  an institute's configured levels would be wrong, not tenant-aware.
- **`QuestMlDashboard`** keeps `class_8`-style values: that is an external
  service's contract, not a tenant's configuration.
- **`pdfTemplate.ts` and the schedule Excel exports** still carry "Abhigyan
  Gurukull" in watermarks and footers. `Org.branding.documentHeader` exists for
  this; wiring it is document-generation work, not context work.
- **`client-platform-app`** — not started, as instructed.
- Nothing deployed. Nothing enforced. No production data migrated.
