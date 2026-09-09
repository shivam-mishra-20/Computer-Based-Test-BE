# Organization finalization and the white-label handoff

What happens after an organization exists, and how it becomes a mobile app.

```
PUBLIC REGISTRATION          abhigyan-gurukul-main  /register-institute
        ↓
STAFF APPROVAL               platform-console  /registrations
        ↓
PROVISIONING                 onboardOrganization()          → real orgId
        ↓
FINALIZATION                 console → Organization → Branding tab
        ↓
MOBILE CONFIGURATION         console → Organization → Mobile app tab
        ↓
READINESS VALIDATION         mobileBuildRules.ts             NOT_CONFIGURED
        ↓                                                  → INCOMPLETE
GENERATE BUILD CONFIG        console → Generate             → READY
        ↓
DEVELOPER EAS BUILD          client-platform-app  (manual)
        ↓
PLAY STORE / APP STORE       (manual — not automated, see below)
```

Registration and approval are covered in
[organization-registration.md](./organization-registration.md). This document
starts at a provisioned organization.

---

## The one distinction that matters

Every value on an organization is one of two kinds, and confusing them is the
expensive mistake.

| | **Runtime** | **Build-time** |
|---|---|---|
| Lives in | `Org.branding` | `Org.mobile` |
| Console tab | **Branding** | **Mobile app** |
| Changing it costs | a save | **a new binary and a store release** |
| Takes effect | next `/api/me/context` | next install |
| Examples | app name, tagline, colours, logo URL, document header | Android package, iOS bundle id, scheme, API base URL |

An Android package name is Google Play's primary key. Change it after release
and the store does not see an update — it sees a different application, and
every existing install stops receiving one. The same is true of an iOS bundle
id. That is why they are on a separate tab with a different warning, and why
editing them needs a different capability.

### Which values live where

| Value | Stored in | Kind |
|---|---|---|
| `name`, `slug`, `status` | `Org` | identity, set at provisioning |
| `appName`, `tagline` | `Org.branding` | runtime |
| `primaryColor`, `secondaryColor`, `accentColor` | `Org.branding` | runtime |
| `splashBackgroundColor`, `logoUrl`, `splashImageUrl`, `faviconUrl` | `Org.branding` | runtime |
| `documentHeader`, `documentAddress`, `emailFromName` | `Org.branding` | runtime |
| `androidPackage`, `iosBundleId`, `scheme` | `Org.mobile` | **build-time** |
| `apiBaseUrl`, `version`, `backgroundColor` | `Org.mobile` | **build-time** |
| `assetsReady`, `assetsNote` | `Org.mobile` | operational flag |
| the five PNG files | `client-platform-app/assets/<slug>/` | **build-time, not in this database** |

---

## Build readiness

Three states, derived from the configuration — never set by hand.

| Status | Meaning |
|---|---|
| `NOT_CONFIGURED` | No native identity entered. Nobody has started. |
| `INCOMPLETE` | Started, but something required is missing or invalid. |
| `READY` | Every rule passes. A developer can build this organization. |

`NOT_CONFIGURED` is kept distinct from `INCOMPLETE` on purpose: "nobody has
touched this" and "somebody tried and it is wrong" are different pieces of
operational news, and a queue that renders them identically hides the second.

### The rules

Checked for a **production** profile, which is what the console asks:

- `orgId` present, and not a `pending:` placeholder
- `slug` present and valid kebab-case
- `appName` and `tagline` present
- `androidPackage` and `iosBundleId` valid lowercase reverse-DNS, ≥ 2 segments
- `scheme` a usable URL scheme
- four valid hex colours
- `apiBaseUrl` present, `https`, ending in `/api`, and **not** a loopback host
  (`localhost`, `127.0.0.1`, `0.0.0.0`, `10.0.2.2`)
- `assetsReady` ticked
- and, enforced separately by the server: `androidPackage`, `iosBundleId` and
  `scheme` unique across **every** organization

### One validator, not two

The rules live in **`central-be/src/core/platform/mobileBuildRules.ts`** and are
mirrored, byte for byte below the file header, into
**`platform-client-core/src/mobileBuild.ts`**, which is what
`client-platform-app/config/resolve.js` validates with at build time.

- **`central-be`** — answers readiness and refuses generation
- **`client-platform-app`** — refuses the build itself

`npm run safety:mobile-rules` compares the two files and fails on any
difference, so the guarantee survives the split. It skips — loudly — where the
`platform-client-core` checkout is absent, which is the normal state inside a
container.

### Why mirrored rather than imported

The backend imported `@platform/client-core` briefly, and it broke the
production container. That package is a **sibling git repository**, so
`file:../platform-client-core` resolves on a developer's machine and nowhere
else; Railway clones this repository alone. npm does not verify a `file:`
target exists — it records `{"resolved": "../platform-client-core", "link":
true}` and exits 0 — and `esbuild --packages=external` leaves bare imports
unresolved, so the failure surfaced only at `node dist/server.js`.

A server has to be installable from its own checkout. There was a direction
problem underneath the packaging one too: that package describes itself as
shared by the two *clients*, and a server depending on a client package has its
arrows backwards.

This is the point of the whole arrangement. A console that reports READY for a
build the app then refuses is worse than a console with no readiness at all: it
moves the failure to the person least able to diagnose it, and it trains people
to ignore the status. `organization-finalization.e2e.test.ts` feeds the same
record to both and asserts they agree.

The app additionally checks what only it can see — that the five image files
exist on disk, and that a leftover `android/` directory does not belong to a
different organization. The server cannot check either, which is why
`assetsReady` is a flag staff set rather than something claimed automatically.

---

## Capabilities

| Action | Capability | Roles today |
|---|---|---|
| View mobile configuration | `org.read` | owner, support, billing, engineer |
| **Edit native identity** | **`app.manage`** | **owner, engineer** |
| **Generate build config** | **`app.manage`** | **owner, engineer** |
| Reconcile | `org.read` | all |
| Edit branding | `org.manage` | owner |
| Administer the organization | `org.manage` | owner |

`app.manage` is new and deliberately narrow. The `engineer` role holds it
because the engineer is who actually runs the build — but it grants nothing
else: an engineer still cannot create, suspend or otherwise administer an
organization. It is a sideways grant, not a step toward `org.manage`.

Every route sits behind `requirePlatformDeployment` (so `/api/platform/*`
exists only where `TENANT_MODE=claim`), then `platformAuthMiddleware`, then the
capability. Verified: anonymous → 401, tenant admin → refused, `support`
attempting an edit → 403.

---

## Native assets

**The console does not store or generate artwork, and does not pretend to.**

The five images a build bundles live in the app repository, at
`client-platform-app/assets/<slug>/`:

`icon.png` · `adaptive-icon.png` · `splash.png` · `logo.png` · `onboarding.png`

This server cannot see that repository, so it cannot verify them. Instead staff
tick **assetsReady** once the files really exist, and readiness requires it.
That flag is a claim, not a proof — which is why the build checks the files
itself and refuses regardless of what was ticked. Two independent checks, and
the one that can actually see the disk has the final say.

`npm run org:assets` in the app repository draws placeholders from the
organization's declared colours when real artwork is not ready. They are
placeholders, clearly, and meant to be overwritten.

Runtime images (`logoUrl`, `splashImageUrl`) are a different thing entirely:
URLs the clients fetch at run time, changeable without a build. The Branding
tab says so on each field.

---

## Generating the build configuration

`POST /api/platform/orgs/:orgId/mobile/build-config` — `app.manage`.

Produces, entirely from the organization record:

- the complete `config/organizations/<slug>.js` file
- the two lines to add to `config/registry.js`
- the `eas.json` profile
- the ordered commands
- the asset directory path

**It refuses when the organization is not ready**, answering `422` with the
exact missing requirements. Generating a file with placeholders would move the
failure from here — where it names the field — to `expo prebuild`, where it
names a stack frame. Nothing is defaulted, invented or substituted; a value
absent from the record is a refusal, not a guess.

---

## Reconciliation

Generation is a snapshot. The moment the file is in the app repository it can
be edited, and a build made from an edited file no longer matches the record it
came from — invisibly, because the app still compiles and runs.

So the two can be compared:

```bash
# in client-platform-app
ORG_ID=<slug> npm run org:export
```

That prints the identity the build would actually use. Paste it into
**Mobile app → Reconcile**, and every drifted field is reported with both
values. Compared: `orgId`, `slug`, `appName`, `tagline`, `androidPackage`,
`iosBundleId`, `scheme`, `apiBaseUrl` and the four colours.

Colours differing only in case are not a mismatch — `#4F46E5` and `#4f46e5` are
the same colour, and reporting that would teach people to ignore the report.

A mismatch is audited. A clean comparison is not, because recording every
successful check would bury the entries that matter.

---

## The developer handoff

The console **does not build anything**. It ends at text.

1. Open the organization → **Mobile app** → confirm **Ready for build**
2. **Generate build configuration**
3. In a checkout of `client-platform-app`:
   - save the file as `config/organizations/<slug>.js`
   - add the registry lines and the `eas.json` profile
   - put the five images in `assets/<slug>/`
4. Then:

```bash
ORG_ID=<slug> npm run org:preview        # resolves; nothing is built
ORG_ID=<slug> npx expo prebuild --clean
eas build --profile org-<slug> --platform android
```

`org:preview` is the last checkpoint before EAS: it runs the same validator
again, against the file as it now exists on disk, including the asset files.

---

## Audit

Uses the existing `PlatformAudit` collection. No second audit system.

| Action | When |
|---|---|
| `mobile.view` | the mobile tab is opened |
| `mobile.update` | native identity changed — carries the diff |
| `mobile.readiness` | the status changed, naming both ends |
| `mobile.generate` | a build configuration was generated |
| `mobile.mismatch` | a reconciliation found drift |

`mobile.readiness` is recorded separately from `mobile.update` because
readiness changing is the operationally interesting event — it is what decides
whether a build can be handed over — and burying it in a field diff would make
it unsearchable.

---

## What is NOT automated

Stated plainly, because the gap is real:

- **No EAS integration.** No API token, no remote trigger, no build status. The
  console holds no EAS credentials of any kind.
- **No store publishing.** Nothing connects to Play Console or App Store
  Connect. No signing credentials are handled.
- **No artefact storage.** No AAB or IPA passes through this system.
- **No asset upload.** Native artwork is placed in the app repository by hand.

The developer step is a real, manual step performed by a person with a
checkout and EAS credentials. This phase ends at a validated configuration and
a handoff.
