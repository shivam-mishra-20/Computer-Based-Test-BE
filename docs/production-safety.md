# Production Safety Record

**Living document.** Every implementation phase must update it before being
declared complete. It is the single place that answers *"if this goes wrong,
what do we go back to, and how do we know it worked?"*

| | |
|---|---|
| **Current phase** | P1 — tenancy runtime (warn mode) |
| **Status** | ✅ P0 · ✅ P1 step 2 · ✅ tenancy runtime (warn) · ✅ worker/cron context · ⏭ next: public routes, then backfill |
| **Established** | 2026-08-17 |
| **Next phase** | Worker/cron context → backfill rehearsal. Deployment split still blocked (§12). |

---

## 1. Baseline commit

All four repositories were clean, on `main`, in sync with `origin/main`, and
carried **no tags at all** before this phase. Every one is now tagged at the
same point in time.

| Repository | Commit | Tag |
|---|---|---|
| `cbt-exam-be` | `8fc5d8125e7c` | `baseline/pre-saas-2026-08-17` |
| `cbt-exam` | `25dc18f25ddd` | `baseline/pre-saas-2026-08-17` |
| `abhigyan-gurukul-app` | `ddc7e8579d7a` | `baseline/pre-saas-2026-08-17` |
| `abhigyan-gurukul-main` | `f0d9770c1740` | `baseline/pre-saas-2026-08-17` |

An additional tag `legacy/v1.0` on `cbt-exam-be` @ `8fc5d8125e7c` marks the pin
point for the `api-legacy` deployment.

> ⚠️ **These tags are local only.** They are not yet pushed to `origin`, so they
> do not survive a lost machine. Pushing them is the first outward-facing action
> of P1 and needs explicit approval.

**Work branches:** `phase/p0-safety`, then `phase/p1-tenant-foundation`
(branched from it). **`main` is untouched.** Nothing has been pushed to any
remote — all tags and branches are local, pending manual sync.

---

## 2. Production deployment

| | |
|---|---|
| Backend host | Railway |
| Database | MongoDB Atlas — cluster `abhigyangurukul.guvhko7.mongodb.net`, db `abhigyangurukul` |
| Cache / pubsub | Redis (single instance, `REDIS_URL`) |
| File storage | Firebase Storage, single project |
| Mobile | `abhigyan-gurukul-app` v1.0.3, Android versionCode 19, `com.shiv.mishra.abhigyangurukulapp`, EAS project `5fd2e55e-…` |
| Web | `cbt-exam` on Vercel |
| Env vars | 87 in `cbt-exam-be/.env` — names recorded in §8, **values never recorded here** |

> ⚠️ **Unverified:** the commits above are the local `main` HEADs. Whether Railway
> and Vercel are currently serving exactly those commits has **not** been
> confirmed — that requires dashboard access. Confirm before P1 step 3, because
> the `legacy/v1.0` pin must match what is actually in production.

---

## 3. Database backup

Taken with `scripts/safety/db-backup.ts`. The MongoDB Database Tools
(`mongodump`/`mongorestore`) are **not installed** on this machine and Docker is
unavailable, so the tooling drives the MongoDB driver bundled with mongoose
instead. Output is newline-delimited **canonical EJSON**, which round-trips
ObjectId, Date, Decimal128 and Binary losslessly — plain JSON would silently
degrade every one of those to a string.

| | |
|---|---|
| Location | `backups/2026-08-17-p0/` (git-ignored) |
| Collections | 62 |
| Documents | **226,963** |
| On disk | 87 MB EJSON |
| Elapsed | 28.4 s |
| Manifest | `manifest.json` — per-collection count + SHA-256 fingerprint + index definitions |

**Production totals at baseline:** dataSize 67 MB · storageSize 19 MB ·
indexSize 28 MB. Full per-collection inventory:
`docs/baselines/db-inventory-2026-08-17.json`.

Notable distribution — useful for sizing P1's backfill:

| Collection | Documents | Note |
|---|---|---|
| `auditlogs` | 181,199 | 80% of all documents; 30-day TTL |
| `notifications` | 22,940 | |
| `attendances` | 7,643 | |
| `class_6…class_12` | 7,246 total | 7 dynamic collections — the `ClassQuestion` issue, quantified |
| `questions` | 0 | the "global" Question collection is empty; everything lives in `class_*` |
| `schedules` | 2,116 | |
| `importedquestions` | 2,731 | |
| `users` | 158 | |
| `exams` / `attempts` | 8 / 48 | online exam engine still lightly used |
| `testresults` | 139 | offline tests |

> **This database is small.** 227k documents and 67 MB means the P1 backfill is a
> minutes-long operation, not an overnight one. That materially lowers migration
> risk versus what the audit assumed.

---

## 4. Restore verification ✅

**A backup is not a backup until it has been restored.** This gate is satisfied.

| Step | Result |
|---|---|
| Restore target | `abhigyangurukul_restore_2026_08_17` (scratch db, same Atlas cluster) |
| Restore | 62/62 collections, 226,963 documents, 88.7 s |
| Indexes | recreated from the manifest |
| **Verification** | **PASSED — every collection matches by document count AND by SHA-256 content fingerprint** |

Counting rows proves nothing about content: a restore that turned every
ObjectId into a string would have exactly the right count and be unusable. The
fingerprint is computed over canonical EJSON in `_id` order on both sides, so it
catches type degradation, silent truncation and content drift.

**Reproduce:**

```bash
npm run safety:backup                       # → backups/<timestamp>/
npm run safety:restore -- --from backups/<dir> --scratch-suffix restore_YYYY_MM_DD
npm run safety:verify  -- --from backups/<dir> --scratch-suffix restore_YYYY_MM_DD
```

The scratch database is **retained** as the P1 migration rehearsal environment.
Every backfill runs there twice — once clean, once interrupted and resumed —
before it goes anywhere near production.

### Write guard

`assertNotProduction()` protects every write path in this tooling. Three
conditions must all hold: the target parses, it is not the production host+db,
and its database name carries an explicit scratch marker (`_scratch`,
`_restore`, `_rehearsal`, `_verify`). It **fails closed** — an unparseable URI is
treated as production, not as "probably fine".

`npm run safety:guard` runs 10 cases in under a second with no database or
network, including the mid-word trap (`restoration` must not be accepted as
scratch). All pass.

---

## 5. API contract baseline

`docs/baselines/api-contract-2026-08-17.txt` — **463 endpoints** with their full
authorization chains, generated by `scripts/safety/api-contract-snapshot.ts`.

```bash
npm run safety:api-check     # fails if the contract drifted from the baseline
```

The legacy Abhigyan app consumes these endpoints and **cannot be updated in
lockstep** — installs in the field update slowly and some never will. Diffing
this file answers "did we just break a client we cannot fix" in one command. It
captures guards as well as paths, so a `requireRole` that quietly disappears in
a refactor is caught too.

**Parser accuracy matters here and cost two corrections.** The first pass
reported 65 unguarded endpoints, including `POST /api/admin/settings` and
`POST /api/teacher/ai/generate`. Both were false alarms:

- five route files apply auth via `router.use(authMiddleware, requireRole(…))`
  at file level (`adminRoutes`, `attendanceRuleRoutes`, `examReviewRoutes`,
  `playlistRoutes`, `publicTestAdminRoutes`);
- `teacherRoutes` spreads `const aiGuards = [authMiddleware,
  requireRole('teacher','admin'), aiLimiter]` into its AI routes.

The parser now resolves both. **A baseline that misreports authorization is
worse than no baseline**, because the first real regression gets dismissed as
another false alarm.

After correction: **16 genuinely unguarded endpoints**, listed in §7.

---

## 5b. Client consumption surface — the blast radius

`docs/baselines/legacy-client-surface-2026-08-17.txt`, generated by
`npm run safety:client-surface`.

The API declares 385 distinct routes (463 endpoints collapse to 385 once
`:params` are normalised). The question that governs migration risk is
narrower: **which of them does a client we cannot update consume?**

| | Routes |
|---|---|
| Declared | 385 |
| **Consumed by the legacy mobile app** | **158** ← load-bearing, cannot be force-updated |
| Consumed by any client | 290 |
| Apparently unconsumed | 133 |

This converts "463 endpoints, all equally risky" into a ranked blast radius.
Changing one of the 158 risks breaking installs already on students' phones.
Changing one of the 133 is comparatively free.

> "Apparently unconsumed" is a **static** result, not proof. The report lists
> dynamically-constructed paths it cannot resolve; check those before treating
> a route as dead.

### Tooling accuracy — three bugs found and fixed while building this

The first three runs of this tool were wrong, each in the dangerous direction
(under-reporting what clients depend on):

1. **Prefix mismatch.** The three clients do not agree on where `/api` lives.
   Mobile's `API_BASE` omits it and call sites write `/api/auth/login`; the web
   and marketing clients' `API_BASE` ends in `/api` and call sites write
   `/auth/login`. Grepping for `/api/` found the mobile app and almost nothing
   else.
2. **Pre-filter bug.** A cheap `if (!source.includes('/api/')) continue;` then
   skipped nearly every web and marketing file for the same reason —
   under-reporting the web surface as **35 routes when the true figure is 133**.
3. **Query-builder mis-normalisation.** `` `/api/doubts/teacher${qs}` `` was read
   as the route `/api/doubts/teacher/:param`, inventing a route that does not
   exist while reporting the real one as unconsumed. Interpolations are now
   treated as parameters only when they follow a `/`.

Recorded because the same failure mode has now appeared in two separate tools
this phase (see §5). **A safety instrument that under-reports is worse than no
instrument**, and every result from these tools should be spot-checked against
an independent count before being trusted.

### Pre-existing defect found

`GET /api/schedule/upcoming` is called by `lib/enhancedApi.ts:333` in the legacy
app, but `scheduleRoutes.ts` declares no such route — it would 404. The calling
function `getUpcomingSchedule()` is **exported and never invoked**, so this is
dead code rather than a live failure. No action needed; recorded so it is not
mistaken for a migration regression later.

**Implication for the replay harness:** the baseline must capture what the API
does *today*, including its 404s. "Do not break production" means "do not change
behaviour" — including behaviour that is already wrong.

---

## 5c. Tenancy runtime (P1) — shipped in warn mode

`src/core/tenancy/` + `src/middlewares/tenantContext.ts` + `src/models/Org.ts`.

**Ships with zero behaviour change.** The context is established and unscoped
access is observed; no read is filtered until `TENANT_ENFORCEMENT=enforce`.

### Configuration

| Variable | Values | Default | Effect |
|---|---|---|---|
| `TENANT_MODE` | `pinned` \| `claim` | `pinned` | `pinned` = api-legacy (org fixed by `ORG_ID`); `claim` = api-platform (org from token) |
| `ORG_ID` | Org 001's `_id` | unset | Required in `pinned` mode |
| `TENANT_ENFORCEMENT` | `off` \| `warn` \| `enforce` | `warn` | The migration kill switch |

### The read/write asymmetry

This is the single property that makes the change deployable to a live system:

- **Writes are stamped** under `warn` and `enforce`. Additive — sets a field on
  documents being created anyway, and nothing reads it yet. Shrinks the backfill
  to pre-existing rows and closes the race where a row created mid-backfill is
  missed.
- **Reads are filtered only under `enforce`.** Subtractive. During the warn
  period `orgId` is not backfilled, so adding `{ orgId }` to a read would match
  nothing and **every screen in production would go blank**.

`scripts/safety/tenancy.test.ts` asserts this directly so it cannot regress.

### Production-behaviour bug caught before wiring

`tenantMode()` defaults to `pinned` (safest tenancy setting), and pinned is the
api-legacy deployment, which must not run cron. But **today's production sets no
`TENANT_MODE` at all** — so deriving "disable cron" from the *defaulted* value
would have silently stopped the four daily attendance syncs and the EOD reminder
on the live system.

Cron is now disabled only by an **explicit** `TENANT_MODE=pinned`. Covered by a
regression test that asserts an unset `TENANT_MODE` still runs cron.

### Silent-failure protection

`mongoose.plugin()` applies only to schemas compiled *after* the call. A model
imported before `registerTenancy()` gets no `orgId` and no hooks — and boots,
tests and serves normally while being permanently unscoped. That is the quietest
possible way to lose isolation.

- `registerTenancy()` runs at the very top of `src/server.ts`, above the
  `require('./app')` that compiles every model.
- `verifyTenantPluginApplied()` asserts coverage once models are loaded:
  **logs** under `warn`, **refuses to boot** under `enforce`.
- `npm run safety:tenant-coverage` gates this in CI.

**Verified:** 55 models compiled · 54 tenant-scoped · 1 exempt (`Org`) · 0
missing. All scoped models carry an `orgId` index.

### Escape hatch

```ts
await withoutTenantScope('auth:resolve-org-by-email', () => User.findOne({ email }));
```

`reason` is mandatory, so `grep -rn "withoutTenantScope(" src/` produces a
complete, reviewable list of every sanctioned bypass.

### Org 001 seed

`npm run safety:seed-org` — idempotent, refuses to guess a target.

```bash
npx ts-node --transpile-only scripts/safety/seed-org-001.ts --scratch-suffix restore_2026_08_17
npx ts-node --transpile-only scripts/safety/seed-org-001.ts --production   # when approved
```

Rehearsed twice on the scratch restore: created once, no-op on re-run.
**Not yet run against production.**

### Known limits — recorded, not hidden

| Limit | Consequence |
|---|---|
| `$lookup` sub-pipelines | The plugin scopes the pipeline's own collection but cannot reach into a joined one. Every `$lookup` needs its own `orgId` match. Permanent code-review item. |
| Public routes under `claim` | With no token there is no context. Under `enforce` a public route touching the database will throw until it is wrapped in `withoutTenantScope`. Must be resolved before enforce is switched on. |
| `estimatedDocumentCount` | Collection-level; cannot be filtered by tenant. Avoid on scoped models. |
| ~~Workers / cron~~ | **Resolved.** Both crons run via `forEachOrg`; both queues stamp `orgId` at enqueue and open a fresh context in the processor. |

---

## 6. Rollback procedure

| Failure | Rollback | Time | Data loss |
|---|---|---|---|
| Bad backend deploy | Redeploy previous Railway image | ~2 min | None |
| Enforce mode breaks something (P1+) | `TENANT_ENFORCEMENT=false` → warn mode | ~2 min | None |
| Backfill goes wrong mid-run (P1) | Script is idempotent + resumable; or unset `orgId` over the affected range | Minutes | None — additive field |
| Legacy app breaks after repoint | Repoint API host back to the original | Minutes | None |
| Web regression | Vercel instant rollback | Seconds | None |
| Code regression, any repo | `git checkout baseline/pre-saas-2026-08-17` | Seconds | None |
| **Database corrupted** | Restore `backups/2026-08-17-p0` via `safety:restore` into a fresh db, repoint | ~2 min restore + cutover | **Everything written since the backup** |
| **Legacy store listing removed** | **None** | — | Users cannot reinstall |

The last row is the only genuinely irreversible action in the whole migration.
**Do not unpublish `abhigyan-gurukul-app` under any circumstances** until the
four-part legacy retirement test passes.

---

## 7. Known hazards

Pre-existing conditions found during P0. **None were introduced by this work and
none are fixed by it** — P0 does not change behaviour. They are recorded so they
cannot be forgotten, and two have been defused.

### Quarantined scripts ⚠️

`scripts/make-storage-public.ts` and `scripts/migrate-urls-to-public.ts` are how
the current world-readable file state came to exist. The first bulk-applies
`file.makePublic()`; the second rewrites stored URLs from signed to permanent
public form.

Re-running either **after** P1's file isolation lands would undo it across every
tenant at once, with no error raised and no audit trail — a cross-tenant
exposure caused by a script that looks like a routine maintenance task.

They are **not deleted** — they document how historical URLs were produced, and
P1's backward-compatibility path has to keep resolving those URLs. Both now
refuse to run unless `I_UNDERSTAND_THIS_MAKES_FILES_PUBLIC=yes` is set. Verified:
both exit 1 with an explanation.

### Unguarded endpoints

16 of 463 have no authorization middleware. Most are legitimate — health checks,
the guest scholarship flow, the attendance webhook (which should be verifying a
signature instead), and login/register. Two deserve review before P1:

| Endpoint | Concern |
|---|---|
| `GET /api/automation/logs` | Streams logs with no authentication and no router-level guard. Verified genuinely unguarded, not a parser artifact. |
| `POST /api/auth/welcome-tutorial/complete` | Writes user state with no auth. |

### Carried from the audit

10-year JWTs (`expiresIn: '3650d'`, 3 sign sites) · `expiresIn: 'never'` in
`fileController` · `file.makePublic()` in the upload path · socket rooms
joinable without membership check · vendor credential hardcoded at
`EtimeService.ts:25` · CORS trusting all `*.vercel.app` / `*.railway.app` ·
Redis keys unprefixed with unbounded `delPattern` · cron running process-wide
with no org loop.

---

## 8. Environment configuration

87 variables in `cbt-exam-be/.env`. **Names only — values are never recorded in
this document, which is committed to git.**

`PORT` `MONGO_URI` `JWT_SECRET` `ADMIN_EMAIL` `ADMIN_PASSWORD` `CORS_ORIGIN`
`GOOGLE_APPLICATION_CREDENTIALS(_BASE64)` `GOOGLE_CLOUD_PROJECT`
`GOOGLE_CLOUD_LOCATION` `FIREBASE_*` (8) `YOUTUBE_DATA_API` `ETIMEOFFICE_*` (4)
`REDIS_URL` `GEMINI_API_KEY` `GROQ_API_KEY` `OLLAMA_*` (9) `PADDLE_OCR_URL`
`OCR_*` (6) `IMPORT_*` (4) `NVIDIA_*` (24) `AI_PROVIDER` `AI_QUEUE_NAME`
`AI_ENHANCER_*` (3) `ENABLE_PPT_FEATURES` `PPT_WORKER_*` (2) `VISION_MAX_PAGES`
`CONFIDENCE_*` (2) `BATCH_WORKER_CONCURRENCY` `PAGE_WORKER_CONCURRENCY`
`MAX_PAGES_PER_BATCH` `PDF_RENDER_DPI` `VL_*` (2) `MAX_DIAGRAMS_PER_PAGE`

> `GEMINI_API_KEY` and `GROQ_API_KEY` are still present although the AI layer
> migrated to NVIDIA. Dead credentials are worth revoking rather than leaving.

### To be added in P1

| Variable | Purpose |
|---|---|
| `TENANT_MODE` | `pinned` \| `claim` — selects deployment behaviour |
| `ORG_ID` | Org 001 id, `pinned` mode only |
| `TENANT_ENFORCEMENT` | `warn` \| `enforce` — the migration kill switch |
| `MONGO_DNS_SERVERS` | already read by `config/db.ts`; also used by safety tooling |

---

## 9. Legacy deployment (`api-legacy`) — planned, not yet built

| | |
|---|---|
| Source | `platform-core` @ tag `legacy/v1.0` |
| Config | `TENANT_MODE=pinned`, `ORG_ID=ORG_001` |
| Serves | `abhigyan-gurukul-app` v1.0.3+, Abhigyan web during transition |
| Tokens | legacy long-lived shape accepted and issued |
| Cron | **disabled** — scheduler runs only on the platform deployment |
| Platform routes | not exposed |
| Deploys | manual, tag-triggered, security patches only |

Holds a tenant context permanently pinned to Org 001. This is **not** a
default-org fallback: the context is always present, it is simply fixed by
configuration rather than derived from a token — so the fail-closed rule in §15
of the architecture is preserved exactly.

## 10. Platform deployment (`api-platform`) — planned, not yet built

| | |
|---|---|
| Source | `platform-core` @ `main` |
| Config | `TENANT_MODE=claim` |
| Serves | `client-platform-web`, `client-platform-app`, `platform-console` |
| Tokens | 15-min access + rotating refresh, three audiences |
| Cron | enabled — enumerates orgs, one context each |
| Deploys | automatic on merge, gated by the isolation suite |

**Both deployments share one database.** Forking it would mean every exam
Abhigyan runs on legacy is data the platform does not have, and reconciling live
academic records has no correct answer for conflicts.

---

## 11. Compatibility requirements

Non-negotiable for the whole migration:

1. All 463 endpoints keep their paths, request shapes and response shapes.
   Tenancy travels in the token claim, never in the URL.
2. `api-legacy` must be deployed in `pinned` mode **before** enforce mode is
   enabled on `api-platform`. Reversed, the legacy app's writes fail against a
   schema that now requires a field its build does not set.
3. The legacy app's login body does not change. Org 001 is resolved server-side
   from configuration.
4. Existing file URLs must keep resolving. New uploads use tenant-scoped paths;
   old objects resolve through `FileMetadata`.
5. No breaking change ships without a matching entry here and a rollback.

**Definition of breaking** — existing app cannot log in · exam cannot start ·
exam cannot submit · results change · question bank fails · attendance fails ·
files become inaccessible · notifications fail · web functionality disappears ·
data becomes inaccessible · APIs return incompatible responses · users must take
unexpected action. **If any occurs: stop, diagnose, roll back.**

---

## 12. Open items blocking P1

| # | Item | Needed for |
|---|---|---|
| 1 | Confirm Railway/Vercel are serving the tagged commits | P1 step 3 — the `legacy/v1.0` pin must match reality |
| 2 | Approve pushing tags to `origin` | Durability of the baseline |
| 3 | Platform name + domain convention | Deployment hostnames |
| 4 | `abhigyan-gurukul-main` Firestore paths — retire, freeze or leave? | Its writes bypass every tenant guard |
| 5 | Abhigyan's immovable calendar dates | Scheduling the backfill and cutover |
| 6 | Decide on `GET /api/automation/logs` | Fix in P1 or accept |

---

## Phase log

| Phase | Date | Outcome |
|---|---|---|
| **P0 — Safety** | 2026-08-17 | ✅ 4 repos tagged · 87 MB / 226,963 doc backup taken · **restore verified by count and fingerprint** · 463-endpoint API contract captured · 2 hazard scripts quarantined · `backups/` git-ignored · guard test 10/10 · no production behaviour changed |
| **P1 step 2** | 2026-08-17 | ✅ Client consumption surface mapped: 158 of 385 routes are load-bearing on the legacy mobile app. 3 tool bugs found and fixed. 1 pre-existing dead-code defect recorded. No production behaviour changed. |
| **P1 tenancy** | 2026-08-17 | ✅ ALS context + global plugin shipped in warn mode · 55 models verified (54 scoped, 1 exempt, 0 missing) · Org 001 seed rehearsed on scratch, idempotent · API contract UNCHANGED · cron-disable regression caught and fixed before wiring · no production behaviour changed |
| **P1 worker/cron** | 2026-08-17 | ✅ forEachOrg with per-org failure isolation · both crons wrapped at the scheduling boundary · QueueService + BullMQ stamp orgId at enqueue and open a fresh context in the processor · standalone worker entrypoint registers tenancy · fallback proven: cron still runs when no Org documents exist · 24 tenancy checks green · API contract UNCHANGED |
