# Batch ownership

Last reviewed 2026-10-17. Audience: engineers changing batch, onboarding or
picker code, and whoever approves the related production steps.

**Rule:** each organization owns and manages its own batches. Batches are
optional and organization-specific. The platform never creates, merges,
renames or deletes an organization's batches on its own.

## What enforces it

| Path | Behaviour | Proof |
| --- | --- | --- |
| Batch reads (`/api/auth/public-student-batch-config`, `/api/schedule/batches`, `/api/schedule/firebase/batches`, class-request options, student create/update) | Never merge on the platform runtime. Abhigyan's Advanced+Basic merge (`LEGACY_BATCH_MERGE_RULES`) runs only in the existing system (`/api/*`). | `batch-ownership.e2e` platform 42/42 (warn and enforce); `--existing` 5/5, identical on the previously committed code |
| Batch CRUD (`POST/PUT/DELETE /api/schedule/batches`) | Scoped to the caller's organization; only `name`, `classLevels`, `isDefault`, `description` accepted (a body `orgId` is ignored); duplicate name within the organization → 409 | same suite |
| Public batch options and public registration | `400 ORG_REQUIRED` on the platform runtime without an organization, before any query | same suite and `public-routes-tenancy` |
| Teacher batch pickers | see below | same suite |

## Teacher batch pickers

Every batch list a teacher can reach was traced and is covered by two
organizations with overlapping names (both have Advanced, Basic and Morning)
plus names only one organization uses:

| Endpoint | Source of names | Organization scope | Covered |
| --- | --- | --- | --- |
| `GET /api/teacher/batches` | exams the teacher created, approved students' `batch`, the teacher's own `batch` | students: explicit `tenantScope()`; exams: tenancy plugin (A's teacher does not see B's exam even when B's exam names A's teacher as creator); counts per name count only the teacher's organization | ✓ |
| `GET /api/syllabus/metadata` | approved students' `batch` | tenancy plugin (`distinct` is scoped) | ✓ |
| `GET /api/schedule/batches` | Batch documents | explicit `tenantScope()` | ✓ |
| `GET /api/me/context` (`configuration.batches`) | Batch documents | explicit organization id | ✓ |
| `GET /api/users/student-batch-config` | Batch documents | live tenant context | ✓ (returns 200 for a teacher) |

Observation, not changed: `GET /api/syllabus/metadata` answers
`batches: ["A", "B", "C"]` when an organization has no student batches — placeholder
names an organization never created. It is a display default in a route the
existing system shares; changing it is a product decision.

## Onboarding replaces batches

`setOrganizationConfig(orgId, input)` (`src/core/platform/organizations.ts`)
treats each supplied list as the **complete** list. For batches:
`Batch.deleteMany({ orgId })`, then creates each supplied batch one at a time.
A batch that fails to save (for example on the legacy global `name_1` index) is
only logged.

Callers that can pass `batches`:

| Caller | Who | When batches reach it |
| --- | --- | --- |
| `POST /api/platform/onboard` → `onboardOrganization()` | platform staff (console Onboard page) | when the submitted configuration includes `batches`. The page pre-fills its editor with a sample organization that has four batches (JEE Main, JEE Advanced, NEET, Foundation); submitted unedited, they are created for the new organization |
| `approve` of a self-registration → `registrations.ts` → `onboardOrganization()` | platform staff | when the application listed batches (`applicationProvisioning.ts`) |
| `PUT /api/platform/orgs/:orgId/config` | platform staff with `org.manage` | whenever the body has `batches`; the console API client exposes `setConfig`, but no console screen calls it |

The organization's own configuration route (`PUT /api/org-admin/configuration`)
never forwards `batches`. Organizations manage batches through the batch routes.

**Risk:** a new organization has no batches, so onboarding loses nothing. The
console config route on an **existing** organization deletes every batch and
recreates the supplied ones with new ids. Students' and schedules' `batch`
names survive, but anything holding a batch id (class requests' `batchId`)
loses its target, and a batch omitted from the list is gone.

**Recommended default (not implemented — needs your confirmation):**

1. Add, never delete, by default: create supplied batches that do not exist
   (by name, within the organization), update `classLevels` of those that do,
   and leave the rest untouched.
2. Replace only on explicit request: `replace: true` plus a confirmation that
   echoes a preview — the batches that would be deleted, and how many students,
   schedules and class requests reference each.
3. Refuse to delete a batch that is still referenced unless the confirmation
   names it.
4. Report every batch that could not be saved in the response, not only in
   the log.

## Production state

Unknown until the read-only audit runs (`scripts/safety/batch-audit.ts`).
What it can and cannot establish, and the commands, are in the final report of
2026-10-17. The index change is planned separately in
[batch-index-migration.md](batch-index-migration.md).
