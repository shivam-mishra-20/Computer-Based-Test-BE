# Organization registration

How an institute goes from a public web form to a provisioned tenant with an
`orgId`, and where each part of that lives.

```
abhigyan-gurukul-main            /register-institute
        │                        public, no account, no Firestore
        ▼
central-be                       POST /api/public/organization-registration
        │                        OrganizationRegistration  ·  status PENDING
        ▼
platform-console                 /registrations
        │                        staff read → approve / reject / request info
        ▼
central-be                       POST /api/platform/registrations/:id/approve
        │                                  │
        │                                  └── onboardOrganization()   ← EXISTING
        ▼
Org + roles + entitlement + admin          real orgId
        │
        ▼
platform-console                 branding · classes · subjects · plan · modules
        │
        ▼
client-platform-app              config/organizations/<slug>.js  →  EAS  →  .aab
```

Two things are worth stating before anything else, because everything below
follows from them.

**The public site never creates a tenant.** It writes one document to one
collection. No `Org`, no `User`, no `Role`, no `Subscription`, no entitlement.
An unauthenticated form that could mint tenants would mean anyone could, and a
rejected applicant would leave a real organization behind.

**Approval does not re-implement provisioning.** It calls
`onboardOrganization()` — the same orchestrator `POST /api/platform/orgs/onboard`
uses. There is exactly one provisioning sequence in this codebase.

---

## Lifecycle

```
PENDING ──────────► APPROVED       an Org exists; orgId is linked
   │  ▲
   │  └── INFO_REQUESTED           staff need more from the applicant
   │
   └────────────► REJECTED         no Org was created
```

`APPROVED` means an organization was **created**. It does not promise the
organization is fully **configured** — onboarding can partially succeed, and
that is recorded separately:

| Field | Meaning |
|---|---|
| `orgId`, `orgSlug` | the tenant this became |
| `provisioningComplete` | `false` after a partial (207) run |
| `provisioningSteps` | every step and its outcome, from the last run |

A partial run is not a fifth status. A half-configured organization is still an
approved registration; what it needs is a retry, not a different verdict.

---

## The public API

```http
POST /api/public/organization-registration
```

Unauthenticated. Rate limited by IP through the existing `publicFormLimiter`
(`PUBLIC_FORM_RATE_LIMIT_MAX`, default 20/hour).

**Accepts** — and reads nothing else, so extra keys in the body are ignored
rather than mass-assigned:

`organizationName`, `organizationType`, `contactName`, `designation`, `email`,
`phone`, `city`, `state`, `country`, `estimatedStudents`, `estimatedTeachers`,
`message`, and `website` (the honeypot).

**Returns 201** with a quotable reference and nothing internal:

```json
{
  "message": "Your institute registration has been submitted successfully. …",
  "registration": {
    "reference": "REG-537F46AE",
    "organizationName": "Northgate Science Academy",
    "status": "PENDING",
    "submittedAt": "…"
  }
}
```

No database id, no `orgId`, no IP, no review field. The reference is the last
eight characters of the ObjectId — enough for staff to find the row, and not
the id itself.

**Returns 400** with per-field messages, so a form can highlight all six
mistakes at once rather than revealing them one submit at a time.

### Why a duplicate is a 201

The realistic failure modes are a double-click, a refresh, a back-button
resubmit and a retry after a timeout the client could not distinguish from a
failure. Answering 409 to any of those tells someone who did nothing wrong that
something went wrong, and their natural response — submitting again — makes it
worse.

So a repeat of the same `email + institute name` inside **24 hours** returns the
original registration and the same confirmation. The applicant sees one clean
outcome; staff see one row.

### The honeypot

`website` is a field no human sees, can tab to, or is told about. Scripted
submitters fill every input they find. A non-empty value gets the **same 201**
a real submission gets, and nothing is written — a bot told it failed simply
retries with the field removed.

---

## The staff API

All under `/api/platform/*`, so all behind `requirePlatformDeployment`
(`TENANT_MODE=claim`) **and** a `PlatformUser` token.

| Endpoint | Capability |
|---|---|
| `GET /registrations` | `org.read` |
| `GET /registrations/:id` | `org.read` |
| `POST /registrations/:id/approve` | `org.manage` |
| `POST /registrations/:id/reject` | `org.manage` |
| `POST /registrations/:id/status` | `org.manage` |

Reading takes `org.read` because reading is reading. Approving takes
`org.manage` because approving **provisions a tenant** — the same capability
`/orgs/onboard` requires, since approval is that call.

The list withholds `submittedIp`; the detail view includes it, and opening a
detail view is itself audited, because that is personal data and "who looked at
it" is the question an audit exists to answer.

---

## Approval

`POST /api/platform/registrations/:id/approve` takes the same optional blocks
`onboardOrganization()` does — `branding`, `locale`, `configuration`, `policy`,
`subscription`, `customRoles`, `admin` — plus a `slug` for the first run.

It answers **200** when onboarding completed and **207** when it partially
succeeded, preserving the existing semantics exactly.

### Repeated approval is safe, in three layers

1. **The slug is stored on the first run** and reused on every later one, so
   the identity being provisioned cannot drift if someone corrects a typo in
   the institute's name.
2. **`onboardOrganization()` step 1 resumes an existing slug** rather than
   failing — its documented behaviour, and the reason no lock is needed.
3. **`orgId` is written back**, so a retry reports `created: false`.

Step 8 is idempotent the same way: an administrator with that email inside the
org is found rather than duplicated.

Verified in `scripts/safety/organization-registration.e2e.test.ts`: approving
twice leaves exactly one organization and one administrator.

---

## The administrator

Optional at approval. Staff may provision the organization first and add its
administrator later from the organization screen.

**The password is typed by staff in the console.** It never travels through the
public form, is never returned by any endpoint, and is never rendered anywhere.

> **Operational gap.** This repository has **no mail service** — no nodemailer,
> no SendGrid, no Resend — and no password-reset flow. So credential handover
> is manual and out of band: staff tell the institute directly. This is a real
> gap, documented rather than papered over with a mock mailer. When a mail
> service is introduced, the right fix is an invitation link rather than
> emailing a password.

---

## Notifications

**There are none, and none were faked.**

An audit of `central-be` found no mail infrastructure of any kind. Rather than
add a mock, all four notification points stay in-console:

| Intended | Today |
|---|---|
| Registration received → registrant | The confirmation screen and its reference |
| New registration → staff | The `/registrations` queue, filtered to PENDING |
| Approved → registrant | Staff contact the applicant directly |
| Rejected → registrant | Staff contact the applicant directly |

`INFO_REQUESTED` exists for the same reason: the request itself is made out of
band, and the status stops the queue presenting the row as untouched.

---

## Audit

Uses the existing `PlatformAudit` collection through `recordPlatformAction()`.
No second audit system.

| Action | When |
|---|---|
| `registration.view` | a detail view is opened |
| `registration.approve` | first approval — carries the resulting `orgId` |
| `registration.approve.retry` | a later approval, distinguished on purpose |
| `registration.reject` | rejected |
| `registration.request-info` | marked as awaiting the applicant |
| `registration.reopen` | put back in the queue |

Submission itself is not a `PlatformAudit` entry: that collection records what
*staff* did, and the registration document already carries its own
`createdAt`, `source` and `submittedIp`.

---

## Registration vs Organization

| | `OrganizationRegistration` | `Org` |
|---|---|---|
| Created by | anyone, publicly | platform staff, via approval |
| Tenancy | `tenantScoped: false` — belongs to no org | **is** the tenant |
| Means | "we would like to join" | a real tenant with roles and entitlements |
| Deletable | yes, it is a lead | no, it owns data |

The link is one-directional: a registration points at the org it became. An org
does not point back — it records the registration id in its `notes`, so the
provenance reads without a join.

---

## After approval

The organization is a **normal tenant**. Nothing about being born from a
registration makes it special: same tenancy plugin, same RBAC, same
entitlement resolution.

1. **Configure it** in the console — branding, classes, subjects, rooms,
   policies, plan and modules. Deliberately *not* on the public form: those are
   twenty minutes of decisions nobody can make before they have agreed to use
   the product.
2. **Then the mobile app.** Copy the `orgId` into
   `client-platform-app/config/organizations/<slug>.js`, add the five assets,
   register it, and build. See `docs/white-label.md` in that repository.

The registration flow does **not** build or publish anything. It ends at a
provisioned organization with a real `orgId`.

---

## Security boundaries

| Boundary | Enforced by |
|---|---|
| Public cannot create tenants | the endpoint only writes `OrganizationRegistration` |
| Public cannot set privileged fields | the handler picks fields explicitly |
| Public cannot reach the staff API | `requirePlatformDeployment` + `platformAuthMiddleware` |
| Tenant users cannot review | the platform surface rejects tenant tokens |
| Read ≠ approve | `org.read` vs `org.manage` |
| Spam | IP rate limit, honeypot, 24-hour dedupe, length caps |
| Error leakage | 500s return a fixed sentence; the detail is logged |

Verified end to end — including a tenant token being refused and a `support`
user being unable to approve — in
`npm run safety:registration-e2e -- --scratch-suffix scratch_reg`.

---

## Legacy Firestore

Untouched, and deliberately separate.

Firestore in `abhigyan-gurukul-main` is **Abhigyan Gurukul's own legacy store**:
one institute's students, results and fees. A platform registration is a
prospective *tenant*, and the tenant registry lives in central-be. Writing it to
Firestore would put the authoritative copy of a platform record inside one
customer's database.

The new page uses `src/lib/organizationRegistrationApi.js` → `apiFetch` →
central-be. It imports no Firebase module. Every existing Firestore feature on
that site is unchanged.
