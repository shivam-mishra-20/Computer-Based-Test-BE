# Subscriptions — testing by hand

How to exercise the subscription and billing module end to end from the
screens: the platform console (staff), the institute web admin
(client-platform-web), and the public institute application
(abhigyan-gurukul-main). What each step should show is written beside it; if a
screen disagrees, the server is the authority — the screens only show what it
returns.

Design and rules: [subscriptions-plan.md](subscriptions-plan.md).

## 0. Before you start: use a local database

All three front ends point at `http://localhost:5000` (their `.env.local` /
`.env`). Whatever central-be is connected to is what you are testing against,
and these steps **create organizations, trials, invoices and payments**. Do not
run them against production (`abhigyangurukul`, `abhigyangurukul_console`) or
the shared `test` database.

1. Start a local MongoDB on `127.0.0.1:27017` as a single-node replica set
   (MongoDB Community with `--replSet rs0`, or
   `docker run -d -p 27017:27017 mongo:7 --replSet rs0`, then once
   `docker exec -it <id> mongosh --eval "rs.initiate()"`).
2. Run central-be with a **separate** environment, not your usual `.env`. The
   values that matter:

   ```
   MONGO_URI=mongodb://127.0.0.1:27017/ag_manual_existing?replicaSet=rs0&directConnection=true
   PLATFORM_MONGODB_URI=mongodb://127.0.0.1:27017/ag_manual_platform?replicaSet=rs0&directConnection=true
   REDIS_ENABLED=false
   REDIS_URL=redis://127.0.0.1:1
   ENABLE_CRON=false
   PLATFORM_ENABLE_CRON=false
   EXPO_TOKEN=
   APP_BUILD_QUEUE_NAME=app-builds-manual
   ```

   `PLATFORM_ENABLE_CRON=false` keeps the daily sweep off; you do not need it —
   every request brings a subscription's dates up to date by itself.
3. Create the first console account in that platform database. The bootstrap
   script only writes to `<PLATFORM_MONGODB_URI database>_<suffix>`, so run it
   once with the base name and the suffix `platform`:

   ```
   MONGO_URI=mongodb://127.0.0.1:27017/ag_manual_existing?replicaSet=rs0&directConnection=true \
   PLATFORM_MONGODB_URI=mongodb://127.0.0.1:27017/ag_manual?replicaSet=rs0&directConnection=true \
   PLATFORM_OWNER_EMAIL=you@example.com PLATFORM_OWNER_NAME="Your Name" \
     npx ts-node --transpile-only scripts/bootstrap-platform-owner.ts --scratch-suffix platform
   ```

   It asks for the password and writes the owner to `ag_manual_platform`. Then
   create a **billing** and a **support** account from the console's Platform
   Staff page, to check what each role may do.
4. Start the console (`npm run dev` → `http://localhost:3100`), the institute
   web admin and, for section 3, the public site (`npm run dev`).

## 1. Catalogue (console → Plans)

| Do | Expect |
| --- | --- |
| Open Plans with no plans; press **Create default plans** | Starter ₹999 (100 students), Growth ₹2,999 (500), Professional ₹7,999 (1,500), Enterprise (custom). Pressing it again changes nothing. |
| Edit Growth: change only the description | Drawer says "Only presentation is changing"; Save keeps version 1. |
| Edit Growth: set Active students to 600, fill "What changed" | Drawer warns it saves version 2 and how many organizations stay on version 1. **Versions** shows both. |
| Take Professional **off sale** | Badge "Off sale". It disappears from the registration form and from institutes' upgrade choices; organizations already on it keep it. Put it back on sale before section 5. |
| Untick **Listed** on a plan | Same effect on institutes, but it can still be assigned by staff. |
| Sign in as **support** | Every Plans control is disabled; reading works. |

## 2. Registration with a plan choice (public site → console)

| Do | Expect |
| --- | --- |
| Public site → Register your institute → fill the steps → **Plan & legal** | The plans on sale are listed from the server (Enterprise shows "Custom pricing"). Choose **Growth**. Review shows "Plan: Growth". Submit. |
| Console → Registrations → open it | "Plan requested: growth" under Legal and billing. The approval drawer's Plan field defaults to "Applicant's choice (Growth)" and says a 14-day trial will start. |
| Approve (leave Plan as is) | Outcome note: "Growth trial started…". Organization → Subscription: status Trial, Plan Growth v1, trial end 14 days out, managed. |
| Approve again (resume) | Nothing moves: same trial end, same plan. |
| A second application choosing **Enterprise**, approved as is | Note: "no trial was started… set its terms in the console". Subscription tab: "No subscription — core modules only". |
| A third choosing Starter, but pick **Professional** in the approval drawer | The organization trials on Professional; the note says the reviewer chose. |

## 3. One organization's subscription (console → Organization → Subscription)

Use the Growth organization from section 2. Each action asks for a reason;
it shows up in **History** and the platform Audit.

| Do | Expect |
| --- | --- |
| Look at the summary | Status, plan/version/interval, access (read & write), next change (trial end). |
| **Extend trial** by 7 days | Trial end moves; the institute's admin gets an in-app notice "Your trial has been extended". |
| **Change plan** → Starter | Modules and limits follow Starter at once; status and dates unchanged; notice "Your plan has changed". |
| Modules: untick a plan module, tick an add-on; set a limit override (Active students 5); Save | Badges "Removed from plan" / "Add-on"; Usage shows the override; History has "Modules or limits changed". |
| **Record payment**: ₹999, UPI, reference `UTR123`, no "Paid until" | Status Active with a paid-until date one billing interval out; payment listed. Record the same reference again → "already recorded — nothing changed". |
| **Record failed payment** (reference `CHQ1`, reason) | Status "Payment overdue", grace end 7 days out; notice to the admin. |
| **Suspend** | Access becomes read-only (see section 5). **Reactivate** returns it to where it was. |
| **Cancel**, then **Reactivate** | Read-only while cancelled; data untouched. |
| Platform-owned organization (if you mark one) | Lifecycle buttons absent; "never billed, never limited". |

## 4. Invoices and the seller profile (console → Billing)

| Do | Expect |
| --- | --- |
| Billing → Seller profile, empty | "Invoices carry no GST" and what is missing. Fill legal name, address, state, payment instructions; save. |
| Organization → Subscription → **Draft invoice** → "The plan's next period" | Draft for the plan's price, period after current access. No number yet; the institute cannot see it. |
| Open it → **Issue** | Number `INV/26-27/0001`, due in the profile's terms (7 days). Not a tax invoice. The institute's admin gets "New invoice INV/26-27/0001". **Open** / **PDF** show the document. |
| Seller profile: add a GSTIN, rate 18, SAC; issue another invoice | Same state as the buyer → CGST + SGST; different state → IGST. An invalid GSTIN is refused with the reason. Nothing here claims GST compliance — the format needs review before real invoices go out. |
| Issued invoice → **Record payment** | The amount is fixed to the balance; on save the invoice is Paid and the subscription is extended through its period. |
| Issued invoice → **Void** (with a reason) | Void; its number is never reused. A draft can be edited or deleted instead. |
| Billing → Subscriptions → "Something changes soon" (7 days), "Over a plan limit" | Trials/renewals/grace ending soon; organizations over a limit with "Active students: 6/5" style badges. Nothing is removed for being over. |
| Billing → Invoices → Overdue | Issued invoices past their due date. Dashboard shows the same four billing counts. |

## 5. The institute's side (web admin → App Management → Subscription & billing)

Sign in as the organization's administrator. Subscription & billing is its own
entry in the sidebar (Institute section); the old Organization → Plan & billing
link redirects there.

| Do | Expect |
| --- | --- |
| Institute with **no subscription** → Plans & pricing | "Start free trial" on self-serve plans with a trial; "or buy now" under each; Enterprise says "Talk to us". |
| **Start free trial** on Starter → confirm | At once: Overview shows Starter · Free trial, 14 days. Console → Organization → Subscription: trialing, history "Trial started" by the institute. A second trial is refused. |
| During the trial: **Switch trial to Growth** → confirm | Growth now; trial end unchanged; nothing charged. |
| **or buy now** under Professional → **Place order** | With the seller profile's legal name **and** payment instructions filled: an issued invoice at once, shown on the Overview with how to pay; the plan is still Growth. Without them: "invoice on its way" (a draft the console must issue). Ordering again is refused until it is paid or withdrawn. |
| Console → Dashboard / Billing → **Institute orders** (or the organization's Subscription tab → "Orders from the institute") | The order with plan, amount, who ordered, what the institute has now, and its invoice. A draft says "Waiting for you · not invoiced". |
| **Record payment & apply** → reference → Record payment | Draft orders are issued first. The institute is now on Professional, active, paid from the trial end for one month; the order leaves the list. Re-sending the same reference changes nothing. |
| **Apply plan now** (optional reason) | The institute is on the ordered plan at once; the order stays, marked "Plan already applied", and the institute is asked to pay. |
| **Decline** → reason | Plan unchanged; an issued invoice is voided, a draft deleted. The institute's Subscription page shows "Your order … was declined" with your reason until it orders again. |
| Overview → **Withdraw order** (before paying) | Draft deleted, or issued invoice voided; plan unchanged. |
| Active → **Cancel subscription** → Cancel at period end | Still active; banner "Your subscription ends on …"; console shows "Cancels at period end" with who/why. **Keep my subscription** removes it. Left in place, the period end cancels it with no grace (read-only), and ordering a plan still works to come back. |
| While **past due** → Cancel | Cancelled now; an open order is withdrawn with it. |
| Enterprise → **Talk to us** (message) | A request in console → Billing → Requests; resolving it changes nothing by itself. |
| **Invoices & payments** → View / PDF | Only issued, paid and void invoices; never drafts or another institute's. |
| **Billing details** → set GSTIN `27AAPFU0939F1ZV` | Saved; state filled in from it. A wrong check character is refused. These print on invoices issued afterwards. |
| While **suspended / cancelled / expired** | A "read-only" banner. Adding a student, editing the profile, etc. are refused (`SUBSCRIPTION_READ_ONLY`); sign-in, reading, exports, billing details, invoices, orders and cancel/keep still work. |
| Limit: with Active students at its limit, add one more student | Refused with "plan limit reached" (`402 PLAN_LIMIT_REACHED`); existing students untouched. |

## 6. What is not there (on purpose)

- No payment gateway and no webhook route: payments are recorded by staff from
  money they have confirmed. Nothing is ever marked paid by a client — an
  institute's order is an invoice until staff settle it.
- No proration: an upgrade or downgrade applies when its invoice is paid, and
  the paid period starts where the current one ends.
- No partial payments, refunds or credit notes.
- Storage and exams-per-month limits are shown as "not metered / not enforced".
- Notices are in-app (and push only where a device is registered); there is no
  email.
- The mobile app shows these notices but has no billing screen.

## 7. Cleaning up

Stop central-be and the front ends; drop the `ag_manual_*` databases when you
are done. Nothing in these steps touches any other database.
