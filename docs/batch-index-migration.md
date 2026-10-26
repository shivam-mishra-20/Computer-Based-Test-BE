# Batch name index migration — plan

Status: **plan only, not executed.** Written 2026-10-17. Audience: whoever
operates the production databases and approves migrations.

## Goal

Batch names are unique **within an organization** (`{ orgId: 1, name: 1 }`,
unique), not across the whole platform. The legacy global unique index
`batches.name_1` makes the second organization to use an ordinary name such as
"NEET" or "Morning" fail to save it. Onboarding currently catches that error
and only logs it, so a batch silently goes missing.

Scope: **the platform database (`abhigyangurukul_console`) only.** The existing
Abhigyan database serves one institute; `name_1` is correct there and stays.

## Step 0 — know what is there (read-only, needs approval)

Run the read-only audit (`scripts/safety/batch-audit.ts`, see the end of this
document) against the platform database. It reports:

| Report field | Meaning |
| --- | --- |
| `indexes.legacyGlobalNameUnique` | `name_1` (unique) exists |
| `indexes.orgScopedNameUnique` | `orgId_1_name_1` (unique) exists |
| `duplicates.exactWithinOrg` | same name twice in one organization: blocks the new index |
| `duplicates.unattributedSameName` | same name twice with no `orgId`: also blocks it (both count as `orgId: null`) |
| `duplicates.caseOrSpaceVariantsWithinOrg` | "Morning" vs "morning": allowed by the index, worth reviewing |
| `batches.orgIdTypes` | an `orgId` stored as an ObjectId and as a string are DIFFERENT values to the index; the same organization could then hold "Morning" twice |

## Decision

| Audit result | Action |
| --- | --- |
| `name_1` absent, `orgId_1_name_1` present and unique | Nothing to migrate. |
| `name_1` present, `orgId_1_name_1` present and unique | Drop `name_1` only (step 4). |
| `name_1` present, `orgId_1_name_1` absent | Create the new index (step 3), then drop `name_1` (step 4). Under `name_1` no two batches share a name anywhere, so the new index cannot fail on duplicates. |
| `name_1` absent, `orgId_1_name_1` absent | No uniqueness at all today. Resolve every exact and unattributed duplicate with the owning organization first (a data decision, not part of this plan), then create the new index (step 3). |
| An index named `orgId_1_name_1` exists but is **not** unique | It must be dropped and recreated as unique. MongoDB refuses two indexes with the same key pattern and different options. Treat this as "absent", and keep `name_1` until the unique one is built. |

## Preconditions

1. The audit has been run and reviewed, and the decision row is agreed.
2. **A verified backup of the platform database**, taken immediately before:
   `db-backup` → `db-restore` into `abhigyangurukul_console_restore_<date>` →
   `verify-restore` passes ([backup-and-restore.md](backup-and-restore.md)).
   The backup manifest also records the index definitions.
3. Rehearsed once on that restore copy with the exact commands below.
4. A quiet window. The batches collection is small, so builds take
   milliseconds, but nobody should be creating batches during the change.
5. Batch-ownership code deployed (create/update accept only batch fields; a
   duplicate name within an organization answers 409, not 500).

## Commands (mongosh, platform database)

Each step is a separate, reviewed action. Nothing here runs automatically.

```js
// 1. Record the starting point (read).
db.batches.getIndexes()

// 2. Duplicate detection (read). All three must return [] before step 3.
db.batches.aggregate([
  { $group: { _id: { org: { $toString: "$orgId" }, name: "$name" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
])
db.batches.aggregate([
  { $match: { $or: [{ orgId: { $exists: false } }, { orgId: null }] } },
  { $group: { _id: "$name", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
])
db.batches.aggregate([
  { $group: { _id: { $type: "$orgId" }, n: { $sum: 1 } } }
])   // more than one non-null type → resolve before relying on the index

// 3. Create the organization-scoped unique index (WRITE — approval).
db.batches.createIndex({ orgId: 1, name: 1 }, { unique: true, name: "orgId_1_name_1" })
db.batches.getIndexes()   // verify: orgId_1_name_1 with unique: true

// 4. Drop the legacy global index (WRITE — approval). Only after step 3 is verified.
db.batches.dropIndex("name_1")
db.batches.getIndexes()   // verify: name_1 gone, orgId_1_name_1 unique present
```

Then re-run the read-only audit: `legacyGlobalNameUnique: false`,
`orgScopedNameUnique: true`, no exact duplicates.

### Do not use `drop-legacy-global-indexes.ts` as it stands

`scripts/safety/drop-legacy-global-indexes.ts` exists for this, but four things
make it wrong for this step:

1. `--production` targets `MONGO_URI`, the **existing** database, not the
   platform one. Reaching the platform database means `--target-env
   PLATFORM_MONGODB_URI`, a path documented as a scratch convenience that would
   still hit production.
2. One run drops **every** legacy index in its list (batches, appsettings and
   others), not just `batches.name_1`.
3. Its safety check only confirms that an index with the compound **key**
   exists, not that it is **unique**. A non-unique `{orgId, name}` index would
   satisfy it, and dropping `name_1` would then leave no uniqueness at all.
4. It assumes the application built the compound index at startup. Index
   creation at boot can be disabled (`DB_BOOT_SCHEMA_SYNC=false`), and it is
   not guaranteed to have run.

Use the mongosh steps, or a corrected script (batches only, explicit platform
target, `unique: true` check, dry-run by default) reviewed separately.

## Expected impact

- **Step 3:** builds an index on a small collection (hundreds of documents at
  most). MongoDB 4.2+ holds an exclusive lock only briefly at the start and end
  of a build. The application is unaffected; within-organization duplicates
  become impossible.
- **Step 4:** instant. Two organizations can now use the same batch name, and
  onboarding stops silently skipping such batches.
- Nothing else changes: no document is written, renamed or deleted.

## Rollback — and its limits

| Step | Rollback | Limit |
| --- | --- | --- |
| 3 | `db.batches.dropIndex("orgId_1_name_1")` | None. |
| 4 | `db.batches.createIndex({ name: 1 }, { unique: true, name: "name_1" })` | **Works only while no two organizations share a batch name.** Once they do, the global index cannot be rebuilt without renaming one organization's batch, which is a data change. In practice step 4 is one-way soon after it runs. |
| Either | Restore the pre-migration backup | Also discards every batch change made since. A last resort. |

Check whether step 4 can still be rolled back:

```js
db.batches.aggregate([
  { $group: { _id: "$name", orgs: { $addToSet: { $toString: "$orgId" } } } },
  { $match: { "orgs.1": { $exists: true } } }
])   // [] → name_1 can still be recreated
```

## Approvals needed

1. Read-only audit of the platform database (step 0).
2. A verified backup of the platform database.
3. Step 3 (create index) and step 4 (drop index), each confirmed after the
   previous verification. These are production writes.
