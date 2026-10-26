# Tenant enforcement rollout — platform runtime

Last reviewed 2026-10-17. Audience: whoever operates central-be and approves
production changes. Status: **prepared, not applied.** Production still runs
`warn`.

## What changes

`TENANT_ENFORCEMENT` decides how the tenancy plugin treats the platform runtime
(`/platform-api/*`, database `abhigyangurukul_console`):

| | `warn` (today) | `enforce` |
| --- | --- | --- |
| Reads with an organization | filtered to that organization | filtered to that organization (strictly: rows with no `orgId` are no longer visible to anyone) |
| Writes | stamped with `orgId` | stamped with `orgId` |
| A query with no organization and no named bypass | logged as `[tenancy:warn] unscoped <Model>.<op>` and **allowed** | **refused**: `TenantContextMissing`, the request fails with 500 |

Tenant-facing reads have been filtered under `warn` since the tenant-admin
hardening, so enforce mainly turns logged gaps into hard failures and hides rows
that carry no `orgId`.

## How it is set — one variable, platform only

Set `TENANT_ENFORCEMENT=enforce` on the Railway service. The platform runtime is
started with the operator's environment and applies it. The existing system
(`/api/*`, Abhigyan Gurukul) **deliberately ignores it**: at boot it blanks
`enforce` when no `ORG_ID` is pinned, and blanks all organization settings when
`TENANT_MODE=claim` (`src/core/tenancy/dataSource.ts`). Verified 2026-10-17: the
realm-separation suite, booted with `enforce`, swept 183 authenticated `/api`
GET routes as the existing admin with no refusal and no 5xx.

**Condition:** `ORG_ID` must stay unset on the service. With `ORG_ID` set, the
existing system would be pinned to that organization and enforce would apply to
it too.

## Evidence (isolated environment, 2026-10-17)

A local MongoDB on 127.0.0.1, throwaway JWT and encryption keys, a throwaway
Firebase identity, Redis disabled, and separate build/AI queue names. A guard
refused to start anything unless every one of those held. No production
database, Redis or queue was touched.

### Two-organization safety suites, final code

| Suite | `warn` | `enforce` | Notes |
| --- | --- | --- | --- |
| tenant-admin-isolation | 359/359 | 359/359 | runs both modes itself |
| public-registration | 70/70 | 70/70 | |
| parent-guardian | 68/68 | 68/68 | |
| organization-registration | 56/56 | 56/56 | |
| organization-finalization | 64/64 | 64/64 | |
| platform-onboarding | 46/46 | 46/46 | was 500 under enforce before fix F3 |
| custom-roles | 22/22 | 22/22 | |
| student-notifications | 46/46 | 46/46 | loopback `test` database |
| realm-separation | 55/55 | 55/55 | after a test fix (hard-coded database name) |
| agts | 152/152 | 152/152 | |
| platform-mfa | 45/45 | 45/45 | new |
| public-routes-tenancy (probe) | 19/19 | 19/19 | new; 9/14 in both modes before fixes F1–F2 |
| organization-application | 73/78 | 73/78 | **same in both modes**: the suite never sets the administrator password a later change made mandatory. Stale test, not a mode issue |
| org-deletion | 1/2 | 1/2 | **same in both modes**: stops at Firebase Storage cleanup (`invalid_grant`), because the isolated environment has no real Firebase credentials by design |
| two-org-isolation | not run | not run | needs a restored production copy with Org 001 seeded and backfilled |

Every failure that remains is identical under `warn` and `enforce`, and no
enforce log contains `TenantContextMissing` other than the probe's intended
refusal of an organization-less guest write.

### Defects found and fixed

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| F1 | High | On the platform runtime, an unauthenticated request with **no organization hint** to `GET /api/scholarship/tests`, `/api/class-requests/options` or `/api/auth/public-student-batch-config` ran unscoped and returned **every organization's** tests, subjects and batches together. Same under `warn` (today) and `enforce`. | Allowlist entries that serve tenant data are flagged `tenantData`; in claim mode (platform only) such a request with no resolvable organization gets `400 ORG_REQUIRED`. With `X-Org-Id` or a known Host nothing changes. The existing system is unaffected. |
| F2 | **Critical** | The batch-config read first runs the default merge rule ("Advanced" + "Basic" → "Advanced/Basic"). With no organization it ran unscoped: one anonymous GET **deleted other organizations' batches, renamed their students' and schedules' batch, and created an unattributed batch.** Reproduced under `warn` and `enforce`. Reachable in production today on the platform runtime if any organization has batches with those names. | Superseded 2026-10-17 by the batch-ownership rule (see below): the platform runtime never runs the merge at all, with or without an organization. F1 also stops the route earlier. |
| F3 | High (enforce blocker) | Console organization detail (`GET /api/platform/orgs/:id`) returned 500 under enforce: the batch read had an explicit `orgId` filter but no tenant context. | An explicit organization is read inside a named bypass (`config:read-org-batches`). Every caller passes an id from the principal or platform staff, never from the request. |
| F4 | Low | `GET /api/scholarship/tests/:testId/share-link` (staff) returned 500 for a missing test. | 404. |

### Public routes that need an organization

All 32 allowlisted public routes were reviewed. Nine read or write tenant data
and are now refused without an organization on the platform runtime:

| Route | Why it needs an organization |
| --- | --- |
| `GET /api/auth/public-student-batch-config` | the organization's batches (and the merge, F2) |
| `GET /api/class-requests/options` | the organization's batches and subjects |
| `GET /api/scholarship/tests`, `GET /api/scholarship/tests/:testId` | the organization's tests |
| `POST /api/scholarship/attempts` | starts an attempt on an organization's test |
| `GET /api/agts/tests`, `GET /api/agts/tests/:ref`, `POST /api/agts/register` | AGTS papers and registrations belong to an organization |
| `POST /api/auth/public-register` | validates the chosen batch against the organization's batches and lists them in its error |

The rest need no organization: sign-in and registration resolve it from the
account, invite, policy or token; per-attempt and result routes are authorised
by an unguessable key or token naming exactly one record; health checks read no
data. Both platform clients already send `X-Org-Id` on unauthenticated calls
when they know the institute (`client-platform-web/src/lib/api.ts`,
`client-platform-app/lib/api.ts`). A page on a generic domain that does not
know its institute will now see `ORG_REQUIRED` instead of a mixed list.

### Not verified here

- **Background work under enforce.** Queue workers (app builds, AI/PPT,
  organization deletion) and crons open their own scopes in code
  (`runWithTenant` / `withoutTenantScope`), but the isolated environment had no
  Redis, so the workers never ran. The production log review below covers this.
- **Production data.** Rows with no `orgId`, an `orgId` naming no organization,
  or an `orgId` stored as an ObjectId instead of a string all disappear from
  scoped reads under enforce. Only the scan below can say how many exist.

## Rollout

Each step needs the owner's approval where marked.

1. **Deploy the fixes (still `warn`).** Approval: deploy. Afterwards, platform
   logs should show `ORG_REQUIRED` only for callers with no institute.
2. **Back up the platform database** and verify the restore
   ([backup-and-restore.md](backup-and-restore.md)). Approval: production read.
3. **Scan for unattributed rows, read-only.** Approval: production read.
   ```bash
   npx ts-node --transpile-only scripts/safety/orgid-scan.ts --target platform --out orgid-scan-$(date +%F).json
   ```
   It issues only `listCollections`, `countDocuments` and `aggregate`
   (`$match`/`$group`) plus a projection of `orgs`; it reads no document
   contents beyond `orgId` values. Correctness is checked by
   `scripts/safety/orgid-scan.test.ts` against a seeded fixture (9/9).
   Go criteria: `UNATTRIBUTED 0`, `ORPHANED 0`, and no mixed `orgId` types in a
   scoped collection, or a written decision for each exception.
4. **Fix what the scan finds** with a backfill rehearsed on a restore copy
   first. Approval: production write.
5. **Read the warn-mode signal.** In the platform runtime's Railway logs, search
   `[tenancy:warn] unscoped` over at least 7 days of normal traffic. Each
   distinct `<Model>.<op>` is a code path that will fail under enforce, so each
   must be fixed or given a named bypass. Go criterion: none left.
6. **Flip.** Approval: production configuration. Set
   `TENANT_ENFORCEMENT=enforce` on Railway and redeploy. Confirm `ORG_ID` is
   unset.
7. **Watch for 48 hours:** `GET /api/health/ready` (`platformRestarts` stays 0),
   structured error lines (`"level":"error"`) containing `TenantContextMissing`,
   and the rate of `ORG_REQUIRED` responses.
8. **Rollback:** set `TENANT_ENFORCEMENT=warn` and redeploy. Enforce only filters
   reads and refuses unscoped queries; it changes no data, so rolling back
   restores the previous behaviour immediately.

## Batch ownership (2026-10-17)

Business rule: each organization owns and manages its own batches; batch
configuration is optional and organization-specific; the platform never
merges Abhigyan's default batches into another organization's data.

- `PLATFORM_DEFAULTS.batch.mergeRules` is now empty. Abhigyan's Advanced+Basic
  rule lives in `LEGACY_BATCH_MERGE_RULES` and `mergeAdvancedBasicBatchValues()`
  runs only in the existing system (`serviceRealm() === 'existing'`); on the
  platform runtime it returns before reading or writing anything, even if a
  stored policy names merge rules.
- Batch create/update accept only `name`, `classLevels`, `isDefault`,
  `description` (a body `orgId` is ignored); a duplicate name within the
  organization answers 409.
- Evidence: `scripts/safety/batch-ownership.e2e.test.ts` — 32/32 under `warn`
  and `enforce` (19/32 on the previously committed code), and 5/5 for the
  existing system with `--existing`, identical on the committed code.

