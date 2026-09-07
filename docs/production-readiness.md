# Production readiness — P8 assessment

Assessed 2026-08-19, at the end of P8. This is the state of the platform as a
foundation for paying B2B customers, not a plan for reaching it.

Four categories, used strictly:

| | meaning |
|---|---|
| **READY** | Works, is tested, and needs nothing before a customer uses it. |
| **BLOCKED** | A customer would hit a real problem. Must be fixed before onboarding a tenant that touches it. |
| **DEPLOYMENT-GATED** | Correct in code and verified on scratch data; needs a supervised production operation. |
| **OPTIONAL** | Worth doing. Nothing breaks without it. |

---

## READY

### Tenant isolation — the Mongoose layer
Every one of 66 models carries the tenancy plugin, proven by
`verify-tenant-coverage` loading the real application rather than trusting an
import convention. All four `$lookup`s are classified and gated by
`lookup-audit`. `safety:all` fails on an unclassified addition.

### Tenant isolation — beyond the plugin
`isolation-audit` classifies all 19 sites where tenancy is decided outside
Mongoose middleware: raw driver access, cache keys, socket rooms, background
work, deliberate bypasses and external stores. A new one fails the build.

Three genuine leaks were found and fixed in P8, on top of three in P6/P7:

| | what it was |
|---|---|
| `practiceTestService` | `$sample` over the shared per-class collections — a student could be served **another institute's questions**. Four `$match` stages now scoped. |
| `SocketService` | `class:11` is not globally unique; one room was a broadcast channel between organizations. Now namespaced by org. |
| `examController` / `attemptService` | seven unscoped reads of the per-class question banks. |

Verified and deliberately **not** changed: the response cache (keyed by a
globally unique user id), the extraction cache (keyed by content hash — a pure
function of its input), object-storage paths (embed ObjectIds), and every cron,
queue and worker (each already opens its own context).

### Authorization
- **Audiences** hold in both directions, proven against the running API by
  `token-audience.test.ts` (9 checks). A platform token on a tenant route was
  previously refused only by accident of storage layout; it is now a boundary.
- **Legacy tokens** — no `aud` claim — are still accepted, so no installed app
  is logged out.
- **RBAC**: 79 permissions, closed vocabulary, custom roles, legacy-role bridge.
  60 checks + 22 end-to-end.
- **Entitlements are now enforced server-side.** `requireModule` was wired to
  zero routes; it now guards 23 router groups covering 234 endpoints. Verified
  live: ABC is refused `/api/ai` and `/api/admin/firebase`; Abhigyan is
  unaffected. It fails open with no context and on resolution failure, so it
  cannot brick a tenant or turn a Redis outage into a dead platform.

### Organization configuration
Class levels, subjects, rooms, batches and policy resolve per organization with
per-**section** fallback to the legacy constants. 29 checks. Absent
configuration means "as before", never "nothing".

### Web platform
115/115 two-tenant checks against real APIs, one build, no source or
environment change between tenants. 78 pure-logic checks.

### Mobile platform
106/106 two-tenant checks against real APIs on the shared bundle, 64
pure-logic checks, **and validated on a native Android device** (see below).

### Documents and exports
Generated question papers, Excel exports and the PDF template take the
institute name, address and logo from organization branding, falling back to
Abhigyan's constants so its output is byte-identical.

### Shared client core
`@platform/client-core` holds one definition of the tenant payload types, the
access rules and the branding arithmetic. Both clients consume it; both build.

---

## BLOCKED

### 1. Firestore is single-tenant
`db.collection('Users')` and `db.collection('studentLeaves')` are global
collections with no organization dimension. A second tenant running Firebase
Sync would write into the collection Abhigyan reads.

**Mitigated, not solved.** The routes now require the `integrations` and
`attendance` modules, which no plan but Abhigyan's grants — so this is safe
*today*, and becomes a live defect the moment a tenant buys either.

Fixing it is a migration (per-org collections, or an `orgId` field plus scoped
queries across four files), not a patch.

**Blocks:** onboarding any tenant needing Firestore-backed attendance or user
sync.

### 2. The 10-year token
`TOKEN_TTL.legacy` is 3650 days and login still issues it. Shortening it logs
out every installed app, because the shipped client has no refresh logic. The
new mobile client could refresh; the legacy one cannot.

**Blocks:** nothing operationally, but it is the platform's largest standing
security weakness and should be closed before the customer base grows.

### 3. Public Firebase Storage rules
Carried from the P1 security audit and unchanged.

**Blocks:** any tenant whose materials are confidential.

---

## DEPLOYMENT-GATED

| Item | State |
|---|---|
| **Tenant enforcement** (`TENANT_ENFORCEMENT=enforce`) | Code is ready and 47 tenancy checks cover it. Requires the backfill to complete first. Under `warn`, reads are unfiltered — which is why the explicit scoping above matters. |
| **orgId backfill** | Rehearsed four times on scratch (225,571 documents, 266s), including a SIGKILL-and-resume. Never run on production. |
| **Legacy global indexes** | Seven registered in `drop-legacy-global-indexes.ts`: `batches.name`, `appsettings.key`, `attendancerules.role`, `holidays.date`, `roomallocations.date`, `attendances.idempotencyKey`. Compound replacements are declared in the models and build automatically; the script refuses to drop a legacy index unless its replacement exists. **Run only after the backfill** — a compound `{orgId, x}` index on unbackfilled data enforces nothing. |
| **`User.email` global unique** | Deliberately retained: login happens before any organization is known. Dropping it is a product decision (the same person at two institutes), not a bug fix. |
| **api-legacy / api-platform deployment** | Two deployments of one codebase. `deployment-modes.test.ts` covers all four configurations. |
| **Progressive `requireRole` → `requirePermission`** | 161 `requireRole` guards remain. `requirePermission` is wired to zero routes; the permission vocabulary and resolution are built and tested, but the migration is per-route work with real regression risk. |

---

## OPTIONAL

- **Socket notifications in the new mobile client.** The server already emits
  them and the rooms are now tenant-safe. The client refreshes on foreground
  instead, which fixes what users actually notice. A socket needs connection
  lifecycle, auth-on-reconnect and backoff; getting those wrong produces a
  client that silently stops receiving, which is worse than refreshing late.
- **Push notifications.** Needs per-organization Firebase/APNs credentials —
  white-label work with a real cost.
- **Cache invalidation is platform-wide.** `delPattern('*courses*')` clears
  every organization's cache. Correctness is preserved; it is wasteful.
- **Object-storage paths are not org-prefixed.** They embed ObjectIds so they
  cannot collide, but a per-organization export or purge cannot be done by
  prefix.
- **`User.empCode` global unique.** Abhigyan-specific and sparse. Review before
  a second organization uses employee codes.
- **iOS native validation.** Not possible on this machine (Windows).

---

## Monitoring, logging, rollback

**Logging** — every tenancy bypass logs its reason; `[tenancy:warn]` records
unscoped operations under warn mode, which is how the backfill's progress is
observable. Entitlement denials return a machine-readable
`MODULE_NOT_ENABLED`.

**Monitoring** — READY at the platform level (`/api/health`, `/api/metrics/health`)
and BLOCKED at the tenant level: there is no per-organization error rate, no
usage metering beyond `UsageRecord`, and no alert when one tenant's cron fails
(`forEachOrg` isolates the failure, which is correct, but nothing pages).

**Rollback** — the strongest single asset. `TENANT_ENFORCEMENT=off` makes the
entire tenancy layer inert in one environment variable, verified by
`deployment-modes.test.ts`. Backups and a verified restore path exist
(`db-backup`, `db-restore`, `verify-restore`), and the backfill has a tested
undo. Every phase is a separate local branch with tags at
`baseline/pre-saas-2026-08-17`.

---

## Native mobile validation (Android)

Built and installed on an emulator (Pixel 6, API 35) via `expo run:android`,
driven through adb. Screenshots in `docs/p8-native/`.

| Validated | Evidence |
|---|---|
| Authentication | Typed credentials, real login against the API |
| Runtime branding | ABC's orange applied on device |
| Tenant configuration | Dropper, 4 subjects, halls and labs, +4/-1/0 |
| Permission-driven nav | Student sees 5 tabs, no question bank |
| Persistent session | Survived background → foreground |
| AppState | Resume triggered a context refetch |
| Stale context | "Showing saved information" with the API down |
| Offline | Everything readable from the persistent cache |
| Exam recovery | "Resume attempt" for an in-progress attempt |
| Timer | Server-anchored countdown, 09:52 → 09:22 |
| Answer queue | Batched, synced, persisted server-side |
| Submission | Status `submitted`, result correctly withheld |
| Storage | AsyncStorage persisted token and context |
| Entitlements | "Offline tests are not available for this organization" |

**Not validated natively:** iOS (no macOS), push notifications (not
implemented), and multi-hour background suspension.

**Note:** `android/` required pinning Gradle to 8.13. The React Native plugin
references `JvmVendorSpec.IBM_SEMERU`, removed in Gradle 9, so the generated
9.3.1 wrapper cannot build. That pin belongs in any CI that builds this app.
