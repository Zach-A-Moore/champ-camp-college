# Champ Camp College

Flask app for a weekly virtual business speaker series: upcoming talks, $5 student registration through Stripe
Checkout (no account needed; one payment covers every talk in the season), email-code login, speaker/guest applications, a "My account" page, and an admin dashboard. Turnstile captcha.

## Pages
| Page | Purpose |
|---|---|
| `/` | Homepage: how it works, upcoming talks (from the database), speakers, student registration, meetup, speak, support |
| `/login` | Two-step email-code login (`?next=` accepts only `speaker`, `account`, `admin`) |
| `/speaker` | Speaker / professional-guest application (login required; one pending application at a time) |
| `/account` | The signed-in user's registrations (cancel) and applications (edit / withdraw while pending) |
| `/registered` | Return page after Stripe Checkout; confirms the payment with the server |
| `/cancel?t=…` | Cancel a registration from the signed link in the confirmation email |
| `/about`, `/faq`, `/privacy` | Content pages (the privacy notice is a draft to review before launch) |
| `/admin` | Overview, applications, talks (create/edit/cancel, email join links), registrations (filter, CSV export), users, activity log |

Unknown page URLs get an HTML 404 page; unknown `/api/*` URLs get JSON.

## Data and API
- `events` table: talks shown on the homepage. In development, six demo talks (themes from *The Next Factor*) are
  seeded into an empty table; nothing is seeded in production. `join_url` is never sent to the public API.
- Registrations start as `payment_status='pending'` and become `'paid'` only after Stripe confirms the full price in
  USD (via the webhook or the return page, whichever lands first; both are idempotent). Rows created before fees
  existed are `'free'` and still count as registered. Only `paid`/`free` rows get join links or appear in "My account".
- An email that already has a paid registration is never charged again; the confirmation is re-sent instead.
  Abandoned checkouts reuse the same pending row when the student tries again.
- Cancelling stops talk emails but does not refund automatically. Issue refunds from the Stripe dashboard.
- Public: `GET /api/events`, `POST /api/registrations` (returns a Stripe Checkout URL), `GET /api/registrations/checkout-status`,
  `POST /api/registrations/cancel`, `POST /api/stripe/webhook` (Stripe signature required; exempt from CSRF)
- Signed in: `GET /api/me/registrations`, `POST /api/me/registrations/<id>/cancel`, `GET /api/me/applications`,
  `PATCH /api/me/applications/<id>`, `POST /api/me/applications/<id>/withdraw`
- Admin: `GET /api/admin/summary|applications|registrations|registrations.csv|users|audit|events`,
  `POST /api/admin/events`, `PUT /api/admin/events/<id>`, `POST /api/admin/events/<id>/send-invites`,
  `POST /api/admin/applications/<id>/status` (emails the applicant)
- CSV exports escape cells starting with `= + - @` to prevent spreadsheet formula injection.

## Static pages and local demo
GitHub Pages deploys only `public/` and does not provide the Flask API. The browser-only demo (localStorage,
on-screen login codes, and checkbox CAPTCHA) is available only on `localhost` and `127.0.0.1`. On any other
host, API failures display an error and do not save form data in the browser. The Pages workflow is
`.github/workflows/pages.yml` (repo Settings → Pages → Source: GitHub Actions).

## Run (dev)
    pip install -r requirements.txt
    $env:ADMIN_EMAILS="you@example.com"
    python app.py        # http://127.0.0.1:5000

Without `SMTP_HOST`, all emails (login codes, confirmations, cancel links, invites) print to the server console in
development only.

## Config (env vars)
- `CCC_ENV=prod` – enables production checks, secure cookies, proxy handling, and HSTS
- `SECRET_KEY` – at least 32 characters in production
- `ADMIN_EMAILS` – comma-separated exact email addresses that get admin role on login; required in production. Update this setting and redeploy/restart the service before that address can access the admin dashboard.
- `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` – real Cloudflare Turnstile keys; required in production
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` – all required in production
- `CCC_DB` – database path; required in production and must point to persistent storage
- `PUBLIC_URL` – site address used for links in emails, e.g. `https://champcampcollege.com`; required in production
- `CONTACT_EMAIL` – optional; shown in the footer and support section when set
- `STRIPE_SECRET_KEY` – Stripe secret key (`sk_test_…` for the demo, `sk_live_…` to take real money); required in production
- `STRIPE_WEBHOOK_SECRET` – signing secret (`whsec_…`) of the webhook endpoint below; required in production
- `REGISTRATION_PRICE_CENTS` – registration price, default `500` ($5)
- `PORT` – provided by Render and used by Gunicorn

`.env.example` lists these variables without values. Keep actual credentials in the host's secret environment
settings, never in Git.

## Payments (Stripe)
Card details are entered on Stripe's hosted Checkout page and never reach this server. No Stripe SDK is needed.

- **No key in development:** the payment step is skipped and clearly labeled "simulated"; no money moves.
- **Stripe test mode:** create a free Stripe account, copy the test secret key from *Developers → API keys* into
  `STRIPE_SECRET_KEY`, and pay with test card `4242 4242 4242 4242`, any future date, any CVC. To receive webhooks
  locally, run `stripe listen --forward-to localhost:5000/api/stripe/webhook` and put the `whsec_…` it prints into
  `STRIPE_WEBHOOK_SECRET` (without it, the return page still confirms payment directly with Stripe).
- **Production:** in *Developers → Webhooks* add `https://<your domain>/api/stripe/webhook` with the events
  `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and set its signing secret.

## Deploy the full app on Render

**Fastest path:** `render.yaml` in this repo is a Render Blueprint. In Render choose **New → Blueprint**, pick this
repository, and fill in the secrets it asks for (admin emails, Turnstile, SMTP, Stripe). It creates the paid web
service, the 1 GB persistent disk at `/var/data`, a random `SECRET_KEY`, and the `champcampcollege.com` custom domain.
Then continue at step 5 below. The manual steps are kept for reference.

1. Create a Render **Web Service** connected to this GitHub repository and deploy the `main` branch.
2. Set the build command to `pip install -r requirements.txt` and the start command to
   `gunicorn app:app --workers 1 --threads 4 --timeout 60 --bind 0.0.0.0:$PORT`.
3. Attach a persistent disk at `/var/data` and set `CCC_DB=/var/data/ccc.db`. SQLite data outside the disk is lost when the service restarts or deploys.
4. Set these environment variables in Render's service settings:
   - `CCC_ENV=prod`
   - `SECRET_KEY` – a long, random secret; do not commit it to Git
   - `ADMIN_EMAILS` – comma-separated admin email addresses
   - `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` – real Cloudflare Turnstile keys (not the development test keys)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` – credentials and sender for site email
   - `PUBLIC_URL` – `https://champcampcollege.com` (or the Render URL while testing)
   - `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` – see "Payments" above
   - `CONTACT_EMAIL` – optional public contact address
5. Test login, email delivery, and admin access on the Render URL before adding the custom domain.
6. Add `champcampcollege.com` in the Render service's **Settings → Custom Domains**. Copy the DNS records Render provides into Namecheap's **Advanced DNS**, then verify the domain in Render. Render provisions HTTPS after verification.

Render persistent disks require a paid web service. Keep this SQLite-backed service to one instance; rate
limits are also held in process memory. To scale to multiple instances, migrate to a shared database and
shared rate-limit storage.

### Back up and download the database

The script uses SQLite's online backup API, so it can produce a consistent backup while the app is running.
In the service's **Shell** page, run:

    python backup_db.py --output-dir /tmp

The command prints the timestamped backup path. To download it, configure SSH access to the Render service
and use the SSH connection details shown under **Connect → SSH** with SFTP/SCP from your local machine, for
example:

    scp -s -P <port> <user>@<host>:/tmp/ccc-backup-<timestamp>.db .

Use the actual SSH username, host, port, and filename shown by your service. Treat downloaded backups as
sensitive data and store them securely. See [Render SSH documentation](https://render.com/docs/ssh).

The local `ccc.db` is Git-ignored and is not deployed. Existing local records need a separate, secure migration
if they should be retained.
