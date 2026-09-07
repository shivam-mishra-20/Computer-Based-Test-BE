# P9 — Firestore decommission & MongoDB consolidation

Audit and design, 2026-08-19. Nothing in production was modified. Every claim
below is traced to code; where I could not establish something, it says so.

---

## 0. The finding that reframes the phase

**Firestore is not a dependency of the B2B platform. It is the datastore of a
different application.**

| Repo | Firestore files | Role |
|---|---|---|
| `abhigyan-gurukul-main` | **29** | The legacy Abhigyan website — marketing, admin, student dashboard, goals, complaints, events |
| `cbt-exam-be` (platform-core) | 5 | Two read paths + one write path, all attendance/user lookups |
| `cbt-exam` (client-platform-web) | **0** | — |
| `client-platform-app` | **0** | — |
| `platform-console` | **0** | — |
| `abhigyan-gurukul-app` | **0** | — |

The three products that constitute the B2B platform contain **zero** Firestore
code. The consolidation question is therefore not "how do we get the platform
off Firestore" — it is largely already off — but "what happens to the legacy
website".

That distinction drives the recommendation at the end.

---

## 1. Complete Firestore inventory

Traced from `collection(db, …)` and `doc(db, …)` call sites, not from names.
Live document counts could **not** be obtained — see §19, Risk 1.

### 1.1 Collections used by the legacy website (`abhigyan-gurukul-main`)

| Collection | Owner component(s) | Operations traced |
|---|---|---|
| `Users` | `CreateUserPage`, `AdminUserManagement`, +4 | getDocs, setDoc, updateDoc, deleteDoc |
| `Results` | `StudentPerformanceChart`, +4 | getDocs, addDoc, setDoc, deleteDoc |
| `ActualStudentResults` | `FloatingLeaderboardButton`, `MiniLeaderboardCard`, +2 | getDocs, setDoc, deleteDoc |
| `studentLeaves` | DevConsole (site); **written by platform-core** | see §1.2 |
| `teacherLeaves` | `CreateUserPage` | setDoc |
| `Complaints` | `StudentComplaintsWidget`, +3 | getDocs, setDoc, updateDoc, deleteDoc |
| `Goals` | `pages/Goals.jsx` | getDocs, addDoc, updateDoc, deleteDoc |
| `Logs` | `pages/Logs.jsx`, `logEvent()` | getDocs, addDoc |
| `Feedbacks` | `FeedbackButton`, `AdminFeedbackDisplay` | setDoc, getDocs, deleteDoc |
| `events` | `AdminEvents`, `Events` | getDocs, addDoc, updateDoc, deleteDoc |
| `admissionInquiries` | `AdmissionInquiryForm`, `AdminAdmissionInquiries` | addDoc, updateDoc, deleteDoc, **onSnapshot** |
| `basicEnquiries` | `BasicEnquiryForm`, `AdminBasicEnquiries` | addDoc, updateDoc, deleteDoc, **onSnapshot** |
| `ExtraClassRequests` | `pages/ExtraClassRequest.jsx` | getDocs, setDoc, deleteDoc |
| `StudentSyllabusUpdates` | `pages/StudentSyllabusUpdate.jsx` | getDocs, setDoc, deleteDoc |
| `traffic_logs` | `utils/trackVisit.js`, `TrafficDashboard` | addDoc, getDocs |
| `contacts` | `Admin.jsx`, `AdminRoute.jsx` — single doc `contactForm` | getDoc, setDoc |
| `settings` | `Admin.jsx`, `AdminRoute.jsx` — single doc `adminEmails` | getDoc, setDoc |

**Declared but never referenced outside `DevConsole`'s browsing array**, so no
application code reads or writes them: `HomeworkStatus`, `SyllabusReport`,
`TimeTable`, `PastTests`, `UpcomingTests`. (`syllabus` appears elsewhere only as
a UI modal string, not a collection.)

**Subcollections:** none found. Every access is a root collection.
**Transactions:** none. **Batches:** only in platform-core (§1.2).
**Realtime listeners:** two, both `onSnapshot` on the enquiry collections in
`AdminAdmissionInquiries.jsx`.

### 1.2 Collections used by platform-core (`cbt-exam-be`)

| Site | Collection | Operation |
|---|---|---|
| `firebaseService.getFirestoreUserProfile` | `Users/{uid}` | read — classLevel/batch fallback |
| `firebaseSyncService` ×3 | `Users` | read only — one-way import into Mongo |
| `attendanceService.getFirebaseAttendance` | `studentLeaves` | read (query + doc) |
| `attendanceService.getAllStudentAttendance` | `studentLeaves` | read |
| `attendanceService.getAttendanceFilters` | `studentLeaves` | read |
| `attendanceService.uploadAttendanceRecords` | `studentLeaves` | **WRITE** (`batch.set`, merge) |
| `attendanceService.syncStudentsToAttendance` | `Users` read → `studentLeaves` **WRITE** | |
| `scheduleRoutes:281` | `Users/{teacherId}` | read |
| `scheduleRoutes:572,664` | `Users` (full scan) | read |
| `scheduleRoutes:1801` | **`users`** (lowercase) | read, filtered by classLevel/batch |

**There are exactly two Firestore writes in the whole platform backend**, both
in `attendanceService`.

`scheduleRoutes:1801` queries **`users`** while every other site queries
**`Users`**. Firestore collection ids are case-sensitive, so this is either a
second collection or a latent bug that silently returns nothing. It cannot be
resolved from code — it needs a live read (§19, Risk 1).

### 1.3 Dead code

`getFirestoreUserByEmail`, `getFirestoreUserByEmailRest` and
`firebaseSignInWithEmailPassword` have **zero callers**. They are the remains of
a Firebase-Auth login path that has been replaced by MongoDB + bcrypt.

### 1.4 Firebase Authentication

**Not used for authentication.** There is no `verifyIdToken` anywhere in
platform-core. The only Auth call is `admin.auth().deleteUser(uid)`, a
best-effort cleanup when an account is deleted. `User.firebaseUid` persists as a
legacy correlation key.

The legacy website still uses `onAuthStateChanged` in `Admin.jsx` and
`AdminRoute.jsx` for its admin gate — but its **login already goes through the
platform API** (`src/lib/auth.js` → `apiFetch('/auth/login')`). Its Firebase Auth
usage is a residual session check, not the credential path.

---

## 2. Classification

| Collection | Class | Business entity | Already in MongoDB? |
|---|---|---|---|
| `Users` | **TENANT** | People | **Yes** — `User` |
| `studentLeaves` | **TENANT** | Biometric attendance | **Yes** — `Attendance` |
| `teacherLeaves` | **TENANT** | Staff leave | **Yes** — `Leave` |
| `Results` / `ActualStudentResults` | **TENANT** | Offline test marks | **Yes** — `TestResult` |
| `Complaints` | **TENANT** | Student complaints | No |
| `Goals` | **TENANT** | Goal tracking | No (`Guidance` is AI prompt text — name-coincidence only) |
| `ExtraClassRequests` | **TENANT** | Extra-class requests | No (`ClassRequest` is the public enquiry form — different entity) |
| `StudentSyllabusUpdates` | **TENANT** | Syllabus progress notes | Partly — `Syllabus` exists; shape differs |
| `Logs` | **TENANT** | In-app activity log | **Yes** — `AuditLog` |
| `Feedbacks` | **TENANT** | Site feedback | No |
| `admissionInquiries` | **TENANT** | Admission leads | **Partly** — `ClassRequest` is the same entity (public form → admin queue) |
| `basicEnquiries` | **TENANT** | Contact leads | **Partly** — same as above |
| `events` | **TENANT** | Website events + images | No |
| `traffic_logs` | **TENANT** | Website analytics | No |
| `contacts/contactForm` | **TENANT** | Site contact details | No — belongs in `OrgPolicy`/branding |
| `settings/adminEmails` | **TENANT** | Admin allowlist | Superseded by RBAC |
| `HomeworkStatus`, `SyllabusReport`, `TimeTable`, `PastTests`, `UpcomingTests` | **UNUSED** (code) / **LEGACY** (data unknown) | — | `Homework`, `Syllabus`, `Schedule`, `Test` exist |

Nothing classifies as GLOBAL or PLATFORM. Every Firestore collection holds one
institute's data — which is precisely why none of it is safe to share.

---

## 3. Current security model

**There are no Firestore rules, Storage rules, `firebase.json` or
`.firebaserc` files in any of the six repositories.** They exist only in the
Firebase console. Consequences:

- They cannot be reviewed, diffed, code-reviewed or restored from source.
- I cannot state what they currently permit. Any claim would be a guess.
- The legacy website performs **direct client-side reads and writes** to
  `Users`, `Results`, `Complaints`, `Goals` and eleven more collections from the
  browser. Whatever protects that data is entirely those unversioned rules.

**Independently established:** every file uploaded through platform-core is
world-readable. `uploadToFirebase` calls `file.save(…, { public: true })` and
then `file.makePublic()`, returning a
`https://storage.googleapis.com/<bucket>/<path>` URL. There is no signed URL
anywhere in the codebase.

---

## 4. Firebase Storage — current state

| Caller | Path pattern | Tenant-safe? |
|---|---|---|
| `authController` (profile images) | `profile-images/{userId}_{ts}.{ext}` | Safe by key — userId is an ObjectId |
| `homeworkRoutes` | `homework/{homeworkId}/{ts}_{name}` | Safe by key |
| `aiContentController` | `ai-content/{ownerId}/{docId}.pdf` | Safe by key |
| `materialRoutes` | `materials/{class}/{subject}/{ts}_{name}` | **UNSAFE — class and subject are tenant values.** Two institutes both writing `materials/11/Physics/` share a folder |
| `resourceRoutes` | `study-resources/pdfs/{class}/{subject}/{ts}_{name}` | **UNSAFE — same** |
| `uploadController` | `images/{ts}_{name}` | Collision-prone — timestamp only |
| `importRoutes`, `diagramService` | `diagrams/{ts}_{name}` | Collision-prone |
| `AdminEvents` (legacy site, client-side) | `{fileName}` at bucket root | **UNSAFE — no namespace at all** |

Two families are already tenant-unsafe by construction, two more collide on a
same-millisecond upload, and everything is public.

---

## 5–7. Target architecture

```
MongoDB Atlas      all application and business data, orgId on every document
Firebase Storage   files only — the bytes
MongoDB            the file's metadata, owner, orgId and storage reference
Firestore          retired
```

### Model mapping

**Reuse (no new model):**

| Firestore | MongoDB | Note |
|---|---|---|
| `Users` | `User` | `firebaseUid` already correlates them |
| `studentLeaves` | `Attendance` | See §8 — the merge logic disappears |
| `teacherLeaves` | `Leave` | |
| `Results`, `ActualStudentResults` | `TestResult` | Two collections, one target; needs a de-duplication rule |
| `Logs` | `AuditLog` | |

**Extend an existing model (1):** `admissionInquiries` + `basicEnquiries` →
`ClassRequest`, with a `kind` discriminator. `ClassRequest` is documented as
"a prospective or existing student asking for a class, submitted from the public
web page or the mobile guest flow — one canonical collection feeds one admin
queue", and it already has the public-submit route, the admin queue and the
status workflow. Two lead-capture forms are the same entity as a third; adding a
fourth model would fragment one admin queue into two.

**New models required (5):** `Complaint`, `Goal`, `ExtraClassRequest`,
`Feedback`, `SiteEvent`.

`ExtraClassRequest` is deliberately *not* folded into `ClassRequest` despite the
similar name: `ClassRequest` is a prospective student asking to join a class,
`ExtraClassRequests` is an enrolled student asking for an extra session on a
specific topic. Different actor, different lifecycle, different queue.

**Not migrated:** `traffic_logs` (website analytics — belongs in an analytics
product, not the business database); `settings/adminEmails` (superseded by
RBAC); `contacts/contactForm` (belongs in `Org.branding`).

Every new model: `orgId` required, compound `{orgId, …}` indexes only, no
globally unique business keys — the P8 rule.

### Storage target

```
org/{orgId}/materials/{classKey}/{subject}/{fileId}_{name}
org/{orgId}/homework/{homeworkId}/{fileId}_{name}
org/{orgId}/profile/{userId}/{fileId}.{ext}
org/{orgId}/ai-content/{docId}.pdf
```

An `orgId` prefix on every path makes tenant isolation a property of the path,
enables per-organization export and purge by prefix, and lets a Storage rule be
written that can actually be enforced. `FileMetadata` becomes the authoritative
index (it already carries `url` + `storagePath`, and the tenancy plugin already
gives it `orgId`); reads go through a backend endpoint that checks `orgId` and
issues a **signed URL**, replacing `makePublic()`.

---

## 8. Required API changes

1. **Delete the dead Firebase-Auth code** (`getFirestoreUserByEmail`,
   `…Rest`, `firebaseSignInWithEmailPassword`) — zero callers.
2. **`attendanceService`: remove the Firestore read path.** `getStudentAttendance`
   currently merges Firestore over MongoDB, Firestore winning. Once
   `studentLeaves` is migrated, the merge and `source: 'firebase'` disappear and
   the function reads `Attendance` alone.
3. **`attendanceService`: remove the two Firestore writes.**
   `uploadAttendanceRecords` and `syncStudentsToAttendance` write to
   `Attendance` instead — which they already partly do.
4. **`scheduleRoutes`: replace three `Users` reads and the `users` read** with
   `User` queries. The teacher lookup at :281 already has a Mongo equivalent.
5. **`homeworkRoutes`: drop `getFirestoreUserProfile`** — it is a fallback for
   `classLevel`/`batch`, both of which are on the Mongo `User`.
6. **`firebaseSyncService`: retire after the migration** — it is the import
   tool, and once Firestore is the source of nothing there is nothing to import.
7. **New endpoints** for the six new models, each `requireModule`-gated and
   permission-checked, replacing direct client-side Firestore access.
8. **`uploadToFirebase`: stop calling `makePublic()`**; add a signed-URL read
   endpoint.

## 9. Required client changes

**Legacy website only** — the four platform products need no changes.
29 files move from `collection(db, …)` to `apiFetch(...)`. The two
`onSnapshot` listeners on the enquiry collections lose realtime; the existing
`SocketService` (rooms now org-namespaced, P8) can replace them, or polling can.

## 10. Required indexes

Per new model: `{orgId, createdAt}` for listing, plus `{orgId, status}` where a
status is filtered. For `Attendance`, the P8 compound `{orgId, idempotencyKey}`
already exists; migrated Firestore rows need a deterministic idempotency key
derived from `{orgId, studentId, date}` so a re-run cannot double-insert.

---

## 11–12. Migration and backup strategy

**Per-collection, idempotent, resumable, verifiable.** The pattern is the one
already proven by `backfill-org.ts` (rehearsed four times, including a
SIGKILL-and-resume):

1. Export the Firestore collection to newline-delimited JSON, checksummed.
2. Transform, deriving `orgId` — **Org 001 for every existing document**, since
   Firestore predates multi-tenancy and holds exactly one institute's data.
3. Upsert into MongoDB keyed on a **deterministic migration id**
   (`fsDocId` stored on the target document), so a re-run updates rather than
   duplicates and a partial run resumes.
4. Verify: count, then content (field-level comparison on a sample and on every
   document for small collections), then relationships (every `studentId`
   resolves to a real `User` in the same org).
5. Only then switch reads.

**Handling the known hazards:**
- *Name-derived doc ids.* `studentLeaves` is keyed `{name}_{class}`,
  `ExtraClassRequests` is `{name}_{class}_{topic}`. These do not resolve to a
  user id. Migration must join on `User.name` + `classLevel` within Org 001 and
  **quarantine** every row that matches zero or more than one user rather than
  guessing. Expect a non-trivial quarantine set; it is the main manual step.
- *Malformed documents.* Firestore is schemaless; `Results` and
  `ActualStudentResults` overlap. Rows failing validation go to a
  `migration_quarantine` collection with the reason, never dropped.
- *Duplicates.* `Results` vs `ActualStudentResults` need a documented precedence
  rule before migration, not during it.

**Backup:** MongoDB Atlas PITR + the existing `db-backup`/`db-restore`/
`verify-restore` scripts. Firebase Storage has **no backup today** — a
scheduled `gsutil rsync` of the bucket to independent storage, with a restore
rehearsal, is required before anything is deleted. Firestore export to GCS
before migration, retained until the observation period ends.

**Rollback:** Firestore is left untouched and readable until retirement, so
rollback is reverting the application to the Firestore read path. That is why
the cutover is a code switch, not a data deletion — and why Firestore deletion
must be the last step, weeks later.

---

## 13. Testing strategy

Reuse the existing harness: seed a scratch Firestore emulator (or a scratch
Firebase project) with representative documents, run the migration, then assert
counts **and** content **and** relationships **and** `orgId` on every row.
Add a two-tenant case that proves a migrated Org 001 document is invisible to
Org 002 through the real API — the `two-org-isolation` and
`client-platform-*.e2e` suites already provide that shape.

## 14–15. Compatibility

**Org 001 (Abhigyan).** Every Firestore-backed behaviour has a MongoDB
equivalent after §8. The one behavioural change is attendance precedence: today
Firestore silently overrides MongoDB for the same date. After migration there is
one source, so any divergence between the two must be reconciled *before*
cutover, not discovered after.

**Org 002 (ABC) and beyond.** They never touch Firestore. Their only exposure is
Storage, and the `org/{orgId}/…` restructure plus signed URLs is what makes
files isolated. Until then, ABC's materials are world-readable and share a path
namespace with Abhigyan's.

## 16. Production sequence

Backup Mongo → export Firestore → build indexes → migrate per collection →
verify counts/content/relationships/ownership → validate the application against
a scratch restore → switch reads → observation period (≥2 weeks, both stores
readable) → freeze Firestore writes → retire.

**Rollback triggers:** any count mismatch, any quarantine row that cannot be
resolved, any tenant-ownership failure, any attendance divergence.

## 17. Risks

1. **Live Firestore is unreadable from this machine.** The service-account key
   in the local `.env` fails with `invalid_grant: Invalid JWT Signature` for
   Firestore, Storage *and* Auth. This proves the **local credential** is stale;
   it does **not** tell us production is broken. Consequence: document counts,
   data volumes, real field shapes, whether `users` (lowercase) exists, and
   whether the five DevConsole-only collections hold data are all **unknown**.
2. **Firestore rules are not in version control** — the current security posture
   cannot be audited from the repository.
3. **Name-derived document ids** cannot be mapped to users mechanically.
4. **`Results` vs `ActualStudentResults`** overlap with no documented precedence.
5. **Firebase Storage has no backup.**
6. **All uploaded files are public**, across every tenant.

---

## Recommendation

# NEEDS A DESIGN DECISION

Two blockers, and neither is technical.

**First — the scope question, which only you can answer.** The Firestore
business data belongs almost entirely to `abhigyan-gurukul-main`, a separate
application that is still actively developed (last commit 2026-08-11) and is not
one of the four products that make up the B2B platform. It has already moved its
login to platform-core, so it is mid-migration by accident rather than by plan.

Three futures give three completely different migrations:

- *Retire the site* — migrate only what the platform reads (`studentLeaves`,
  `Users`), delete the rest. Smallest scope by far.
- *Migrate the site onto the platform* — all seventeen collections, six new
  models, 29 files rewritten. Largest scope.
- *Keep the site as-is* — then Firestore is not decommissioned at all, and the
  honest answer is to isolate it rather than pretend otherwise.

Designing the migration before this is decided would mean building for a target
that does not exist yet. I can specify all three; I should not pick one.

**Second — I could not read the live data.** A migration's batching, duplicate
rules, quarantine handling and verification thresholds are all functions of the
actual data: how many `studentLeaves` documents, how many resolve to a real
user, whether `Results` and `ActualStudentResults` overlap or partition, whether
the five DevConsole-only collections are empty. Every one of those is currently
a guess, and the P6–P8 pattern has been that guessed payload shapes are wrong in
ways that fail silently.

**To make this READY TO IMPLEMENT, I need:**
1. A decision on the legacy website's future.
2. A working Firestore read credential, so the inventory can carry real counts.
3. A precedence rule for `Results` vs `ActualStudentResults`.
4. Confirmation of whether `users` (lowercase) is a real collection.

With those four, the design above becomes executable and I would estimate the
work as four phases: dead-code removal and Storage hardening (independent of any
decision, and worth doing now), new models and APIs, the migration tooling with
its scratch rehearsal, then cutover and retirement.

**One thing is worth doing regardless of the decision:** the Storage findings.
`materials/` and `study-resources/` already share a path namespace across
tenants, and every uploaded file is world-readable. That is a live multi-tenant
exposure today, it has nothing to do with Firestore, and it should not wait
behind a product decision.
