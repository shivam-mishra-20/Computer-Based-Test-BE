# Abhigyan Hardcoding Audit (P4)

Every institution-specific assumption, where it lived, where it lives now, who
owns it, what happens when it is unconfigured, and what covers it.

**The rule this phase obeys:** moving a value from code to data must not change
behaviour. Every resolver falls back to the legacy constant, so an organization
with no configuration behaves exactly as production does today. Configuration
starts applying when someone configures something — never as a side effect of
deploying this code.

That fallback discipline is now the **fourth** instance of one pattern:

| # | Where | The trap |
|---|---|---|
| 1 | Cron default | A defaulted `pinned` mode would have disabled attendance sync |
| 2 | Middleware gate | A defaulted `pinned` mode with no `ORG_ID` would have 503'd **every request** |
| 3 | Entitlements | "No subscription" meaning "no modules" would have 403'd every gated route |
| 4 | Configuration | "No rows" meaning "no class levels" would blank every picker |

> A safe default for the NEW model is not a safe default for BEHAVIOUR.
> Absent configuration must mean "as before", never "nothing".

---

## Moved to organization configuration

| Hardcoding | Source location | New configuration source | Owner | Default when unconfigured | Regression coverage |
|---|---|---|---|---|---|
| `SUPPORTED_CLASS_VALUES = ['7'…'12']` | `config/studentBatchConfig.ts:1`, `services/batchConfigService.ts:18` | `ClassLevel` collection | Tenant admin | `legacyClassLevels()` — same 6 keys, `Class N` labels, both alias spellings | `org-config.test.ts` — keys match the live constant exactly |
| `normalizeClassValue()` digit regex | `config/studentBatchConfig.ts:4` | `resolveClassKey()` — key → label → alias | Platform | Same behaviour for numeric input | `org-config.test.ts` — `"Dropper"` resolves; `"Batch 11 Evening"` does not leak a digit |
| `CURRICULUM_SUBJECTS` (15 Indian K-12 subjects) | `config/subjects.ts` | `Subject` collection | Tenant admin | `legacySubjects()` — same 15, same order | `org-config.test.ts` — array equality against the live constant |
| `ROOMS` (Room 1–11) | `models/RoomAllocation.ts:7` | `OrgRoom` collection | Tenant admin | `legacyRooms()` — same 11 names | `org-config.test.ts` — count and names |
| `ROOM_CAPACITY` map | `models/RoomAllocation.ts:23` | `OrgRoom.capacity` | Tenant admin | Same per-room values | `org-config.test.ts` — every capacity, plus Room 10 = 10 specifically |
| `MERGED_BATCH_NAME = 'Advanced/Basic'` + `isAdvancedLabel`/`isBasicLabel` | `services/batchConfigService.ts:19–28` | `OrgPolicy.batch.mergeRules` | Tenant admin | `[{ merge: ['Advanced','Basic'], into: 'Advanced/Basic' }]` | `seed-org-config.ts` equivalence |
| Marking scheme `+1 / 0 / 0` | `models/Exam.ts:79–81` | `OrgPolicy.exam.markingScheme` | Tenant admin | Identical | `seed-org-config.ts` — exam policy IDENTICAL |
| `submitLockPercent: 50` | `models/Exam.ts:91` | `OrgPolicy.exam.submitLockPercent` | Tenant admin | `50` | ” |
| `shuffleQuestions: true` / `shuffleOptions: false` | `models/Exam.ts:65–66` | `OrgPolicy.exam` | Tenant admin | Identical | ” |
| Violation threshold `10` | `cbt-exam` web player | `OrgPolicy.exam.violationThreshold` | Tenant admin | `10` | ” |
| Attendance timings (`10:30`/`19:30`, grace, hour thresholds, deduction) | `models/AttendanceRule.ts:51–59` | `OrgPolicy.attendance` | Tenant admin | Identical seven values | `seed-org-config.ts` — attendance IDENTICAL |
| Timezone `Asia/Kolkata` | `models/Exam.ts:87` | `Org.locale.timezone` / `OrgPolicy.locale` | Tenant admin | `Asia/Kolkata` | `org-config.test.ts` |
| Currency / language | implicit INR / English | `Org.locale` | Tenant admin | `INR` / `English` | ” |
| Institute name, colours, app name | `lib/theme/colors.ts`, `app.json`, `services/aiContent/brandAssets.ts` | `Org.branding` | Tenant admin | Seeded for Org 001 from the current values | `seed-org-001.ts` |
| PDF/report header | `services/aiContent/paperExport.ts` | `Org.branding.documentHeader` | Tenant admin | `Abhigyan Gurukul` for Org 001 | ” |
| Splash / favicon / accent | `app.json` (`#F7F7F7`) | `Org.branding.splash*`, `faviconUrl`, `accentColor` | Tenant admin | Unset → client default | — |
| Email sender identity | implicit | `Org.branding.emailFromName` | Tenant admin | Unset | — |
| **eTimeOffice Basic-auth credential** | `services/EtimeService.ts:25` — **a literal in source** | `Integration` collection, AES-256-GCM sealed | Tenant admin | No integration → feature inactive | `org-config.test.ts` — sealing, tamper detection, refusal without a key |
| Grading bands | implicit / absent | `OrgPolicy.grading` | Tenant admin | 7-band A+…F, pass 33% | `seed-org-config.ts` |
| Leave quota | implicit | `OrgPolicy.leave` | Tenant admin | 12, approval required | ” |

---

## Deliberately NOT moved in P4

| Item | Why |
|---|---|
| `CORS_ORIGIN` fallback list incl. `abhigyangurukul.com`, `*.vercel.app` | Already env-driven; production sets `CORS_ORIGIN`. Changing the fallback alters request admission — a live behaviour change with no test able to prove it safe short of deployment. Resolves from `Org.domains` when custom domains ship. |
| `ClassQuestion` dynamic `class_*` collections | Explicitly out of scope. Needs its own migration after tenancy is stable. |
| `EtimeService` credential **removal from source** | The `Integration` model and sealing exist; rewiring `EtimeService` to read from it changes the live attendance pull. Deferred to the deployment window with the legacy regression suite running. |
| Teacher analytics `user` vs `userId` | Pre-existing, unrelated to configuration, and fixing it changes an endpoint from returning `[]` to returning data. |

---

## Plugin defect found by this phase

The configuration-seeding equivalence check compared resolver output before and
after seeding and found them differing. The values were byte-identical; the
difference was a stray `orgId` **inside** the nested `exam` and `attendance`
objects.

Cause: `mongoose.plugin()` applies to **every** schema a process compiles,
including those Mongoose creates implicitly for a nested `type: {...}`
definition. Since P1 the tenant plugin had been adding `orgId` and `branchId`
inside `User.settings`, `Org.branding`, `User.learnerProfile`, `OrgPolicy.exam`
and every other nested object in the codebase.

Impact: duplicated meaningless keys, and — worse — a nested `orgId` that *looks*
authoritative while being filtered by nothing, since query middleware only ever
runs on the parent model.

Fixed by skipping `$implicitlyCreated` / `$isSingleNested` /
`$isArraySubdocument` schemas. A tenant key belongs on the document a query can
filter; embedded objects are reached only through an already-scoped parent.
Covered by three checks in `tenancy.test.ts`.

---

## Acceptance: Org 002 without source changes

| Dimension | Org 001 | Org 002 | Source edit needed |
|---|---|---|---|
| Class levels | Class 7–12 | Class 9–12 **+ Dropper** | **No** |
| Subjects | 15 K-12 subjects | PCM/PCB only | **No** |
| Rooms | Room 1–11, mixed capacity | Hall A/B, Lab 1/2 | **No** |
| Batches | Advanced/Basic merge | JEE-Main / JEE-Adv / NEET / Foundation | **No** |
| Marking | +1 / 0 / 0 | +4 / −1 / 0 | **No** |
| Branding | Green/indigo | Orange/navy | **No** |
| Modules | All | Exams, QB, Import, Results, Rankings, Homework, Doubts | **No** |
| Timezone/currency | Asia/Kolkata, INR | Configurable | **No** |

`"Dropper"` is the specific case the old `normalizeClassValue()` rejected
silently — it matches `/(\d{1,2})/` and returns `null` for any label without
digits, so a coaching institute's dropper batch failed validation with a message
no admin could act on. It now resolves.
