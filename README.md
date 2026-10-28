# Champ Camp College

Flask app: email-code login, speaker applications, admin dashboard, Turnstile captcha.

## Static demo (GitHub Pages)
`public/` also runs with no backend. When the API isn't found, the pages switch to a browser-only demo mode
(data in localStorage, the login code pops up on screen, captcha is a checkbox). Use an email containing
`admin` to see the admin page. Deployed by `.github/workflows/pages.yml`
(repo Settings → Pages → Source: GitHub Actions).

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
