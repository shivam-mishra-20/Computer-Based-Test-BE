# Online payments (Cashfree): applications, renewals, auto-pay and refunds

How money moves:

- **Applying.** An institute chooses a plan on the public application (`/register-institute`) and pays before
  submitting. Approval creates the organization already **active** on the paid plan.
- **Renewing.** A renewal invoice is raised a week before each period ends. The institute pays it with **Pay now**,
  or its **auto-pay** mandate is charged.
- **Refunds.** Anyone eligible asks and a platform admin decides. **Approving is what sends the refund to Cashfree.**

Code, in `src/core/billing/`:

| Module | What it does |
| --- | --- |
| `cashfree.ts` | Client and pure rules |
| `registrationPayments.ts` | Application checkout |
| `invoiceCheckout.ts` | Pay now |
| `renewals.ts` | Renewal invoices, charges and reminders |
| `autopay.ts` | Mandates |
| `refundPolicy.ts` | The policy, as arithmetic |
| `refundRequests.ts` | Raise, approve, decline and follow refunds |
| `gatewayWebhook.ts` | Every Cashfree webhook |

Models: `RegistrationPayment`, `InvoiceCheckout`, `AutopayMandate`, `RefundRequest`. All are retained when an
organization is deleted.

Checks: `npm run safety:registration-payments` (pure).

## Configuration

| Variable | Meaning |
| --- | --- |
| `CASHFREE_ENV` | `sandbox` (default) or `production`. Picks the key pair and host. |
| `CASHFREE_TEST_APP_ID`, `CASHFREE_TEST_SECRET_KEY` | Sandbox pair: Merchant Dashboard → **Switch to Test** → Developers → API Keys. |
| `CASHFREE_PROD_APP_ID`, `CASHFREE_PROD_SECRET_KEY` | Production pair. |
| `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` | One pair, used for whichever environment has no pair of its own. |
| `CASHFREE_NOTIFY_URL` | Optional: the public HTTPS webhook address (below), sent on each order. |
| `CASHFREE_AUTOPAY=on` | Offers auto-pay. Only once **Subscriptions** is enabled on the Cashfree merchant account. |
| `PUBLIC_API_BASE_URL` | This server's public HTTPS address, e.g. `https://api.example.com/platform-api`. Cashfree sends the browser back here after a mandate is authorised. Set it in production; otherwise it is derived from the request. |
| `RENEWAL_INVOICE_DAYS` | Days before the period ends that the renewal invoice is raised (default 7). |
| `AUTOPAY_CHARGE_DAYS` | Days before the end that an auto-pay charge is raised (default 3; the debit is scheduled for the day before). |
| `PLATFORM_ENABLE_CRON=true` | Runs the daily 00:15 IST sweep: lifecycle, trial reminders and **renewals**. Without it, renewals run only from the console (Billing → Subscriptions → **Run renewals now**). |
| `CASHFREE_API_VERSION` | Optional; default `2025-01-01`. |
| `REGISTRATION_PAYMENTS=off` | Turns online payment off on the application (old behaviour: plan preference, trial at approval). |

Keys must match their environment. Cashfree marks a sandbox app id with `TEST`, and secrets with `cfsk_ma_test_` or
`cfsk_ma_prod_`. A mismatched pair is refused before anything is created, and the console says **configured
wrongly** and names the variables to set. While it is wrong, a priced plan cannot be submitted or paid. Nothing
becomes free by accident.

### Webhook

Set one URL in the Merchant Dashboard (Developers → Webhooks) for **Payment Gateway** and, if you use auto-pay,
**Subscriptions**: `https://<backend host>/platform-api/public/payments/cashfree/webhook`.

- It checks `x-webhook-signature`: base64 HMAC-SHA256 of `x-webhook-timestamp` + the raw body, keyed with the secret.
- Events must fall inside a 10-minute window (`CASHFREE_WEBHOOK_TOLERANCE_MS`).
- Each event is stored once (`providerevents`).
- The event only prompts a lookup: we **ask Cashfree** about the order, charge or refund it names and record that.
- `PAYMENT_*` events route to the application or invoice checkout, `REFUND_*` to the refund request, and
  `SUBSCRIPTION_*` to the mandate.

Without the webhook, everything is still confirmed: when the payer returns to the page, by the daily sweep (pending
auto-pay charges), or by staff pressing **Check**.

## Applying

1. Plan step (prices per month or year), then Features: the plan's features, which the applicant may switch off.
2. Review & pay. The amount is the plan for one interval, plus any one-time setup fee, plus GST if the seller profile
   has a GSTIN and rate. **Pay and submit** opens Cashfree.
3. **Paid** means Cashfree says so to our server, for exactly the order's amount and currency. The application is then
   submitted and its plan locked.
4. **Approval** creates the organization. The payment becomes its `Payment` and starts the subscription **active** for
   one interval from approval. Approving onto a different plan is refused until the payment is refunded.
5. **Generate invoice** (after approval) issues an already-paid invoice for exactly what was charged. It needs the
   seller profile's legal name.

## Renewals

The renewal step runs in the daily sweep and from **Run renewals now**:

- **`RENEWAL_INVOICE_DAYS` before the end:** an invoice for the same plan, version and interval is raised and issued
  (the seller profile needs a legal name, otherwise it waits as a draft), and the institute is notified. An open
  order of the institute's own (an upgrade, say) counts as the renewal instead.
- **Paying it** (Pay now, a bank transfer staff record, or auto-pay) extends the period from where it ends; early
  payment loses no days.
- **The day before, still unpaid, with no auto-pay:** one reminder.
- **After the end:** the existing grace period and read-only lifecycle take over.
- **Not renewed:** platform-owned organizations, subscriptions that are not lifecycle-managed, ones set to stop at
  period end, custom-priced plans, and trials (unless auto-pay is set up, in which case the trial converts the same
  way).

## Auto-pay

- **Set up** (institute admin, Subscription & billing): this creates a Cashfree ON_DEMAND subscription with a ceiling
  equal to the dearest self-serve plan for the institute's interval, tax included. The admin authorises it with UPI
  Autopay, eNACH or a card. Cashfree posts the browser back to us; we check the mandate and redirect to the page.
- **`AUTOPAY_CHARGE_DAYS` before the end:** a charge for the renewal invoice's balance is raised, scheduled for the
  day before. Cashfree sends the pre-debit notice.
- **When it succeeds:** the invoice is settled, the period extended and a `Payment` recorded against the mandate
  charge.
- **When it fails:** the institute is told to pay online. If the period has run out, one retry is made during grace.
- **Never more than authorised:** a renewal above the ceiling is not charged, and the institute is told.
- **No double payment:** an invoice being auto-charged cannot also be paid with Pay now. Any money Cashfree does take
  for an already-paid invoice is refunded automatically.
- **Turning it off:** the institute or staff can turn it off; cancelling the subscription turns it off too.

## Refunds

**Who asks:**

- An applicant, with the order ID on the receipt plus the application's email, at `/register-institute/refund`.
- An institute admin, for a Cashfree payment, under Subscription & billing → Invoices & payments.
- Staff, on someone's behalf. This is approved at once.
- **Automatic:** rejecting a paid application refunds it in full at once, and so does a duplicate payment.

**Staff decide** under Billing → **Refund requests**, or on the registration's Payment card:

- The amount is filled in from the policy and can be changed up to what is still refundable. Before approval it is
  always the full amount.
- **End the subscription now** cancels it and turns auto-pay off. Leave it unticked for a goodwill or partial refund.
- Declining needs a note; the requester is shown it.

**The default policy** (`refundPolicy.ts`; the admin can always override):

| Case | Suggested refund |
| --- | --- |
| Paid with an application not yet approved, or rejected | Everything |
| Period began ≤ 7 days ago (or has not begun) | The plan in full; a one-time setup fee is kept |
| Yearly plan after 7 days | Whole unused months, at 1/12 of the plan each; setup fee kept |
| Monthly plan after 7 days | Nothing: cancel at period end, it runs until then |
| Period already over | Nothing |

**Where refunds land:**

- `Payment.refundedMinor` and `Invoice.refundedMinor`; the invoice document shows the refund.
- `RegistrationPayment.refund` for an application. A refunded application payment is never used at approval.
- Cashfree refunds from your merchant balance. **GST:** an invoice that charged GST needs a credit note for a refund;
  credit notes are not built yet. No GST is charged today, because the seller profile has no GSTIN.

## Testing in the sandbox

Use the sandbox pair with `CASHFREE_ENV=sandbox`; the pages show a **Test mode** notice. Cashfree's test data:

- UPI `testsuccess@gocash` (success) and `testfailure@gocash` (failure).
- Card `4576 2389 1277 1450`, expiry 03/2028, CVV 123, name "Test", OTP 111000.
- Refund notes `SUCCESS` and `FAILED` simulate a refund's outcome.
- For auto-pay, enable Subscriptions in the sandbox dashboard and set `CASHFREE_AUTOPAY=on`.

## Not built

- Credit notes for refunds of GST invoices.
- Proration when changing plan mid-period.
- Mandate amount changes: setting auto-pay up again replaces the mandate.
