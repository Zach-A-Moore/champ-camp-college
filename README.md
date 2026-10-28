# Champ Camp College

Flask app: email-code login, speaker applications, admin dashboard, Turnstile captcha.

## Run (dev)
    pip install -r requirements.txt
    $env:ADMIN_EMAILS="you@example.com"
    python app.py        # http://127.0.0.1:5000

Without `SMTP_HOST`, login codes print to the server console.

## Config (env vars)
- `CCC_ENV=prod` – requires `SECRET_KEY`, Secure cookies, HSTS (serve over HTTPS)
- `SECRET_KEY` – long random string
- `ADMIN_EMAILS` – comma-separated emails that get admin role on login
- `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` – Cloudflare Turnstile keys (dev defaults are test keys that always pass)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

Production: run behind a WSGI server (e.g. `waitress`/`gunicorn`) and HTTPS proxy.
