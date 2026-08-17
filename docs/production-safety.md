# Production Safety Record

**Living document.** Every implementation phase must update it before being
declared complete. It is the single place that answers *"if this goes wrong,
what do we go back to, and how do we know it worked?"*

| | |
|---|---|
| **Current phase** | P0 — Safety baseline |
| **Status** | ✅ Complete. Restore gate satisfied. |
| **Established** | 2026-08-17 |
| **Next phase** | P1 — Tenant foundation (blocked on decisions in *Open items*) |

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

**Work branch:** `phase/p0-safety` (branched from `main`). `main` is untouched.

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
