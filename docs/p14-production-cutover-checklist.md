# P14 — Final production cutover checklist

Prepared 2026-09-04. **Nothing in this document has been executed.**

Supersedes `p10-production-cutover-runbook.md`, which was written before P11–P13
and before production was measured. Where the two disagree, this one is current.

Everything below is grounded in a **read-only** inspection of live production
performed on 2026-09-04. The commands that would change production are written
out but were not run.

---

## 0. What production actually looks like right now

Measured, not assumed. Re-run any of these before starting — they are all
read-only and safe against a live cluster.

```bash
export MONGO_URI="…"                                  # from cbt-exam-be/.env
npx ts-node --transpile-only scripts/safety/db-inventory.ts
npx ts-node --transpile-only scripts/safety/orgid-coverage.ts
npx ts-node --transpile-only scripts/safety/firebase-access-check.ts
```

### The deployed API

| Probe | Result | Means |
|---|---|---|
| `GET /api/health` | **200** | Alive. Uptime 150,480 s ≈ 1.7 days at time of check. |
| `GET /api/public/home` | **200** | Public routes are deployed (they predate the tenancy work). |
| `GET /api/auth/login` | 405 | Route exists (GET not allowed). |
| `GET /api/exams` | 401 | Route exists, auth required. |
| `GET /api/me/context` | **404** | **Not deployed.** |
| `GET /api/org/branding` | **404** | **Not deployed.** |
| `GET /api/platform/login` | **404** | **Not deployed.** |
| `GET /api/platform/orgs` | **404** | **Not deployed.** |

Host: `https://computer-based-test-be-production.up.railway.app`
(from `VITE_API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL` in the two web clients).

**Production is running `origin/main`, which contains none of P1–P13.**
Confirmed directly — every one of these is absent from `main`:

```
src/core/tenancy/                ABSENT
src/middlewares/tenantContext.ts ABSENT
src/routes/api/platformRoutes.ts ABSENT
src/models/Org.ts                ABSENT
scripts/safety/                  ABSENT
```

`phase/p13-client-platform-final` is **40 commits ahead of `main`**.

### The production database

`abhigyangurukul` on `abhigyangurukul.guvhko7.mongodb.net`

| | |
|---|---|
| Collections | **66** |
| Documents | **238,753** |
| Data size | 71 MB |
| Index size | 36 MB |
| Documents already carrying `orgId` | **0** |
| Documents the backfill will write | **238,753** |
| `PUBLIC_LEARNER` users | **1** |

Largest collections — these dominate backfill and index-build time:

| Collection | Documents |
|---|---|
| `auditlogs` | 184,446 |
| `notifications` | 29,258 |
| `attendances` | 8,957 |
| `class_11` | 3,483 |
| `importedquestions` | 2,731 |
| `schedules` | 2,665 |
| `class_12` | 1,856 |
| `users` | **159** |
| `orgs` / `plans` / `subscriptions` / `platformusers` | **0 / 0 / 0 / 0** |

### A finding that is not in the P10 runbook

**The production database already carries tenancy indexes** — `orgId_1`,
`branchId_1`, and four unique compounds — even though the deployed API has no
tenancy code. They were created by Mongoose `autoIndex` when a tenancy-carrying
build connected to the production URI from a developer machine.

They are additive and currently inert: every `orgId` is null, so
`{orgId, key}` uniqueness is equivalent to `{key}` uniqueness. Nothing is
broken. But it means **the database and the deployed code are already out of
step**, and it is why the index step below is further along than P10 assumed.

`autoIndex` is **not disabled** anywhere in the codebase, so the first
api-legacy boot will attempt to build every declared index — including on
`auditlogs` (184,446 docs). See Step 2's rollback condition.

### Firebase

Bucket `abhigyan-gurukul.firebasestorage.app`, project `abhigyan-gurukul`.

| Check | Result |
|---|---|
| Service-account credential | **works** (`firebase-adminsdk-fbsvc@…`) |
| Storage read | reachable |
| Auth read | reachable |
| Firestore read | reachable, 23 top-level collections |
| Objects in bucket | **1,077** (full listing — under the 2,000 cap) |
| World-readable (`allUsers`) | **0** |
| On legacy paths (`materials/…`, `study-resources/…`) | **189** |
| On tenant-safe paths (`organizations/…`) | **0** |

**This corrects an earlier finding.** A previous phase recorded the local key
failing `invalid_grant` for Storage, Firestore and Auth. That is no longer true —
all three read successfully today. Firebase steps are no longer blocked on
credentials.

---

## READY

Tooling exists, is guarded, and has been rehearsed. Safe to run **when you
authorise it**, in the order given.

| # | Step | Guard |
|---|---|---|
| 4 | Fresh backup + restore verification | `db-backup.ts` / `verify-restore.ts` |
| 5 | Create Org 001 | `--production` required, idempotent |
| 6 | `orgId` backfill | dry-run default, batched, resumable, idempotent, `--undo` |
| 7 | Backfill verification | read-only |
| 13a | Drop 6 of 7 legacy global indexes | refuses per-collection unless the compound exists |
| 15 | Client app production config | `eas.json`, empty value fails closed |

## BLOCKED

| # | Blocker | What unblocks it |
|---|---|---|
| **1** | **`main` has none of the tenancy code.** Production deploys `main`; P13 is 40 commits ahead. Steps 2, 3, 8, 9, 10, 11, 12 all presuppose deployed code that does not exist in the deployable branch. | Merge the phase branches into `main` and cut a release. **This is a GitHub operation I am not permitted to perform** — it is yours. |
| 13b | `attendancerules.role_1` cannot be dropped — its replacement `orgId_1_role_1` does not exist in production. The model declares it; it has simply never been built. | Build `{orgId: 1, role: 1}` unique on `attendancerules`, then re-run the drop. The script already refuses this one collection on its own. |
| 8 | api-platform has no hostname — the deployment does not exist. | Create it (Step 8), then record the hostname. |
| 15 | `EXPO_PUBLIC_API_BASE_URL` for the production app build is empty **on purpose**, because there is no correct value until Step 8. | Step 8. |

## MANUAL VERIFICATION REQUIRED

| # | Step | Why it cannot be automated here |
|---|---|---|
| 2, 8 | The two deployments | Railway console. No deploy credentials here, and deploying is yours to trigger. |
| 3, 12 | Abhigyan app + website against api-legacy | Requires signing in as real users on real devices. |
| 11 | `TENANT_ENFORCEMENT=enforce` | Irreversible in effect (it starts failing requests). Gated on the criteria in §Final enforcement criteria. |
| 14 | Firebase legacy-file migration (189 objects) | You said explicitly: do not modify production Firebase until the storage verification step is approved. |
| — | iOS validation | No macOS/Xcode on this machine. Android was validated natively in P13; iOS has **zero** coverage. |

---

## Exact environment variables

Copy the **full existing production environment** first. Every variable not
listed keeps its current value.

### api-legacy — serves the existing Abhigyan apps

```env
TENANT_MODE=pinned
ORG_ID=<the _id printed by seed-org-001.ts in Step 5>
TENANT_ENFORCEMENT=warn
ENABLE_CRON=false
PPT_WORKER_EMBEDDED=false
ENABLE_ATTENDANCE_WEBHOOK=false
```

`ORG_ID` **must be set before the first boot.** With `TENANT_MODE=pinned` and no
`ORG_ID`, `tenantContextMiddleware` returns `503 TENANT_NOT_CONFIGURED` on every
request — but only when pinned was set *explicitly*, which it is here.

`ENABLE_CRON=false` because cron moves to api-platform in Step 8. **Until
api-platform exists, leave cron enabled on the current deployment** or scheduled
work stops.

### api-platform — serves platform-console and the new clients

```env
TENANT_MODE=claim
ORG_ID=                        # deliberately EMPTY — the token's claim decides
TENANT_ENFORCEMENT=warn        # NOT enforce, until §Final enforcement criteria
ENABLE_CRON=true
PPT_WORKER_EMBEDDED=true
ENABLE_ATTENDANCE_WEBHOOK=false
ATTENDANCE_WEBHOOK_SECRET=
ATTENDANCE_WEBHOOK_ORG_ID=
```

Shared with api-legacy and **must be byte-identical**: `MONGO_URI`, `JWT_SECRET`,
and the Firebase credentials. A different `JWT_SECRET` logs every user out
permanently with no in-app recovery.

`CORS_ORIGIN` must gain the platform-console origin. Do **not** use a
`*.vercel.app` wildcard — that trusts every preview deployment on a public
platform.

### client-platform-app

```json
// eas.json → build.production.env
"EXPO_PUBLIC_API_BASE_URL": "https://<api-platform hostname>/api"
```

The `/api` suffix is part of the base, not added by the client. Verified: with
this empty, the app makes **zero** requests and says its address was never
configured.

---

## Exact deployment order, with verification and rollback

### Step 1 — Verify production state ✅ DONE (read-only)

Done above. Re-run the three read-only scripts if time has passed.

---

### Step 2 — Deploy api-legacy in pinned mode 🚫 BLOCKED on the merge

**Prerequisite:** `main` contains the tenancy code and `ORG_ID` is known — so
Step 5 must run *before* this, despite the numbering. Order in practice:
**5 → 4 → 2**.

Set the api-legacy variables, deploy, then:

```bash
API=https://computer-based-test-be-production.up.railway.app
curl -s -o /dev/null -w "%{http_code}\n" $API/api/health              # expect 200
curl -s -o /dev/null -w "%{http_code}\n" $API/api/me/context          # expect 401, NOT 404
curl -s -o /dev/null -w "%{http_code}\n" $API/api/platform/orgs       # expect 404 — pinned mode must NOT expose platform routes
```

That third line is the P11 deployment gate. A **200 or 401** there means the
platform API is exposed on the legacy deployment — stop and roll back.

**Verify:** logs show `[tenancy] plugin registered — TENANT_MODE=pinned … org=<id>`.
Then confirm a write carries `orgId`:

```bash
npx ts-node --transpile-only scripts/safety/orgid-coverage.ts
# `users` withOrgId should be > 0 after any real sign-up/edit
```

**Rollback condition:** any of — `/api/health` not 200 within 5 minutes;
`503 TENANT_NOT_CONFIGURED` on any request; `/api/platform/*` reachable; error
rate above baseline; boot appears to hang.
**Rollback:** redeploy the previous commit, **or** unset `TENANT_MODE`, which
restores exact pre-migration behaviour. Minutes.

> ⚠ **Index builds on first boot.** `autoIndex` is enabled. The first boot will
> build every declared index it does not already have, including on `auditlogs`
> (184,446 docs). On Atlas these are background builds, but boot may appear slow
> and cluster load will rise. If this is unacceptable, set `autoIndex: false` in
> `src/config/db.ts` and create indexes deliberately instead — that is a code
> change and must happen **before** this step, not during it.

---

### Step 3 — Verify the existing Abhigyan applications 🔍 MANUAL

Against api-legacy, as real users:

- website: sign in, view schedule, view results
- mobile app v1.0.3 (the version on phones that will never update): sign in,
  list exams, open an attempt, submit, view result
- teacher: attendance, homework, materials upload
- admin: user list, exam creation, room allocation

**Verify:** every flow behaves exactly as before. This is a regression check on
*existing* behaviour, not a test of anything new.

**Rollback condition:** any flow that worked before now fails.
**Rollback:** as Step 2.

---

### Step 4 — Fresh backup and verified restore ✅ READY

```bash
npx ts-node scripts/safety/db-backup.ts
npx ts-node scripts/safety/db-restore.ts   --scratch-suffix restore_2026_09_04
npx ts-node scripts/safety/verify-restore.ts --scratch-suffix restore_2026_09_04
```

**Verify:** the restore's collection count and per-collection document counts
match §0 exactly — 66 collections, 238,753 documents.

The restore target name must contain one of `_scratch`, `_restore`,
`_rehearsal`, `_verify`; the script refuses otherwise.

**Rollback condition:** counts differ, or the restore errors.
**Rollback:** none needed — nothing has changed in production. **Do not proceed
to Step 6 without a verified restore.**

---

### Step 5 — Create Org 001 ✅ READY

```bash
npx ts-node scripts/safety/seed-org-001.ts --production
```

Idempotent: if Org 001 exists it prints the existing `_id` and changes nothing.

**Verify:** it prints `ORG_ID=<24-hex>`. Record it — it is the `ORG_ID` for
api-legacy. Then:

```bash
# orgs: 0 -> 1.  Nothing else changes.
npx ts-node --transpile-only scripts/safety/db-inventory.ts
```

**Rollback condition:** more than one org exists, or the org has unexpected
fields.
**Rollback:** delete the single `orgs` document. It is referenced by nothing
until Step 6.

---

### Step 6 — The production backfill ✅ READY (dry run first, always)

```bash
# 1. Rehearse on the verified restore from Step 4
npx ts-node --transpile-only scripts/safety/backfill-org.ts --scratch-suffix restore_2026_09_04
npx ts-node --transpile-only scripts/safety/backfill-org.ts --scratch-suffix restore_2026_09_04 --execute
npx ts-node --transpile-only scripts/safety/backfill-verify.ts --scratch-suffix restore_2026_09_04

# 2. Dry run against production — writes NOTHING
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production

# 3. Only after both of the above look right
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production --execute
```

**Expected dry-run output:** `need orgId  238753`, across 63 collections, with
3 skipped as global (`orgs`, `plans`, `platformusers`).

**Excluded from the backfill by design:** `orgs`, `plans`, `modules`,
`platformusers`. Stamping the plan catalogue with Org 001 would make
platform-wide records look like one customer's property.

**`PUBLIC_LEARNER` accounts:** 1 user. It is assigned to Org 001 now, and moved
to Org 000 by a later targeted migration. That is deliberate — leaving it with
no `orgId` would make it invisible and unrepairable under enforcement.

**Verify:**

```bash
npx ts-node --transpile-only scripts/safety/backfill-verify.ts --production
npx ts-node --transpile-only scripts/safety/orgid-coverage.ts
# expect: already attributed 238753, the backfill would write 0
```

**Rollback condition:** the run errors partway; verification reports any
collection with remaining unattributed documents; any application error appears
during or after.
**Rollback:**

```bash
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production --undo --execute
```

`orgId` is purely additive, so the undo restores the exact prior state. An
interrupted run is resumable — re-running continues from the next collection.

---

### Step 7 — Verify every migrated collection ✅ READY

```bash
npx ts-node --transpile-only scripts/safety/backfill-verify.ts --production
npx ts-node --transpile-only scripts/safety/db-inventory.ts
```

**Verify, all four:**

1. Document counts identical to §0 — the backfill adds a field, never a row.
2. Every non-global collection reports 0 documents missing `orgId`.
3. Every `orgId` equals the Step 5 `ORG_ID` — exactly one distinct value.
4. Spot-check relationships by hand: an exam and its attempts, a user and their
   results, a schedule and its room, all carry the same `orgId`.

**Rollback condition:** any count differs from §0, or more than one distinct
`orgId` exists.
**Rollback:** the `--undo` above.

---

### Step 8 — Deploy api-platform in claim mode 🚫 BLOCKED on the merge

New service, same `MONGO_URI` and `JWT_SECRET`. Variables as above.

**Do not run both with cron enabled.** Set `ENABLE_CRON=false` on api-legacy in
the same window, or Abhigyan receives every scheduled notification twice.

**Verify:**

```bash
PLATFORM=https://<api-platform hostname>
curl -s -o /dev/null -w "%{http_code}\n" $PLATFORM/api/health          # 200
curl -s -o /dev/null -w "%{http_code}\n" $PLATFORM/api/platform/orgs   # 401, NOT 404 — claim mode DOES expose these
curl -s -o /dev/null -w "%{http_code}\n" $PLATFORM/api/me/context      # 401
```

Then sign in as an Abhigyan user against api-platform and confirm
`GET /api/me/context` returns Org 001 with its real configuration.

Then confirm cron ran **exactly once**, on api-platform only.

**Rollback condition:** health not 200; `/api/platform/*` returns 404 (the gate
is inverted); duplicate notifications; a token minted by one deployment rejected
by the other.
**Rollback:** stop the service. No existing client points at it, so this is a
zero-impact rollback. Re-enable cron on api-legacy.

---

### Step 9 — Verify Org 001 and Org 002 🔍 MANUAL

```bash
API=https://<api-platform hostname> \
  npx ts-node --transpile-only scripts/safety/two-org-client-validation.ts
```

**Note on Org 002.** There is no Org 002 in production — it is a *fixture*
concept used throughout P6–P13. In production, "Org 002" means **the first real
customer onboarded through platform-console after cutover**. Until one exists,
this step verifies Org 001 only, and the two-org guarantees are carried by the
fixture suites (29 checks) rather than by production data.

### Expected Org 001 state

| Dimension | Expected |
|---|---|
| Name | Abhigyan Gurukull |
| `orgId` | the Step 5 value, on all 238,753 documents |
| Users | 159 (158 institute + 1 `PUBLIC_LEARNER`) |
| Branding | none configured → falls back to platform indigo |
| Subscription | none → resolves to **every** module (unsubscribed = unrestricted) |
| Classes / Subjects / Batches / Rooms | as currently configured — 6 / 15 / 3 / 11 in the fixture, confirm against production |
| Exams / Attempts / Results | unchanged counts from §0 |

### Expected Org 002 state (first real customer)

| Dimension | Expected |
|---|---|
| Created by | platform-console, not a script |
| `orgId` | new, distinct |
| Documents | starts at 0 in every tenant collection |
| Branding | its own three colours |
| Subscription | a real plan — so its module set is a **subset** of Org 001's |
| Visibility of Org 001 data | **none**, in any collection, through any endpoint |
| Public catalogue | its own published-public content, plus platform-level content, and **never** Org 001's (P13) |

---

### Step 10 — Observe both deployments 🔍 MANUAL

Minimum **24 hours** with real traffic before Step 11.

Watch: error rate on both services; `[tenancy:warn] unscoped …` log lines and
which models they name; notification volume (duplicates = cron on both); token
rejections; p95 latency against the pre-cutover baseline.

**Rollback condition:** sustained error-rate increase, or `unscoped` warnings
naming a model that should always be scoped.

---

### Step 11 — Enable enforcement ⚠️ MANUAL, GATED

**Only on api-platform.** api-legacy stays `warn` — it serves clients that
cannot be updated.

```env
TENANT_ENFORCEMENT=enforce
```

See §Final enforcement criteria. Every one must pass first.

**Verify immediately after:** reads and writes succeed for an Abhigyan user;
`/api/me/context` still resolves Org 001; no `TenantContextMissing` in logs.

**Rollback condition:** *any* `TenantContextMissing` error; any request failing
that succeeded under `warn`; any user reporting missing data.
**Rollback:** `TENANT_ENFORCEMENT=warn`. Immediate and total — enforcement adds
filtering, so removing it restores the prior behaviour exactly.

---

### Step 12 — Verify Abhigyan again 🔍 MANUAL

Repeat Step 3 in full, against both deployments, after enforcement is on. This
is the step that catches a collection whose documents were missed by the
backfill: under `warn` they were visible, under `enforce` they are not.

---

### Step 13 — Legacy index migration ✅ READY (6 of 7)

**Only after** the backfill is verified. Dropping a global unique index before
`orgId` exists removes uniqueness with nothing replacing it.

```bash
npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts --production
```

The script verifies the compound replacement exists **per collection** and
refuses that collection otherwise — it does not refuse the whole run.

| Collection | Legacy index | In production | Compound present | Status |
|---|---|---|---|---|
| `batches` | `name_1` | yes | `orgId_1_name_1` | ✅ ready |
| `appsettings` | `key_1` | yes | `orgId_1_key_1` | ✅ ready |
| `holidays` | `date_1` | yes | `orgId_1_date_1` | ✅ ready |
| `roomallocations` | `date_1` | yes | `orgId_1_date_1` | ✅ ready |
| `filemetadatas` | `storagePath_1` | yes | `orgId_1_storagePath_1` | ✅ ready |
| `attendances` | `idempotencyKey_1` | yes | `orgId_1_idempotencyKey_1` | ✅ ready |
| **`attendancerules`** | **`role_1`** | yes | **MISSING** | 🚫 **blocked** |

`attendancerules.orgId_1_role_1` is declared in the model but has never been
built in production. Build it, confirm it, then re-run — the script will pick up
the seventh collection on its own.

**Rollback condition:** a duplicate-key error after a drop, or the script
reporting it dropped an index whose compound it could not confirm.
**Rollback:** recreate the dropped index by name. Dropping is reversible; the
*window without uniqueness* is not, which is why the ordering check exists.

---

### Step 14 — Firebase 🔍 MANUAL, NEEDS YOUR EXPLICIT APPROVAL

Verification (read-only — safe to run now):

```bash
npx ts-node --transpile-only scripts/safety/firebase-access-check.ts
npx ts-node --transpile-only scripts/safety/storage-audit.ts   # static source audit
```

**Current state, measured:** 1,077 objects · **0 world-readable** · 189 on
legacy paths (188 `materials/…`, 1 `study-resources/…`) · 0 on
`organizations/…`.

The legacy-file migration moves those 189 objects to tenant-scoped paths. It is
the only Firebase **write** in this plan and you have not approved it. When you
do:

1. Verify a full listing (not the 2,000 sample) still shows 0 world-readable.
2. Dry-run the move; confirm it reports exactly 189 objects.
3. Confirm `filemetadatas.storagePath` is updated in the same transaction —
   a moved object with a stale path is an unreachable file.
4. Execute, then spot-check that a material still downloads in the app.

**Rollback condition:** any file 404s after the move.
**Rollback:** the objects are copied then deleted, so restore from the copy —
**verify the copy exists before the delete**, per object.

Firestore's 23 collections are the P9 decommission target and are explicitly
**out of scope** here.

---

### Step 15 — Client app production configuration ✅ READY (pending Step 8)

```json
// client-platform-app/eas.json → build.production.env
"EXPO_PUBLIC_API_BASE_URL": "https://<api-platform hostname>/api"
```

```bash
cd client-platform-app
npm run verify           # 64 + 145 + 59 + 32 + 17 checks
eas build --profile production --platform android
```

**Verify on the built app:** Profile → Connection → **API** shows the production
hostname. That field exists for exactly this check.

**Rollback condition:** the field shows anything else, or the app reports
"This build was made without a server address".

---

## Final enforcement criteria

Every one must hold before `TENANT_ENFORCEMENT=enforce`. Not a summary — a gate.

1. **Backfill verified**: 0 documents without `orgId` in any non-global
   collection, and exactly one distinct `orgId` value.
2. **Counts unchanged**: 66 collections, 238,753 documents — identical to §0.
3. **api-legacy stable ≥ 24 h** in pinned mode with no error-rate increase.
4. **api-platform stable ≥ 24 h** in claim mode with real traffic.
5. **No `[tenancy:warn] unscoped` lines** naming a tenant-owned model. Warnings
   naming a global collection are expected and fine.
6. **Both clients verified** against api-platform: sign-in, context, exams,
   attempt, results.
7. **A verified restore exists**, taken *after* the backfill, so enforcement can
   be rolled back to a known-good state rather than only to `warn`.
8. **Step 13 complete for all 7 collections**, including `attendancerules`.
9. **Rollback rehearsed**: `enforce` → `warn` performed once on a scratch
   deployment and confirmed instant.

Criteria 5 and 8 are the two most likely to fail. Neither is optional.

---

## The one thing to do first

Everything in this document is downstream of a single fact: **the tenancy code
is not in `main`, and `main` is what production deploys.**

Until the phase branches are merged and released, Steps 2, 3, 8, 9, 10, 11 and
12 cannot begin — they verify behaviour that is not deployed. Steps 4, 5, 6, 7
and 14 operate on the database and on Firebase and are independent of it, but
running the backfill against a database whose API has no tenancy code leaves the
system in a half-migrated state for however long the merge takes.

**Recommended order:** merge and release first, then 4 → 5 → 2 → 3 → 6 → 7 →
8 → 9 → 10 → 13 → 11 → 12 → 14 → 15.

Merging and releasing is a GitHub operation. It is yours to perform.
