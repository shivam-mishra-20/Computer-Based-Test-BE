# Backup and restore — both databases

Last reviewed 2026-10-17. Audience: whoever operates central-be in production.

central-be serves two systems from two databases. Both need a backup, and a
backup only counts once it has been restored and verified.

| Realm | Served at | Variable | Production database |
| --- | --- | --- | --- |
| Existing system (Abhigyan Gurukul) | `/api/*` | `MONGO_URI` | `abhigyangurukul` |
| Organization platform | `/platform-api/*` | `PLATFORM_MONGODB_URI` | `abhigyangurukul_console` |

## Current state

- **Existing database:** one logical backup, taken 2026-08-17
  (`backups/2026-08-17-p0/`), restored to `abhigyangurukul_restore_2026_08_17`
  and verified ([production-safety.md](production-safety.md) §3–4). Nothing
  since. That copy is two months old.
- **Platform database:** never backed up.
- **Atlas automated backups:** not confirmed for either database. The cluster
  tier decides what is available (shared tiers M0/M2/M5 have no continuous
  backup; dedicated tiers M10 and up have snapshots and point-in-time restore).
  Check this in the Atlas UI before relying on anything below as the only copy.
- **Not covered by any database backup:** files in Firebase Storage (uploads,
  doubt attachments, brand assets), anything in Firestore, and Redis (queues,
  rate-limit counters, socket state — losing these drops in-flight jobs only).

## The tools

All three scripts are in `scripts/safety/`. They read the source database from
`MONGO_URI`, write canonical EJSON (types survive: ObjectIds, Dates, Decimals,
binaries) and record a SHA-256 fingerprint per collection.

| Step | Command | Writes to |
| --- | --- | --- |
| Back up | `npm run safety:backup -- --out backups/<dir>` | local disk only; reads the database |
| Restore | `npm run safety:restore -- --from backups/<dir> --to <scratch-uri>` | the target database only |
| Verify | `npm run safety:verify -- --from backups/<dir> --to <scratch-uri>` | nothing; reads both |

The restore refuses any target whose database name lacks a scratch marker
(`_scratch`, `_restore`, `_rehearsal`, `_verify`), and refuses the source
database itself. It drops and reloads collections **in the target only**, and
rebuilds the indexes recorded in the manifest.

### Backing up the platform database

The scripts take the source from `MONGO_URI`, so for the platform database set
`MONGO_URI` to the platform connection string **for that one command**. Never
edit `.env` to do this: an edited `.env` is how a local server ends up pointed
at production.

```bash
# bash — the variable applies to this command only
MONGO_URI="<platform connection string>" npm run safety:backup -- --out backups/2026-10-17-platform
```

```powershell
# PowerShell — set, run, and remove in one line
$env:MONGO_URI = '<platform connection string>'; npm run safety:backup -- --out backups/2026-10-17-platform; Remove-Item Env:MONGO_URI
```

Restore and verify take the same `MONGO_URI`, so the guard compares the target
against the platform database and not the existing one:

```bash
MONGO_URI="<platform connection string>" npm run safety:restore -- \
  --from backups/2026-10-17-platform --to "<same cluster>/abhigyangurukul_console_restore_2026_10_17"
MONGO_URI="<platform connection string>" npm run safety:verify -- \
  --from backups/2026-10-17-platform --to "<same cluster>/abhigyangurukul_console_restore_2026_10_17"
```

The existing database uses the same three commands with the normal `MONGO_URI`.

Collection budget: a restore copy of the platform database adds about 65
collections to the cluster (174 of 500 were in use on 2026-10-07). Drop a
verified restore copy once its result is recorded; that is a deliberate
operator action, not something the scripts do.

## Where backups live

- `backups/` is git-ignored. Never commit a backup.
- A backup holds student personal data, password hashes, refresh-token hashes
  and sealed secrets. Keep it on encrypted storage with restricted access, and
  delete local copies once they are moved there.
- **`CONFIG_ENCRYPTION_KEY` is not in the backup and must not be stored with
  it.** It unseals integration credentials and staff two-factor secrets. Keep it
  in the secret store, backed up separately. A restore without the key still
  works, but every sealed value becomes unreadable: staff must re-enrol
  two-factor sign-in (an owner resets them) and integration credentials must be
  re-entered.

## Cadence (proposed)

| When | What |
| --- | --- |
| Continuously, if the Atlas tier allows | Atlas snapshots / point-in-time restore, both databases |
| Weekly | Logical backup of both databases, restored and verified |
| Before every migration or rollout step | Logical backup of the affected database (for example before `TENANT_ENFORCEMENT=enforce`, before any backfill) |
| Quarterly | A timed restore drill, to measure the real recovery time |

Proposed targets until measured: recovery point 24 hours (7 days is the
current reality), recovery time 2 hours for a logical restore.

## Disaster recovery: restoring production

The restore tool deliberately cannot write to a production database name. That
is intended. Recovery never writes over the live database:

1. Restore the chosen backup into a new, scratch-marked database on the same
   cluster (for example `abhigyangurukul_restore_2026_10_17`).
2. Verify it (`safety:verify`). A failed verification stops here.
3. Point the service at the restored database by changing the database name in
   `MONGO_URI` or `PLATFORM_MONGODB_URI` on Railway, then redeploy. **This is a
   production configuration change and needs the owner's approval.**
4. Keep the damaged database untouched until the incident is understood.
5. Record the incident and the restore in `production-safety.md`.

With Atlas point-in-time restore available, prefer it for step 1 (restore to a
new cluster or database) and keep steps 2–5.

## Restore drills — evidence, 2026-10-17

Run in an isolated environment: a local MongoDB on 127.0.0.1 with throwaway
credentials. No production database or Redis was touched.

| Source | Collections (with data) | Documents | Backup | Restore | Verify |
| --- | --- | --- | --- | --- | --- |
| Platform-shaped database (`iso_platform`) | 63 | 25 | ✅ | ✅ | ✅ passed |
| Existing-shaped database (`iso_existing`) | 0 | 0 | ✅ | ✅ | ✅ passed (empty) |
| Two-organization fixture (`iso_platform_scratch_public`) | 65 (5) | 83 | ✅ | ✅ | ✅ passed |
| Same restore, one trailing space added to one document | — | — | — | — | ❌ **failed, as it must** (`batches: fingerprint differs`, exit 1) |

The negative test is the important row: verification compares content, not
row counts.

These drills prove the procedure and the tools. They do not prove a production
backup exists. Taking and verifying the first platform-database backup, and
confirming Atlas backups, are the open actions.
