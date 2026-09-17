# bKash sandbox runbook

How to prove the bKash integration against bKash's **sandbox** before taking real payments. Nothing here can create a real charge: the sandbox tool refuses any non-sandbox host, and the app only offers bKash when credentials are configured.

## What you need

| Item | Where it comes from |
|---|---|
| Sandbox app key, app secret, username, password | bKash merchant onboarding (Tokenized Checkout sandbox credentials) |
| Sandbox test wallet number, OTP and PIN | bKash's Tokenized Checkout sandbox documentation |
| A public HTTPS address for the API | A staging deployment, or a tunnel (e.g. ngrok) to your local API |
| SNS topic ARN for notifications | Logged by the API on bKash's first notification delivery (step 4) |

## 1. Configure

In `.env` (never commit it):

```dotenv
BKASH_APP_KEY=<sandbox app key>
BKASH_APP_SECRET=<sandbox app secret>
BKASH_USERNAME=<sandbox username>
BKASH_PASSWORD=<sandbox password>
BKASH_BASE_URL=https://tokenized.sandbox.bka.sh/v1.2.0-beta
# The customer's browser returns to PUBLIC_BASE_URL/api/payments/callback/bkash
PUBLIC_BASE_URL=https://<your public API address>
# The app the callback redirects back to
CLIENT_ORIGIN=https://<your app address>
# Filled in at step 4
BKASH_WEBHOOK_TOPIC_ARN=
```

## 2. Check credentials and the payment flow, without the app

These commands use the real adapter, never touch the database, and never print credentials or tokens.

```bash
npm run bkash:sandbox -w server -- create --amount 1.00
```

Expect `"ok":true` with a `paymentID` and a `bkashURL`. A credentials problem fails here with bKash's own message.

Open `bkashURL`, pay with the sandbox test wallet (number, OTP and PIN from bKash's sandbox documentation), then:

```bash
npm run bkash:sandbox -w server -- execute <paymentID>
npm run bkash:sandbox -w server -- status <paymentID>
```

Expect `"status":"paid"`, `"transactionStatus":"Completed"`, a `trxID`, and the same `amount` and `"currency":"BDT"`. Running `execute` again is safe and still reports `paid`.

## 3. Check the full app flow

1. Start the API and the app with the configuration above.
2. Sign in as a workspace owner and open **Subscription**, then pick a higher plan.
3. Choose **Pay online with bKash**. You are sent to bKash; pay with the test wallet.
4. You return to the Subscription page with **Payment confirmed**, and the plan is active.

Then confirm these are refused, which the automated tests also cover against a local mock:

- Paying for the plan that is already running.
- A downgrade the workspace does not fit (it lists what to reduce).
- Paying online while a manual upgrade request is awaiting review.
- Closing the bKash page without paying: you return with **not completed yet**, and nothing activates.

In the database, the payment shows `status: paid`, `metadata.confirmedVia: callback`, and `metadata.providerAmountMinor` equal to the plan price.

## 4. Notifications (Amazon SNS)

1. Give bKash the webhook endpoint: `https://<your public API address>/api/payments/webhook/bkash`.
2. bKash's SNS sends a subscription confirmation. With no topic configured, the API rejects it and logs:
   `Rejected a signed SNS message from an unexpected topic { topicArn: "arn:aws:sns:...", type: "SubscriptionConfirmation" }`
   It only logs messages whose AWS signature verified, so this ARN is genuine.
3. Set `BKASH_WEBHOOK_TOPIC_ARN` to that ARN and restart the API. On the next delivery attempt the API confirms the subscription and logs `Confirmed the bKash notification subscription`.
4. Make a sandbox payment and close the browser before returning. The notification makes the API ask bKash for the payment's real state and activate it. Nothing in the notification itself is trusted.

## 5. Abandoned payments

Every 10 minutes the API asks bKash about gateway payments pending for more than 15 minutes:

- If the customer approved and never came back, the payment is executed and the plan activates.
- If bKash reports it failed or cancelled, it is recorded as such.
- If it is still unpaid after 24 hours, it is closed as abandoned.
- If a payment was never started with bKash, it is marked failed.

To see it work in the sandbox, create a payment in the app, approve it on bKash, and close the browser **before** it redirects. Within about 25 minutes the plan activates without any action.

## Going live

- [ ] Every step above passes in the sandbox.
- [ ] Live credentials are stored in the production secret store, not in files.
- [ ] `BKASH_BASE_URL=https://tokenized.pay.bka.sh/v1.2.0-beta`
- [ ] `PUBLIC_BASE_URL` and `CLIENT_ORIGIN` are the production HTTPS addresses.
- [ ] The production SNS topic ARN is set (repeat step 4 against production).
- [ ] One small real payment is made and refunded manually through the bKash merchant portal.

The sandbox tool deliberately refuses the live host. Live checks happen through the app.
