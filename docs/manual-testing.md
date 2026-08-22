# Manual testing — the multi-tenant platform

Everything here runs against **scratch databases**. Nothing in this document
touches `abhigyangurukul`, and the two helper scripts refuse to when asked.

The credentials below are **fixture credentials that exist only in scratch
databases**. They are in source (`seed-p6-fixture.ts`,
`seed-console-login-fixture.ts`) so that anyone can re-run these tests. None of
them exist in production, and none of them should ever be created there.

Commands are written for PowerShell, which is the shell in use here. In Git Bash
the only difference is `export VAR=value` instead of `$env:VAR = value`.

---

## 0. One-time setup

Run from `c:/Users/Shivam/cbt-exam-be`.

```powershell
# Tenant fixture: two organizations, four users each, deliberately different
# configuration so a client that ignores tenancy fails visibly.
$env:P6_MONGO_URI = npm run --silent platform:uri p6_client_platform_web_scratch
node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only scripts/safety/seed-p6-fixture.ts

# Content: exams, questions, an attempt to review
node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only scripts/safety/seed-p7-content.ts

# Platform staff with known passwords
$env:CONSOLE_FIXTURE_MONGO_URI = $env:P6_MONGO_URI
node -r ./scripts/safety/dns-preload.js -r ts-node/register/transpile-only scripts/safety/seed-console-login-fixture.ts
```

Already seeded as of 2026-08-22 — skip this unless you have wiped the database.

---

## 1. Start the backend

One command, in its own terminal, and **no environment variables**:

```powershell
npm run p6:serve
# [p6] serving p6_client_platform_web_scratch on port 5055 (TENANT_MODE=claim)
```

It reads the scratch database name from `.p6-uri`, sets `TENANT_MODE=claim`,
`TENANT_ENFORCEMENT=warn`, cron off, workers off, and refuses to start against
production. Leave it running. Everything else talks to it.

To serve a *different* scratch database, name it:

```powershell
$env:P6_MONGO_URI = npm run --silent platform:uri abhigyangurukul_restore_2026_08_17
npm run p6:serve
```

> **`TENANT_ENFORCEMENT=warn` means writes are stamped with `orgId` but reads
> are NOT filtered.** That is the production-safe setting for the migration
> window, and it is also why a cross-tenant leak in this mode looks exactly like
> working software. Worth keeping in mind if you go hunting for isolation bugs
> by hand.

---

## 2. Credentials

### Platform staff — the console

| Role | Email | Password | Holds |
|---|---|---|---|
| owner | `p10a-owner@platform.test` | `bootstrap-owner-password` | everything |
| support | `p10a-support@platform.test` | `support-account-password` | `org.read`, `impersonate`, `audit.read` |

Two accounts on purpose: support is what tells a screen that is *hidden by
capability* from one that is *broken*.

### Tenant users — the web and mobile clients

**Org 001 — Abhigyan Gurukull** (`abhigyan`), password `P6-fixture-abhigyan!`

| Role | Email |
|---|---|
| admin | `p6.admin@abhigyan.fixture` |
| teacher | `p6.teacher@abhigyan.fixture` |
| student | `p6.student@abhigyan.fixture` (Class 11, batch Aarambh) |
| front desk | `p6.frontdesk@abhigyan.fixture` |

**Org 002 — ABC Coaching Institute** (`abc-coaching`), password `P6-fixture-abc!`

| Role | Email |
|---|---|
| admin | `p6.admin@abc.fixture` |
| teacher | `p6.teacher@abc.fixture` |
| student | `p6.student@abc.fixture` (Class 11, batch JEE Main) |
| front desk | `p6.frontdesk@abc-coaching.fixture` |

Front desk is the interesting one: its *legacy* role is `admin`, so the route
guard lets it in, while its assigned RBAC role narrows what it can actually do.
That separation is what lets you tell a permission gate from a role redirect.

---

## 3. The platform console

```powershell
cd c:/Users/Shivam/platform-console
npm run dev
# -> http://127.0.0.1:3100
```

No environment variable: `platform-console/.env.local` already names the
backend. If you see `ERR_CONNECTION_REFUSED` on `/api/platform/login`, that file
is what to check — see [Troubleshooting](#troubleshooting).

> The console's `NEXT_PUBLIC_API_BASE_URL` has **no** `/api` suffix; the web
> client's variable of the same name **does**. Two repos, one name, two
> conventions.

### Sign-in

1. Open the console signed out — an email and password form, no navigation
   rendered behind it.
2. Right email, wrong password — `Invalid credentials.`
3. An address that does not exist — **the same message**. Deliberate: a
   different message turns the form into an oracle confirming which of your
   staff addresses are real.
4. Sign in as owner — dashboard, seven nav items.
5. Reload — still signed in.
6. Sign out — back to the form. Reload — still signed out.
7. Close the tab and reopen — signed out. The token lives in `sessionStorage`,
   so it does not outlive the tab.

### Owner walkthrough

- **Organizations** — three orgs. Open Abhigyan Gurukull: 6 tabs (overview,
  configuration, entitlement, roles, users, audit).
- **Configuration** — 6 class levels (7–12), 15 subjects, 11 rooms. Compare with
  ABC Coaching: 4 subjects, halls and labs, and a class level called `dropper`,
  which is the value the old digit-extracting normalizer silently ate.
- **Entitlement** — ABC's plan withholds `ai`, `aiAnalysis`, `questionImport`,
  `integrations`. Abhigyan has no subscription and therefore resolves to *every*
  module: an unsubscribed organization is the control, not a restricted one.
- **Onboard** — create a fourth organization end to end; watch the 8 steps.
- **Plans** — create one, withdraw it.
- **Platform Staff** — create a `billing` account, disable it, enable it.
  Disabling bumps `tokenVersion`, so its tokens die immediately rather than at
  expiry. Verify by keeping that account signed in in another browser.
- **Audit** — your own actions, including the login.

### Capability filtering

Sign out, sign in as **support**:

- `Onboard` and `Platform Staff` are gone from the nav.
- Type `http://127.0.0.1:3100/staff` directly — *"Your platform role cannot
  manage staff."*

The hidden nav item is a convenience. This is the control:

```powershell
$S = (curl.exe -s -X POST http://127.0.0.1:5055/api/platform/login -H "Content-Type: application/json" -d '{\"email\":\"p10a-support@platform.test\",\"password\":\"support-account-password\"}' | ConvertFrom-Json).token

# the call the UI hides
curl.exe -s -w "`nHTTP %{http_code}`n" http://127.0.0.1:5055/api/platform/staff -H "Authorization: Bearer $S"
# -> {"message":"Your platform role does not permit this.",
#     "code":"PLATFORM_CAPABILITY_DENIED","required":"staff.manage"}
#    HTTP 403

# a capability it does hold still works
curl.exe -s -o NUL -w "HTTP %{http_code}`n" http://127.0.0.1:5055/api/platform/orgs -H "Authorization: Bearer $S"
# -> HTTP 200
```

> **`curl` in Windows PowerShell 5.1 is an alias for `Invoke-WebRequest`, not
> curl.exe.** Every command here says `curl.exe` on purpose. Written as plain
> `curl`, these fail with a parameter-binding error that looks nothing like the
> thing you were testing. The inner quotes are backslash-escaped for the same
> reason: PowerShell 5.1 strips unescaped ones on their way to a native
> executable, and the server then answers `Expected property name` instead of
> anything about your credentials.

---

## 4. The login endpoint on its own

Five properties, each of which is a decision rather than a default:

```powershell
# ── 1. Login needs NO credential of its own -> 200 ────────────────────────
# If this ever 401s, the route has been mounted below its own auth guard,
# which would mean signing in requires already being signed in.
$P = (curl.exe -s -X POST http://127.0.0.1:5055/api/platform/login -H "Content-Type: application/json" -d '{\"email\":\"p10a-owner@platform.test\",\"password\":\"bootstrap-owner-password\"}' | ConvertFrom-Json).token
$P.Length   # a token, not an error

# ── 2. Wrong password and unknown account are INDISTINGUISHABLE ───────────
curl.exe -s -X POST http://127.0.0.1:5055/api/platform/login -H "Content-Type: application/json" -d '{\"email\":\"p10a-owner@platform.test\",\"password\":\"wrong\"}'
curl.exe -s -X POST http://127.0.0.1:5055/api/platform/login -H "Content-Type: application/json" -d '{\"email\":\"ghost@platform.test\",\"password\":\"wrong\"}'
# both -> {"message":"Invalid credentials."}

# ── 3. The token has aud=platform and NO orgId ────────────────────────────
$mid = $P.Split('.')[1]
$pad = $mid.PadRight([int][Math]::Ceiling($mid.Length/4)*4,'=')
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($pad.Replace('-','+').Replace('_','/')))
# -> {"id":"...","role":"owner","tokenVersion":0,"aud":"platform","iat":...,"exp":...}
#    No orgId. Platform staff belong to no organization, by definition.

# ── 4. A TENANT token cannot reach the platform surface ───────────────────
$T = (curl.exe -s -X POST http://127.0.0.1:5055/api/auth/login -H "Content-Type: application/json" -d '{\"email\":\"p6.admin@abhigyan.fixture\",\"password\":\"P6-fixture-abhigyan!\"}' | ConvertFrom-Json).token
curl.exe -s -w "`nHTTP %{http_code}`n" http://127.0.0.1:5055/api/platform/orgs -H "Authorization: Bearer $T"
# -> {"message":"This credential cannot be used for platform administration.",
#     "code":"TOKEN_AUDIENCE_MISMATCH"}
#    HTTP 403 — refused at the door, before any role or capability is read.

# ── 5. And the reverse ────────────────────────────────────────────────────
curl.exe -s -w "`nHTTP %{http_code}`n" http://127.0.0.1:5055/api/me/context -H "Authorization: Bearer $P"
# -> {"message":"This credential is not valid here.","code":"TOKEN_AUDIENCE_MISMATCH"}
#    HTTP 403
```

---

## 5. The bootstrap script

It creates the very first platform account, and it is the only way in — `POST
/api/platform/staff` requires an authenticated platform user holding
`staff.manage`, which is a deadlock on an empty collection.

**Rehearse the refusals first.** Each should refuse and say why:

```powershell
# no target named
npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts

# production without the typed acknowledgement
$env:PLATFORM_OWNER_EMAIL = "you@example.com"; $env:PLATFORM_OWNER_NAME = "You"
npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --production

# removal against production, ever
npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --production --remove
```

**Then the real thing, on a scratch database with no owner.**
`abhigyangurukul_p10a_scratch` is kept empty for exactly this:

```powershell
$env:PLATFORM_OWNER_EMAIL = "you@example.com"
$env:PLATFORM_OWNER_NAME = "Your Name"
npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --scratch-suffix p10a_scratch
# password prompted, not echoed, never printed back

# run it again -> "already exists — NO CHANGE", and it does NOT reset the password
```

Then confirm the account it made can actually sign in:

```powershell
$env:P6_MONGO_URI = npm run --silent platform:uri abhigyangurukul_p10a_scratch
$env:P6_PORT = "5056"
npm run p6:serve

curl.exe -s -X POST http://127.0.0.1:5056/api/platform/login -H "Content-Type: application/json" -d '{\"email\":\"you@example.com\",\"password\":\"<what you typed>\"}'
```

**Production — Step 25 of the cutover runbook — is yours to run, not mine:**

```powershell
$env:PLATFORM_OWNER_EMAIL = "..."
$env:PLATFORM_OWNER_NAME = "..."
$env:PLATFORM_BOOTSTRAP_ACK = "I am creating a platform owner account"
npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --production
```

---

## 6. The tenant web client

`cbt-exam/.env.local` points at port 5000 — the LEGACY backend — because that
is what day-to-day work on that app uses. For platform testing it has to point
at 5055, and the override must be set **in the same terminal, before**
`npm run dev`:

```powershell
cd c:/Users/Shivam/cbt-exam
$env:NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:5055/api"   # WITH /api suffix
npm run dev
# -> http://localhost:3000
```

A shell variable does beat `.env.local` — Next.js will not overwrite something
already in `process.env` — but only for the process that inherits it. Set it in
a different window and the app silently uses 5000 instead.

**The point is that this is ONE build serving both institutes.** No source
change, no rebuild, no environment flip between them — the tenant comes from the
`orgId` claim inside the token you logged in with.

Sign in as `p6.admin@abhigyan.fixture`, then as `p6.admin@abc.fixture`, and
compare:

| | Abhigyan | ABC Coaching |
|---|---|---|
| Colours, name | its own | different |
| Classes | 7–12 | includes `dropper` |
| Subjects | 15 | 4 |
| Rooms | 11 numbered | halls and labs |
| Marking | +1 / 0 / 0 | competitive |
| AI, question import | present | **absent** — the plan withholds them |

Then sign in as `p6.frontdesk@abhigyan.fixture`: same organization, narrower
role. What disappears now disappears for a *different reason* than the AI module
did for ABC — permission, not entitlement.

---

## 7. The mobile client

```powershell
cd c:/Users/Shivam/client-platform-app
npm start
```

It already defaults to `http://127.0.0.1:5055/api`, which matches `p6:serve`
exactly — nothing to configure for a simulator on this machine. **On a physical
device over Expo Go, `127.0.0.1` is the phone**, so point it at your laptop's
LAN address:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL = "http://192.168.x.x:5055/api"
npm start
```

Same two logins, same comparison. Then: exams list, attempt player, submit,
results. Mark-for-review is flag-only and non-destructive, and correct answers
stay withheld until an attempt's result is published.

---

## 8. Re-running the automated suites

If something looks wrong by hand, these say whether it is new:

```powershell
npm run safety:all                      # 14 suites, no servers needed

$env:P10A_MONGO_URI = npm run --silent platform:uri abhigyangurukul_p10a_scratch
npm run safety:platform-auth            # 61 — login + bootstrap

# with p6:serve on 5055 and the console on 3100 (both suites default to those):
npm run safety:console-login            # 39 — real browser, real credentials
npm run safety:console-ui               # 39 — the twelve screens

$env:P6_MONGO_URI = npm run --silent platform:uri p6_client_platform_web_scratch
npx ts-node --transpile-only scripts/safety/token-audience.test.ts
npx ts-node --transpile-only scripts/safety/two-org-isolation.test.ts --scratch-suffix restore_2026_08_17
npx ts-node --transpile-only scripts/safety/legacy-regression.test.ts --scratch-suffix restore_2026_08_17
```

`safety:console-login` uses the fixture staff accounts and mints nothing.
`safety:console-ui` injects tokens instead, so run
`scripts/safety/mint-platform-tokens.ts` first — they expire in 15 minutes, so
mint immediately before the run.

---

## 9. Teardown

```powershell
Get-NetTCPConnection -LocalPort 5055,5056,3100,3000 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

Scratch databases can be left as they are: the suites clean up after themselves
and the fixtures are idempotent.

---

## Troubleshooting

### `ERR_CONNECTION_REFUSED` on `127.0.0.1:5000/api/platform/login`

The console is pointed at the **legacy** backend's port instead of
api-platform's. Two ports are in play and they are not interchangeable:

| Port | What serves it | Tenancy |
|---|---|---|
| 5000 | the ordinary backend (`npm run dev`) | `pinned` / unset — one institute |
| 5055 | api-platform (`npm run p6:serve`) | `claim` — tenant from the token |

`/api/platform/*` exists on both, so the symptom depends on what is running:
nothing on 5000 gives `ERR_CONNECTION_REFUSED`, and the legacy backend on 5000
gives a working login against the *wrong database*.

Fix `platform-console/.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5055
```

Then restart `npm run dev`. Next.js reads `.env.local` at startup, so an edit
while the dev server is running has no effect until it restarts.

### The console loads but every panel 401s

The token expired — platform tokens last 15 minutes. Sign in again.

### `EADDRINUSE` on 5055 when nothing appears to be running

A previous server left the port held. Find and stop the owner:

```powershell
Get-NetTCPConnection -LocalPort 5055 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

### The web client shows Abhigyan's data no matter who logs in

`NEXT_PUBLIC_API_BASE_URL` was not set in the terminal that started
`npm run dev`, so it fell back to `.env.local` and is talking to the legacy
backend on 5000 — which is pinned to one organization by design.

---

## What manual testing cannot tell you here

Two things, and both are still open:

1. **Production deployment state.** Railway, Vercel, Firebase and DNS are not
   reachable from this machine, so nothing above says anything about what is
   actually deployed.
2. **Firebase credentials.** The local service-account key fails
   `invalid_grant` for Storage, Firestore *and* Auth. That is *this machine's*
   key. It is not evidence either way about production's, which is exactly why
   it needs checking by someone who can open the console.
