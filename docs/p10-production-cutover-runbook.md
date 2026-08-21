# P10 — Production cutover runbook

Prepared 2026-08-19. **Nothing in this document has been executed.** No
production data, index, deployment, environment variable or Storage ACL was
touched while writing it.

Every command below is real and has been run against scratch databases. The
production variants differ only in the `--production` flag, which each script
requires explicitly and refuses to infer.

---

## How to read this

| Marker | Meaning |
|---|---|
| **YOU** | Requires you. Either a credential/console I cannot reach, or an irreversible production action. |
| **CLAUDE** | I can prepare or run it — it touches no production. |
| **GATE** | Do not proceed past this until its verification is green. |

---

# STEP 1 — Verify current production state

**Everything in this step is YOU.** I have no access to Railway, Vercel, the
Firebase console or your DNS. I verified the *database* directly on 2026-08-19
and nothing else.

### What I established (evidence-based)

| Fact | Value | How |
|---|---|---|
| Production DB | `abhigyangurukul` on `ac-x3s6nbn-shard-00-00.guvhko7.mongodb.net` | direct connection |
| `orgs` / `plans` / `subscriptions` | **0 / 0 / 0** | `countDocuments` |
| Tenancy collections | `classlevels`, `orgpolicies`, `roles`, `platformusers` — **absent** | `listCollections` |
| `users` / `batches` / `exams` | 158 / 12 / 8 | `countDocuments` |
| `appsettings` indexes | `_id_`, **`key_1`** (legacy global, still present) | `indexes()` |
| Firebase credentials (local `.env`) | **invalid** — `invalid_grant: Invalid JWT Signature` for Storage, Firestore *and* Auth | live probe |

The last row is about **my machine's key**, not production. It does mean I could
not verify anything Firebase-side.

### What YOU must verify before anything else

1. **Deployed backend commit.** There is no version endpoint. Railway's deploy
   log is the only source. Record the SHA.
2. **Deployed frontend commit(s)** — for `cbt-exam` and any other live web app.
3. **Full production environment variable dump** from Railway. Specifically
   confirm the current values of: `MONGO_URI`, `JWT_SECRET`, `REDIS_URL`,
   `FIREBASE_*`, `CORS_ORIGIN`, `ENABLE_CRON`, `PORT`, and whether **any**
   `TENANT_*` variable is set (it should not be — the code defaults are what
   production currently runs on).
4. **Redis**: URL, whether it is shared, and its eviction policy. The fixture
   logs warned `volatile-lru`; entitlement caching wants `noeviction`.
5. **Firebase**: project id, storage bucket, and whether the service-account key
   in production differs from the local one (mine is stale).
6. **API hostname** and **application hostname(s)**, and which DNS records point
   where.
7. **Deployment services**: how many Railway services, how many replicas each.
   More than one replica today means cron is already running twice.
8. **JWT config**: confirm the 10-year expiry is what production issues.

> Do not start Step 2 until 1–8 are written down. Several later steps
> (`ORG_ID`, `CORS_ORIGIN`, cron placement) are derived from them.

---

# STEP 2 — Backup

**GATE.** No write happens before a verified restore exists.

### MongoDB — **YOU run, CLAUDE prepared**

```bash
# 1. Full logical backup (reads only)
npx ts-node scripts/safety/db-backup.ts --out backups/prod-YYYY-MM-DD

# 2. Restore into an ISOLATED database (never the production name)
npx ts-node scripts/safety/db-restore.ts \
  --from backups/prod-YYYY-MM-DD \
  --scratch-suffix restore_YYYY_MM_DD

# 3. Verify the restore — counts, content fingerprints, relationships
npx ts-node scripts/safety/verify-restore.ts \
  --from backups/prod-YYYY-MM-DD \
  --scratch-suffix restore_YYYY_MM_DD
```

If your machine cannot resolve Atlas SRV records, prefix every script with the
DNS preloader (this is required on the current dev machine):

```bash
node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
  scripts/safety/db-backup.ts --out backups/prod-YYYY-MM-DD
```

**Verification:** `verify-restore` performs 22 checks including TTL-aware
shrinkage detection. All must pass.
**Failure:** any count mismatch not explained by a TTL index → stop, do not
proceed.
**Also:** confirm Atlas PITR is enabled and note the retention window. The
logical backup is the thing you can restore *elsewhere*; PITR is the thing that
saves you in place.

### Firebase Storage — **YOU**

There is **no backup today**. Before the storage work in Step 12:

```bash
# Inventory: how many objects, how much data, and how many are public
gsutil du -s gs://<bucket>
gsutil ls -r gs://<bucket>/** | wc -l
gsutil iam get gs://<bucket>            # bucket-level policy
gsutil acl get gs://<bucket>/<sample>   # object-level, spot check
```

Then an independent copy: `gsutil -m rsync -r gs://<bucket> gs://<backup-bucket>`
(or to local/other-cloud). **Rehearse a restore of at least one object** before
counting it as a backup.

**Ownership gaps to expect:** every object uploaded before P9A lives outside
`organizations/{orgId}/` and has no owner recorded. Step 12 covers the backfill.

---

# STEP 3 — Create Org 001

**YOU run. Reversible** (a single document nothing reads yet).

```bash
# Rehearse first, on the restore
npx ts-node scripts/safety/seed-org-001.ts --scratch-suffix restore_YYYY_MM_DD

# Production
npx ts-node scripts/safety/seed-org-001.ts --production
```

Idempotent — running it twice is a no-op.

**What it creates:** one `Org` document for Abhigyan Gurukul. It prints the
`_id`. **That id is the `ORG_ID` for api-legacy** — record it.

**Deliberately NOT created:**

| Thing | Why |
|---|---|
| Subscription | An organization with no subscription resolves to **every** module. Creating one would gate Abhigyan behind a plan it never agreed to. |
| OrgPolicy | Absent policy resolves to `PLATFORM_DEFAULTS`, which is a transcription of Abhigyan's current behaviour. Writing one proves less and risks drift. |
| Branding | Absent branding renders exactly what ships today. |
| ClassLevel / Subject / OrgRoom rows | Absent configuration falls back to the legacy constants per section. |

Optionally, to make Abhigyan's configuration explicit rather than inherited:

```bash
npx ts-node scripts/safety/seed-org-config.ts --production    # classes, subjects, rooms
```

This is **not required** for cutover and changes resolved values from
"fallback" to "configured" — do it only if you want them editable in the console.

**Users and roles:** existing users need no change. `provisionSystemRoles` can
be run later through the console; until a user has `roleIds`, the legacy-role
bridge gives them exactly their current permissions.

**Verification:** `db.orgs.countDocuments()` returns 1; the slug is `abhigyan`.
**Failure:** more than one Org, or a slug mismatch → delete and re-run.
**Rollback:** delete the single document. Nothing reads it yet.

---

# STEP 4 — Production backfill

**YOU run. GATE. This is the largest write.**

```bash
# 1. DRY RUN (default — nothing is written without --execute)
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production

# 2. Execute
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production --execute

# 3. Verify
npx ts-node --transpile-only scripts/safety/backfill-verify.ts --production
```

**Rehearsal record:** 225,571 documents in 266 s, run four times on
`abhigyangurukul_restore_2026_08_17` — dry-run, execute, idempotent re-run
(0 needed), undo (full revert), and a SIGKILL at 12 s followed by a resume that
completed cleanly.

**Properties, as implemented:**

- **Idempotent** — only documents *missing* `orgId` are touched. A second run
  reports 0.
- **Resumable** — no cursor state to lose; re-running continues.
- **Never overwrites ownership** — a document that already has `orgId` is
  skipped, so a partial run followed by other writes cannot be corrupted.
- **Never touches `orgs`** — the collection is excluded.
- **Reversible** — `--undo` unsets exactly the field it set.

**Verification:** `backfill-verify --production` must report zero documents
missing `orgId` in every tenant collection, and the counts must match the
pre-backfill inventory.

**Failure conditions:** any collection with remaining unbackfilled documents; any
count that changed; any document whose `orgId` is not Org 001.

**Rollback:**
```bash
npx ts-node --transpile-only scripts/safety/backfill-org.ts --production --undo
```
If `--undo` itself fails, restore from the Step 2 backup.

> Run this during a low-traffic window. It is safe concurrently — writes during
> the backfill land with `orgId` already stamped by the plugin under `warn` —
> but a quiet window makes verification unambiguous.

---

# STEP 5 — Deploy api-legacy

**YOU deploy.** Configuration is `deploy/api-legacy.env.example`, already in the
repo and annotated.

**Copy the full current production environment, then apply:**

```
TENANT_MODE=pinned
ORG_ID=<the id printed by Step 3>
TENANT_ENFORCEMENT=warn
ENABLE_CRON=false
PPT_WORKER_EMBEDDED=false
ENABLE_ATTENDANCE_WEBHOOK=false
```

Everything else — `MONGO_URI`, `JWT_SECRET`, `REDIS_URL`, `FIREBASE_*`,
`CORS_ORIGIN`, `ETIMEOFFICE_*` — keeps its current production value.

**`ORG_ID` must be set before deploy.** With `TENANT_MODE=pinned` and no
`ORG_ID`, every request returns 503 `TENANT_NOT_CONFIGURED`. That is deliberate
— serving unscoped while calling itself pinned would be a lie — and it is
covered by `deployment-modes.test.ts`.

**Cron:** `ENABLE_CRON=false` here because cron will live on api-platform. Until
api-platform exists (Step 9), **leave cron enabled on the current deployment**
or attendance sync and EOD reminders stop. Sequence it deliberately.

### Pre-deploy verification — **CLAUDE**
```bash
npm run safety:all          # 12 suites, no database needed
npm run safety:api-check    # contract unchanged at 487 endpoints
node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only \
  scripts/safety/legacy-regression.test.ts --scratch-suffix restore_YYYY_MM_DD
```

### Post-deploy verification — **YOU**
1. `GET /api/health` → 200 (not 503; a 503 means `ORG_ID` is unset).
2. Log in on the installed mobile app **and** the web app.
3. Create one throwaway record (a batch), then confirm in Atlas that the new
   document carries `orgId` = Org 001. **This is the check that matters** —
   it proves the pinned context reaches the write path.
4. Confirm no `[tenancy:warn] unscoped` floods in the logs on the critical paths.

**Failure:** 503s, login failures, or a new document written without `orgId`.
**Rollback:** redeploy the previous commit, or set `TENANT_ENFORCEMENT=off`
(the middleware becomes inert immediately, no redeploy of code required).

---

# STEP 6 — Observation

**Minimum 7 days**, covering at least one full academic week and one attendance
cycle. Two weeks is better if an exam cycle falls inside it.

| Area | What to watch | Failure signal |
|---|---|---|
| Login | Success rate, both clients | Any increase in 401s |
| Users | Create / update / approve | Writes missing `orgId` |
| Exams / Questions | Create, publish, question bank | 403s, empty pickers |
| Attempts | Start, answer, submit, timer | Submissions failing or double-graded |
| Results | Publication, student visibility | Marks visible before publish |
| Attendance | Daily eTimeOffice sync | A missed day, or duplicate records |
| Scheduling | Timetable, room allocation | Empty room/batch pickers |
| Files | Upload and download both work | Broken images, 403 on download |
| Notifications | Delivery | Silence where alerts are expected |
| Queues / cron | Ran exactly **once** per schedule | Duplicate side effects |
| Errors | Rate vs the pre-cutover baseline | Any sustained increase |
| Latency | p95 vs baseline | Sustained regression |

**Success criteria:** error rate and p95 within normal variance of the
pre-cutover baseline; every new document carrying `orgId`; zero
`[tenancy:warn] unscoped` on login, attempt submission, or attendance sync.

**Failure:** any of the above → `TENANT_ENFORCEMENT=off`, investigate, and do
not proceed to Step 7.

---

# STEP 7 — Enforcement

**YOU. GATE. The riskiest single change in the plan.**

`TENANT_ENFORCEMENT=enforce` on **api-platform only**. api-legacy stays `warn`
for the whole migration — it is the thing being protected, not the thing being
migrated.

**Every one of these must be true first:**

1. Step 4 backfill complete, `backfill-verify --production` green.
2. Zero documents missing `orgId` in any tenant collection.
3. `legacy-regression` green against a **fresh** restore taken *after* the
   backfill.
4. api-legacy verified writing documents with `orgId` (Step 5 check 3).
5. Observation period complete with no failure signals.
6. `npm run safety:isolation` and `safety:indexes` green.
7. Step 8 compound indexes **built** (but legacy ones not yet dropped).
8. Rollback rehearsed: you have set `TENANT_ENFORCEMENT=off` on a staging copy
   and watched it take effect.

**Why the order is not negotiable:** filtering reads before every document
carries an `orgId` matches nothing and blanks every screen.

**Verification after the flip:** read paths still return data; writes still
succeed; no `TenantContextMissing` errors on any request path.
**Rollback:** `TENANT_ENFORCEMENT=off`. Instant, no redeploy, and the mechanism
is deliberately preserved for exactly this.

---

# STEP 8 — Index migration

**YOU. After Step 4, before or alongside Step 7.**

Seven legacy global indexes. Each already has a compound replacement **declared
in its model**, which Mongoose builds automatically on connect.

| Collection | Legacy index | Replacement | What it unblocks |
|---|---|---|---|
| `batches` | `name_1` | `{orgId, name}` | Two institutes with a "NEET" batch |
| `appsettings` | `key_1` | `{orgId, key}` | Two institutes with their own time slots |
| `attendancerules` | `role_1` | `{orgId, role}` | Per-institute role attendance rules |
| `holidays` | `date_1` | `{orgId, date}` | Two institutes, same holiday date |
| `roomallocations` | `date_1` | `{orgId, date}` | Two institutes seating on one date |
| `filemetadatas` | `storagePath_1` | `{orgId, storagePath}` | Per-org storage paths |
| `attendances` | `idempotencyKey_1` | `{orgId, idempotencyKey}` | Two institutes with punch code "101" |

**Order — enforced by the script, not by discipline:**

```bash
# 1. Confirm the compound replacements exist (they build on app start)
#    The script REFUSES to drop a legacy index whose replacement is missing.

# 2. Rehearse on the restore
npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts \
  --scratch-suffix restore_YYYY_MM_DD

# 3. Production
npx ts-node --transpile-only scripts/safety/drop-legacy-global-indexes.ts --production
```

It refuses **per collection**, not per run, so one lagging replacement cannot
block the others.

**Run only after the backfill.** A compound `{orgId, x}` index on unbackfilled
data enforces nothing — every row has `orgId: null` and they collide exactly as
before.

**Verification:** `db.<collection>.getIndexes()` shows the compound present and
the legacy absent.
**Failure:** a refusal (replacement missing) → start the app to build it, re-run.
**Rollback:** recreate the legacy index manually. It is a plain
`createIndex({ key: 1 }, { unique: true })` — but note it will **fail** if
duplicate-across-tenants rows already exist, which is the whole point.

### Not migrated, deliberately

`User.email_1` stays globally unique. Login happens before any organization is
known, so a globally unique address is what makes `User.findOne({ email })`
unambiguous at the one moment no tenant context exists. The compound
`{orgId, email}` exists alongside it for the day you support the same person at
two institutes — dropping the global one is a **product decision**, not a bug fix.

---

# STEP 9 — Deploy api-platform

**YOU deploy.** Configuration is `deploy/api-platform.env.example`.

```
TENANT_MODE=claim
ORG_ID=                      # blank, deliberately — no fallback organization
TENANT_ENFORCEMENT=warn      # until Step 7 conditions are met
ENABLE_CRON=true             # cron lives here, and ONLY here
PPT_WORKER_EMBEDDED=true
ENABLE_ATTENDANCE_WEBHOOK=false
```

Shared with api-legacy and **must be identical**: `MONGO_URI` (the same
database — Abhigyan's data *is* Org 001's data), `JWT_SECRET` (or tokens minted
by one are rejected by the other), `REDIS_URL`, `FIREBASE_*`.

**New:** `CORS_ORIGIN` must list the new client hosts explicitly. Do not rely on
a `*.vercel.app` wildcard — that trusts every preview deployment on a public
platform.

**Cron handover:** the moment this deploys with `ENABLE_CRON=true`, disable cron
on the old deployment in the same window. Both running means Abhigyan gets two
attendance syncs and two EOD reminders a day, and duplicate side effects look
like data corruption.

### Verification before onboarding Org 002 — **YOU**
1. `GET /api/health` → 200.
2. Log in as an Abhigyan user against api-platform; `GET /api/me/context`
   returns `organization.name = "Abhigyan Gurukull"` — proving the `orgId`
   claim resolves.
3. Confirm cron ran exactly once, on api-platform only.

---

# STEP 10 — Platform console

**BLOCKED — see blockers below.** The console cannot be operated in production
as it stands.

Once unblocked, configuration is: `NEXT_PUBLIC_PLATFORM_API` → api-platform's
hostname; deploy privately (the repo already sets noindex / DENY / no-referrer).

Verify: staff login, organization list, org detail (6 tabs), plan CRUD,
subscription change, module list, audit log, and the onboarding wizard.

---

# STEP 11 — Onboard Org 002

**YOU, through the console** (this is the flow real customers will use).

```
Console → Onboard → name, slug, admin name/email/password, plan
```

Eight idempotent steps run server-side: Org, config, policy, roles,
subscription, entitlement, admin user, role assignment.

### Isolation verification — **CLAUDE can run these**

```bash
npm run safety:two-org -- --scratch-suffix restore_YYYY_MM_DD   # 9 checks
npm run safety:platform-e2e -- --scratch-suffix restore_YYYY_MM_DD
npm run safety:web          # 109 checks, two tenants, one build
npx ts-node --transpile-only scripts/safety/client-platform-app.e2e.test.ts   # 99 checks
```

These already prove, against real APIs: separate users, roles, classes,
subjects, rooms, batches, policies, branding, modules, and that neither
organization's exams, questions, notifications or question banks are visible to
the other — on web *and* mobile, from one build.

**Org 001 must remain unchanged throughout.** Re-run `legacy-regression` after
Org 002 exists.

---

# STEP 12 — Firebase Storage

**YOU. Independent of the database cutover** — can run before or after.

1. **Verify signing works in production.** My local key is stale, so this is
   unproven: upload one file, confirm `getSignedUrl` returns a working URL and
   that the object is **not** publicly readable.
2. **Verify private upload** — `gsutil acl get` on a new object shows no
   `allUsers`.
3. **`FileMetadata` ownership backfill** — pre-P9A objects have no metadata row.
   Write one per existing file with its `orgId`, so legacy objects become
   attributable. *(Script not yet written — see remaining work.)*
4. **Compound index** — `filemetadatas` is in the Step 8 table.
5. **Legacy public files** — only after (3), and only after confirming no
   client renders a raw stored URL outside the serializer, flip ACLs to private
   in batches with a rollback list.
6. **Rules into version control** — `firestore.rules` and `storage.rules` exist
   only in the Firebase console today. Export, commit, then deploy from source.
7. **Backup** — Step 2.

---

# STEP 13 — Authentication (documented, not implemented)

The 10-year token stays as-is this phase, by instruction. The production-safe
migration, for a later phase:

1. **Add refresh tokens** — `signRefreshToken` already exists (30 d) and
   `tokenVersion` is already on the `User` model. Add the refresh endpoint and
   short-lived access tokens **as an addition**, changing nothing for existing
   tokens.
2. **New clients adopt it first** — `client-platform-app` and
   `client-platform-web` can refresh; ship them on short tokens.
3. **Revocation** — bump `tokenVersion` to invalidate a user's outstanding
   tokens; the platform side already does this on staff deactivation.
4. **The installed app is the constraint.** `abhigyan-gurukul-app` v1.0.3 has no
   refresh logic and some phones will never update. Shortening the legacy expiry
   logs those users out permanently with no in-app recovery. api-legacy must
   keep issuing long tokens until that install base is gone or force-updated.
5. **Then** shorten the legacy expiry, with a deprecation window and telemetry
   on how many old-token clients remain.

---

# STEP 14 — Rollback

| What | How | Speed | Notes |
|---|---|---|---|
| **Tenant enforcement** | `TENANT_ENFORCEMENT=off` | Seconds, no redeploy | Middleware becomes inert. **Preserved deliberately — do not remove this escape hatch.** |
| **api-legacy** | Redeploy previous commit | Minutes | Or unset `TENANT_MODE`, which restores exact pre-migration behaviour |
| **api-platform** | Stop the service | Minutes | No existing client points at it |
| **Backfill** | `backfill-org.ts --production --undo` | ~5 min | Unsets exactly the field it set |
| **Database** | `db-restore.ts` from Step 2 | Hours | Last resort; loses writes since backup |
| **Index migration** | Recreate legacy index manually | Minutes | **Will fail if cross-tenant duplicates now exist** |
| **Storage** | Restore ACLs from the rollback list | Varies | Requires (5) to have recorded what it changed |

**The one-way doors:** dropping a legacy index once duplicates exist, and
flipping Storage ACLs without a recorded list. Everything else is reversible.

---

# STEP 15 — Consolidated checklist

| # | Phase | Action | Prerequisite | Verification | Failure | Rollback |
|---|---|---|---|---|---|---|
| 1 | PRE | Record deployed commits, env, hosts, replicas | — | Written down | Unknown state | — |
| 2 | PRE | Confirm Atlas PITR + retention | 1 | Console shows enabled | Not enabled | — |
| 3 | PRE | `safety:all` green | — | 12 suites pass | Any fail | Fix first |
| 4 | BACKUP | `db-backup --out` | 1 | Files written | Error | — |
| 5 | BACKUP | `db-restore --scratch-suffix` | 4 | Restore completes | Error | — |
| 6 | BACKUP | `verify-restore` | 5 | 22 checks pass | Mismatch | **STOP** |
| 7 | BACKUP | Storage inventory + rsync + restore rehearsal | 1 | One object restored | Error | — |
| 8 | ORG 001 | `seed-org-001 --scratch-suffix` | 6 | 1 Org | Error | Delete |
| 9 | ORG 001 | `seed-org-001 --production` | 8 | 1 Org, id recorded | Error | Delete |
| 10 | BACKFILL | `backfill-org --production` (dry run) | 9 | Plan looks right | — | — |
| 11 | BACKFILL | `backfill-org --production --execute` | 10 | Completes | Partial | `--undo` |
| 12 | BACKFILL | `backfill-verify --production` | 11 | 0 missing `orgId` | Any missing | `--undo` |
| 13 | DEPLOY | api-legacy with `ORG_ID` set | 12 | `/api/health` 200 | 503 | Previous commit |
| 14 | DEPLOY | Login both clients | 13 | Success | Failure | Rollback 13 |
| 15 | DEPLOY | New write carries `orgId` | 13 | Confirmed in Atlas | Missing | Rollback 13 |
| 16 | OBSERVE | 7–14 days on the Step 6 table | 15 | Within baseline | Any signal | `ENFORCEMENT=off` |
| 17 | INDEX | Confirm compound indexes built | 12 | `getIndexes()` | Missing | Start app |
| 18 | INDEX | `drop-legacy-global-indexes --scratch-suffix` | 17 | Drops cleanly | Refusal | — |
| 19 | INDEX | `drop-legacy-global-indexes --production` | 18 | 7 dropped | Refusal | Recreate |
| 20 | ENFORCE | Fresh restore + `legacy-regression` | 12 | 32/32 | Any fail | **STOP** |
| 21 | ENFORCE | `TENANT_ENFORCEMENT=enforce` on api-platform | 16,19,20 | Reads+writes OK | Errors | `=off` |
| 22 | PLATFORM | Deploy api-platform | 21 | `/api/health` 200 | Error | Stop service |
| 23 | PLATFORM | Move cron; disable on old | 22 | Runs once | Twice | Re-enable old |
| 24 | PLATFORM | `/api/me/context` resolves Org 001 | 22 | Name correct | Null | Rollback 22 |
| 25 | PLATFORM | **Create first platform staff account** | 22 | Can log in | **BLOCKED** | — |
| 26 | PLATFORM | Deploy platform-console | 25 | Console loads | Error | Stop service |
| 27 | ORG 002 | Onboard via console | 26 | 8 steps complete | Any fail | Delete Org |
| 28 | ORG 002 | Isolation suites | 27 | web 109, mobile 99 | Any fail | **STOP** |
| 29 | ORG 002 | `legacy-regression` again | 27 | 32/32 | Any fail | **STOP** |
| 30 | STORAGE | Verify signing + private upload | 22 | Signed URL works | Error | — |
| 31 | STORAGE | `FileMetadata` ownership backfill | 30 | Rows exist | Error | Delete rows |
| 32 | STORAGE | Legacy ACL flip, batched | 31 | Sampled objects private | Broken render | Restore ACLs |
| 33 | STORAGE | Rules into version control | — | Committed | — | — |

---

# ## NOT READY FOR PRODUCTION CUTOVER

Steps 1–8 (through index migration) **are** ready — the tooling is written,
rehearsed and verified. What is not ready is the platform half.

### Concrete blockers

1. **No platform login endpoint.** There is no `POST /api/platform/login`
   anywhere in the 487-endpoint contract. `platform-console` expects a token to
   already be in `sessionStorage`; during P5 those were minted by a test script.
   Nobody can sign in to the console in production.

2. **No way to create the first platform staff account.** `PlatformUser` is
   created in exactly two places: `POST /api/platform/staff`, which itself
   requires an authenticated platform user with `staff.manage`, and
   `mint-platform-tokens.ts`, which creates `@platform.test` accounts carrying a
   test marker. That is a bootstrap deadlock.

   *Both are small — one route and one seed script — but neither exists, and
   together they block Steps 10, 11 and every future onboarding.*

3. **Production deployment state is unverified.** I could not reach Railway,
   Vercel, Firebase or DNS. Step 5 depends on knowing the current environment
   exactly, and Step 9's cron handover depends on the current replica count.

4. **Firebase credentials unproven.** The local service-account key fails
   `invalid_grant` for Storage, Firestore *and* Auth, so signed URLs — the
   mechanism P9A's privacy rests on — have never been executed against a real
   bucket.

Blockers 1 and 2 are code. 3 and 4 are things only you can check.

---

### Manual actions required from you

- Step 1 in full — deployed commits, environment, hosts, replicas, Redis policy.
- Every `--production` command. I will not run one.
- All Railway / Vercel / Firebase console operations.
- The enforcement flip, the index drops, the Storage ACL flip.
- Confirm production Firebase credentials work.

### Commands and scripts I can prepare or run

- All scratch rehearsals against `*_restore_*` databases.
- `safety:all` (12 suites), `legacy-regression`, `two-org`, `platform-e2e`, and
  the web/mobile isolation suites.
- **The two missing pieces**, if you want them: a platform login route
  (email + password → platform-audience token, mirroring the existing
  `platformAuthMiddleware` contract) and a `bootstrap-platform-owner.ts` seed
  script guarded like `seed-org-001`.
- A `FileMetadata` ownership backfill script for Step 12.3.

### Production actions I must not execute

Any `--production` flag; any deploy; the enforcement flip; any index drop; any
Storage ACL or rules change; any GitHub or remote git operation.

### Exact migration order

`1–3 → 4–7 → 8–9 → 10–12 → 13–15 → 16 → 17–19 → 20–21 → 22–24 → [blockers] → 25–29 → 30–33`

Storage (30–33) is independent and may run in parallel with 16.

### Remaining product / commercial work

Out of scope here, and unchanged: **billing** (no payment gateway exists
anywhere — `Plan.price` is a display field), **usage metering** (`UsageRecord`
has no writer), **per-tenant monitoring/alerting**, **tenant data export and
deletion**, and the **Firestore decision** for `abhigyan-gurukul-main`.
