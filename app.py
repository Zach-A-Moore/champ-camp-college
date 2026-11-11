"""Champ Camp College backend: events, student registration, email-code login, speaker applications, admin."""
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import smtplib
import sqlite3
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from functools import wraps
from pathlib import Path

from flask import Flask, Response, abort, g, jsonify, request, send_from_directory, session
from itsdangerous import BadSignature, URLSafeSerializer
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

BASE = Path(__file__).parent
PUBLIC = BASE / "public"
IS_PROD = os.environ.get("CCC_ENV", "dev") == "prod"

TURNSTILE_TEST_SITE = "1x00000000000000000000AA"
TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA"
DB_PATH = (os.environ.get("CCC_DB") or str(BASE / "ccc.db")).strip()
TURNSTILE_SITE = os.environ.get("TURNSTILE_SITE_KEY", TURNSTILE_TEST_SITE).strip()
TURNSTILE_SECRET = os.environ.get("TURNSTILE_SECRET_KEY", TURNSTILE_TEST_SECRET).strip()
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "").strip()
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
PRICE_CENTS = int(os.environ.get("REGISTRATION_PRICE_CENTS", "500") or 500)
# Without a Stripe key, development skips the payment step (clearly labeled). Production always requires Stripe.
PAYMENTS_SIMULATED = not STRIPE_SECRET_KEY and not IS_PROD
ACTIVE_REG = "r.cancelled_at IS NULL AND r.payment_status IN ('paid','free')"
CODE_TTL = 10 * 60
MAX_CODE_ATTEMPTS = 5
PAGE_SIZE = 50
YEARS = ("Freshman", "Sophomore", "Junior", "Senior", "Graduate", "Other")
EVENT_STATUSES = ("draft", "published", "cancelled")


def validate_production_config():
    if not IS_PROD:
        return
    missing = []
    secret = os.environ.get("SECRET_KEY", "").strip()
    if len(secret) < 32:
        missing.append("SECRET_KEY (at least 32 characters)")
    if not TURNSTILE_SITE or TURNSTILE_SITE == TURNSTILE_TEST_SITE:
        missing.append("TURNSTILE_SITE_KEY (a real Cloudflare key)")
    if not TURNSTILE_SECRET or TURNSTILE_SECRET == TURNSTILE_TEST_SECRET:
        missing.append("TURNSTILE_SECRET_KEY (a real Cloudflare key)")
    if not ADMIN_EMAILS:
        missing.append("ADMIN_EMAILS (at least one admin address)")
    for key in ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"):
        if not os.environ.get(key, "").strip():
            missing.append(key)
    smtp_port = os.environ.get("SMTP_PORT", "")
    if smtp_port and (not smtp_port.isdigit() or not 1 <= int(smtp_port) <= 65535):
        missing.append("SMTP_PORT (a valid TCP port)")
    if not os.environ.get("CCC_DB", "").strip():
        missing.append("CCC_DB (persistent database path)")
    # Links in emails must never be built from the request's Host header in production.
    if not re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?", PUBLIC_URL):
        missing.append("PUBLIC_URL (e.g. https://champcampcollege.com)")
    if not re.fullmatch(r"(sk|rk)_(test|live)_[A-Za-z0-9]+", STRIPE_SECRET_KEY):
        missing.append("STRIPE_SECRET_KEY (a Stripe secret or restricted key)")
    if not STRIPE_WEBHOOK_SECRET.startswith("whsec_"):
        missing.append("STRIPE_WEBHOOK_SECRET (the signing secret of your Stripe webhook endpoint)")
    if not 50 <= PRICE_CENTS <= 100_000:
        missing.append("REGISTRATION_PRICE_CENTS (between 50 and 100000)")
    if missing:
        raise RuntimeError("Production startup configuration is invalid: " + ", ".join(missing))


def _secret_key():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    if IS_PROD:
        raise RuntimeError("Production startup configuration is invalid: SECRET_KEY is required")
    f = BASE / ".secret_key"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
    return f.read_text().strip()


validate_production_config()
app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PROD,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=32 * 1024,
)
if IS_PROD:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

cancel_signer = URLSafeSerializer(app.config["SECRET_KEY"], salt="registration-cancel")

# ---------- database ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS login_codes(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS speaker_applications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, speaker_name TEXT NOT NULL, speaker_title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '', starts_at INTEGER NOT NULL, duration_min INTEGER NOT NULL DEFAULT 60,
  join_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL,
  invites_sent_at INTEGER);
CREATE TABLE IF NOT EXISTS registrations(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, school TEXT, major TEXT, "year" TEXT, session TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT NOT NULL, email TEXT, ip TEXT, detail TEXT);
"""

# Placeholder lineup for the demo, built from the founder's "The Next Factor" program themes.
DEMO_EVENTS = [
    ("A Winning Mindset", "Najam Usmani", "Founder, Champ Camp",
     "How a winning mindset changes the way you study, work and lead, with habits you can start this week."),
    ("Priority Management", "Speaker to be announced", "",
     "Calendars, to-do lists and planning that actually raise your output instead of filling your day."),
    ("'Co' for Collaboration", "Speaker to be announced", "",
     "Clear roles and responsibilities that make group projects and teams accountable."),
    ("Would You Hire Yourself?", "Speaker to be announced", "",
     "What hiring managers look for, and how to evaluate yourself before an interview does."),
    ("Seal the Deal", "Speaker to be announced", "",
     "Practical closing skills from 25 years of corporate and entrepreneurial deals."),
    ("Being a Mediator", "Speaker to be announced", "",
     "Resolving conflict so every party leaves with an outcome they can accept."),
]


def _seed_demo_events(c):
    if IS_PROD or c.execute("SELECT COUNT(*) FROM events").fetchone()[0]:
        return
    # Thursdays at 7:00 PM US Central (fixed UTC-6 offset; demo data only).
    central = timezone(timedelta(hours=-6))
    now = datetime.now(central)
    first = (now + timedelta(days=(3 - now.weekday()) % 7 or 7)).replace(hour=19, minute=0, second=0, microsecond=0)
    ts = int(time.time())
    for i, (title, speaker, speaker_title, summary) in enumerate(DEMO_EVENTS):
        c.execute(
            "INSERT INTO events(title,speaker_name,speaker_title,summary,starts_at,duration_min,status,created_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (title, speaker, speaker_title, summary, int((first + timedelta(weeks=i)).timestamp()), 60, "published", ts),
        )


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def _close(_):
    d = g.pop("db", None)
    if d:
        d.close()


def _add_columns(c, table, columns):
    existing = {row[1] for row in c.execute(f"PRAGMA table_info({table})")}
    for name, ddl in columns:
        if name not in existing:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        _add_columns(c, "registrations", [
            ("major", "major TEXT"), ("year", '"year" TEXT'),
            ("event_id", "event_id INTEGER REFERENCES events(id)"), ("cancelled_at", "cancelled_at INTEGER"),
            # Rows created before fees existed stay 'free'; new rows start 'pending' until Stripe confirms payment.
            ("payment_status", "payment_status TEXT NOT NULL DEFAULT 'free'"),
            ("amount_cents", "amount_cents INTEGER NOT NULL DEFAULT 0"),
            ("stripe_session_id", "stripe_session_id TEXT"), ("paid_at", "paid_at INTEGER"),
        ])
        c.execute("CREATE INDEX IF NOT EXISTS idx_reg_stripe ON registrations(stripe_session_id)")
        _add_columns(c, "speaker_applications", [("updated_at", "updated_at INTEGER")])
        c.execute("CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(email)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at)")
        _seed_demo_events(c)


def audit(event, email=None, detail=None):
    db().execute(
        "INSERT INTO audit_log(ts,event,email,ip,detail) VALUES(?,?,?,?,?)",
        (int(time.time()), event, email, request.remote_addr, detail),
    )
    db().commit()


# ---------- helpers ----------
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_hits = defaultdict(deque)


def rate_limit(key, limit, window):
    now = time.time()
    q = _hits[key]
    while q and q[0] < now - window:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True


def err(msg, code=400):
    return jsonify(error=msg), code


def clean(val, maxlen):
    if not isinstance(val, str):
        return ""
    value = "".join(ch for ch in val if unicodedata.category(ch) != "Cc").strip()
    return value[:maxlen]


def validated_text(val, maxlen, required=False, multiline=False):
    if not isinstance(val, str):
        return None
    if multiline:
        val = val.replace("\r\n", "\n")
        value = "".join(ch for ch in val if ch == "\n" or unicodedata.category(ch) != "Cc").strip()
        value = value[:maxlen + 1]
    else:
        value = clean(val, maxlen + 1)
    if len(value) > maxlen or (required and not value):
        return None
    return value


def norm_email(val):
    e = validated_text(val, 254, required=True)
    if e is None:
        return None
    e = e.lower()
    return e if EMAIL_RE.match(e) else None


def json_body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else None


def page_arg():
    try:
        return max(1, min(int(request.args.get("page", "1")), 10_000))
    except ValueError:
        return 1


def verify_captcha(token):
    if not isinstance(token, str) or not token or len(token) > 2048:
        return False
    data = urllib.parse.urlencode(
        {"secret": TURNSTILE_SECRET, "response": token, "remoteip": request.remote_addr or ""}
    ).encode()
    try:
        with urllib.request.urlopen(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify", data, timeout=5
        ) as r:
            return bool(json.load(r).get("success"))
    except Exception as error:
        app.logger.warning("Turnstile verification failed (%s)", type(error).__name__)
        return False


def code_hash(email, code):
    return hmac.new(app.config["SECRET_KEY"].encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def site_url(path=""):
    base = PUBLIC_URL or request.host_url.rstrip("/")
    return f"{base}/{path.lstrip('/')}"


def send_email(to, subject, body):
    host = os.environ.get("SMTP_HOST")
    if not host:
        if IS_PROD:
            raise RuntimeError("SMTP_HOST is required in production")
        print(f"[DEV EMAIL] to={to}\nSubject: {subject}\n{body}\n[/DEV EMAIL]", flush=True)
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("SMTP_FROM", "no-reply@example.com")
    msg["To"] = to
    msg.set_content(body)
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=10) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
        s.send_message(msg)


def try_email(to, subject, body):
    """Send a non-critical notification; failures are logged, never shown to the requester."""
    try:
        send_email(to, subject, body)
        return True
    except Exception:
        app.logger.exception("Notification email failed")
        return False


def send_code(email, code):
    send_email(email, "Your Champ Camp College login code",
               f"Your login code is {code}. It expires in 10 minutes.\nIf you didn't request it, ignore this email.")


def fmt_when(ts):
    central = timezone(timedelta(hours=-6))
    return datetime.fromtimestamp(ts, central).strftime("%A, %B %d at %I:%M %p Central").replace(" 0", " ")


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login_required(admin=False):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return err("Forbidden", 403) if admin else err("Login required", 401)
            if admin and u["role"] != "admin":
                return err("Forbidden", 403)
            g.user = u
            return fn(*a, **kw)
        return wrapper
    return deco


def public_event(row):
    return {k: row[k] for k in ("id", "title", "speaker_name", "speaker_title", "summary", "starts_at",
                                 "duration_min", "status")}


# ---------- security hooks ----------
@app.before_request
def _csrf():
    # Stripe's server-to-server webhook has no browser session; it is authenticated by its signature instead.
    if request.path == "/api/stripe/webhook":
        return None
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        tok = session.get("csrf")
        sent = request.headers.get("X-CSRF-Token", "")
        if not tok or not hmac.compare_digest(tok, sent):
            return err("Bad CSRF token", 403)


@app.after_request
def _headers(r):
    r.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
        "frame-src https://challenges.cloudflare.com; style-src 'self' https://challenges.cloudflare.com; "
        "img-src 'self'; connect-src 'self' https://challenges.cloudflare.com; "
        "object-src 'none'; base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    )
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    r.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if IS_PROD:
        r.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.path.startswith("/api/"):
        r.headers["Cache-Control"] = "no-store"
    return r


def _error_page(code):
    page = "404.html" if code == 404 else "error.html"
    resp = send_from_directory(PUBLIC, page)
    resp.status_code = code
    return resp


@app.errorhandler(HTTPException)
def handle_http_error(error):
    if not request.path.startswith("/api/"):
        return _error_page(error.code)
    message = "Not found" if error.code == 404 else "Request failed"
    return jsonify(error=message), error.code


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    app.logger.exception("Unhandled request error (%s)", type(error).__name__)
    if not request.path.startswith("/api/"):
        return _error_page(500)
    return jsonify(error="Service temporarily unavailable, please try again"), 500


# ---------- pages ----------
PAGES = {
    "/": "index.html", "/login": "login.html", "/admin": "admin.html", "/speaker": "speaker.html",
    "/account": "account.html", "/about": "about.html", "/faq": "faq.html", "/privacy": "privacy.html",
    "/cancel": "cancel.html", "/registered": "registered.html",
}
for _path, _file in PAGES.items():
    app.add_url_rule(_path, _file, lambda f=_file: send_from_directory(PUBLIC, f))
    app.add_url_rule("/" + _file, "html_" + _file, lambda f=_file: send_from_directory(PUBLIC, f))


@app.route("/static/<path:name>")
def static_files(name):
    return send_from_directory(PUBLIC / "static", name)


# ---------- api: public ----------
@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


@app.get("/api/config")
def config():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    u = current_user()
    return jsonify(
        csrf=session["csrf"],
        turnstileSiteKey=TURNSTILE_SITE,
        contactEmail=CONTACT_EMAIL,
        priceCents=PRICE_CENTS,
        paymentsSimulated=PAYMENTS_SIMULATED,
        user={"email": u["email"], "role": u["role"]} if u else None,
    )


@app.get("/api/events")
def list_events():
    rows = db().execute(
        "SELECT * FROM events WHERE status='published' AND starts_at + duration_min*60 > ? ORDER BY starts_at LIMIT 50",
        (int(time.time()),),
    )
    return jsonify(events=[public_event(r) for r in rows])


def _ics_text(value):
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@app.get("/api/events/<int:event_id>/calendar.ics")
def event_ics(event_id):
    e = db().execute("SELECT * FROM events WHERE id=? AND status='published'", (event_id,)).fetchone()
    if not e:
        abort(404)
    stamp = lambda ts: datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Champ Camp College//Events//EN", "BEGIN:VEVENT",
        f"UID:ccc-event-{e['id']}@champcampcollege.com", f"DTSTAMP:{stamp(int(time.time()))}",
        f"DTSTART:{stamp(e['starts_at'])}", f"DTEND:{stamp(e['starts_at'] + e['duration_min'] * 60)}",
        f"SUMMARY:{_ics_text('Champ Camp College: ' + e['title'])}",
        f"DESCRIPTION:{_ics_text('With ' + e['speaker_name'] + '. Your join link arrives by email before the talk.')}",
        f"URL:{site_url('/')}", "END:VEVENT", "END:VCALENDAR",
    ]
    return Response("\r\n".join(lines) + "\r\n", mimetype="text/calendar",
                    headers={"Content-Disposition": f'attachment; filename="champ-camp-talk-{e["id"]}.ics"'})


# ---------- api: auth ----------
@app.post("/api/auth/request")
def auth_request():
    d = json_body()
    if d is None:
        return err("Invalid request")
    email = norm_email(d.get("email"))
    if not email:
        return err("Enter a valid email address")
    if not rate_limit(f"req-ip:{request.remote_addr}", 10, 600) or not rate_limit(f"req-em:{email}", 3, 600):
        return err("Too many requests. Wait a few minutes and try again.", 429)
    if not verify_captcha(d.get("captcha")):
        return err("Captcha failed. Please retry.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    c = db()
    c.execute("UPDATE login_codes SET used=1 WHERE email=? AND used=0", (email,))
    c.execute(
        "INSERT INTO login_codes(email,code_hash,expires_at) VALUES(?,?,?)",
        (email, code_hash(email, code), int(time.time()) + CODE_TTL),
    )
    c.commit()
    try:
        send_code(email, code)
    except Exception:
        app.logger.exception("Login code email delivery failed")
        return err("Could not send email. Try again later.", 502)
    audit("code_requested", email)
    return jsonify(ok=True)


@app.post("/api/auth/verify")
def auth_verify():
    d = json_body()
    if d is None:
        return err("Invalid request")
    email = norm_email(d.get("email"))
    code = clean(d.get("code"), 12)
    if not email:
        return err("Invalid code")
    if not rate_limit(f"ver-ip:{request.remote_addr}", 20, 600):
        return err("Too many attempts. Wait a few minutes and try again.", 429)
    c = db()
    row = c.execute(
        "SELECT * FROM login_codes WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1", (email,)
    ).fetchone()
    if not row or row["expires_at"] <= time.time() or row["attempts"] >= MAX_CODE_ATTEMPTS:
        if row and row["attempts"] >= MAX_CODE_ATTEMPTS:
            c.execute("UPDATE login_codes SET used=1 WHERE id=?", (row["id"],))
            c.commit()
        audit("login_failed", email, "no valid code")
        return err("That code has expired or was used too many times. Request a new code.")
    c.execute("UPDATE login_codes SET attempts=attempts+1 WHERE id=?", (row["id"],))
    if not re.fullmatch(r"\d{6}", code) or not hmac.compare_digest(row["code_hash"], code_hash(email, code)):
        if row["attempts"] + 1 >= MAX_CODE_ATTEMPTS:
            c.execute("UPDATE login_codes SET used=1 WHERE id=?", (row["id"],))
        c.commit()
        audit("login_failed", email, "wrong code")
        return err("That code isn't right. Check the latest email and try again.")
    c.execute("UPDATE login_codes SET used=1 WHERE id=?", (row["id"],))
    now = int(time.time())
    role = "admin" if email in ADMIN_EMAILS else "user"
    c.execute("INSERT OR IGNORE INTO users(email,role,created_at) VALUES(?,?,?)", (email, role, now))
    c.execute("UPDATE users SET last_login=?, role=? WHERE email=?", (now, role, email))
    c.commit()
    uid = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
    session.clear()  # new session on login prevents fixation
    session.permanent = True
    session["uid"] = uid
    session["csrf"] = secrets.token_urlsafe(32)
    audit("admin_login" if role == "admin" else "login_ok", email)
    return jsonify(ok=True, role=role, csrf=session["csrf"])


@app.post("/api/auth/logout")
def logout():
    u = current_user()
    if u:
        audit("logout", u["email"])
    session.clear()
    # Issue a fresh token so the page can keep working without a reload.
    session["csrf"] = secrets.token_urlsafe(32)
    return jsonify(ok=True, csrf=session["csrf"])


# ---------- payments (Stripe Checkout; card details never touch this server) ----------
def stripe_request(method, path, data=None):
    """Minimal Stripe REST call (no SDK dependency). Raises on any non-2xx response."""
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(f"https://api.stripe.com/v1/{path}", data=body, method=method, headers={
        "Authorization": "Bearer " + STRIPE_SECRET_KEY, "Stripe-Version": "2024-06-20",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def create_checkout(reg_id, email):
    if PAYMENTS_SIMULATED:
        token = cancel_signer.dumps({"sim": reg_id})
        return f"sim_{reg_id}_{secrets.token_hex(8)}", site_url("/registered?sim=" + token)
    s = stripe_request("POST", "checkout/sessions", {
        "mode": "payment",
        "customer_email": email,
        "client_reference_id": str(reg_id),
        "metadata[registration_id]": str(reg_id),
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": str(PRICE_CENTS),
        "line_items[0][price_data][product_data][name]": "Champ Camp College registration: all weekly talks",
        "success_url": site_url("/registered") + "?session_id={CHECKOUT_SESSION_ID}",
        "cancel_url": site_url("/?payment=cancelled#register"),
    })
    return s["id"], s["url"]


def mark_paid(reg_id, session_id, amount):
    """Idempotently mark a registration paid and send the confirmation once."""
    c = db()
    cur = c.execute(
        "UPDATE registrations SET payment_status='paid', paid_at=?, amount_cents=? "
        "WHERE id=? AND stripe_session_id=? AND payment_status='pending'",
        (int(time.time()), amount, reg_id, session_id),
    )
    c.commit()
    if cur.rowcount:
        row = c.execute("SELECT name,email FROM registrations WHERE id=?", (reg_id,)).fetchone()
        audit("payment_received", row["email"], f"reg {reg_id}: {amount} cents")
        try_email(row["email"], "You're registered: Champ Camp College", _confirmation_email(reg_id, row["name"], amount))
    return bool(cur.rowcount)


def _verified_paid_session(session):
    """True only if Stripe reports this session fully paid at our price."""
    return (session.get("payment_status") == "paid" and session.get("amount_total") == PRICE_CENTS
            and session.get("currency") == "usd")


# ---------- api: student registration ----------
def _money(cents):
    return f"${cents / 100:.2f}".replace(".00", "")


def _confirmation_email(reg_id, name, amount):
    token = cancel_signer.dumps(reg_id)
    paid = f" We received your {_money(amount)} registration payment." if amount else ""
    return (
        f"Hi {name},\n\nYou're registered for every weekly Champ Camp College talk this season.{paid}\n\n"
        "We'll email your join link before each talk. Talks are live online.\n\n"
        f"To stop receiving talk emails, cancel here: {site_url('/cancel?t=' + token)}\n"
        "Cancelling doesn't refund your payment automatically; reply to this email if you need a refund.\n\n"
        "See you there,\nChamp Camp College"
    )


@app.post("/api/registrations")
def register_student():
    d = json_body()
    if d is None:
        return err("Invalid request")
    name = validated_text(d.get("name"), 100, required=True)
    email = norm_email(d.get("email"))
    school = validated_text(d.get("school", ""), 100)
    major = validated_text(d.get("major"), 100, required=True)
    year = d.get("year")
    if name is None or not email or school is None or major is None or year not in YEARS:
        return err("Please provide your name, school email, major, and year in school")
    if not rate_limit(f"reg:{request.remote_addr}", 10, 3600):
        return err("Too many attempts. Try again later.", 429)
    if not verify_captcha(d.get("captcha")):
        return err("Captcha failed. Please retry.")
    c = db()
    active = c.execute(f"SELECT id FROM registrations r WHERE email=? AND event_id IS NULL AND {ACTIVE_REG}",
                       (email,)).fetchone()
    if active:
        # Don't charge twice. Re-send the confirmation so the owner of the address gets their links.
        audit("registration_duplicate", email)
        try_email(email, "You're already registered: Champ Camp College",
                  _confirmation_email(active["id"], name, 0))
        return jsonify(ok=True, already_registered=True)
    pending = c.execute("SELECT id FROM registrations WHERE email=? AND event_id IS NULL AND cancelled_at IS NULL"
                        " AND payment_status='pending' ORDER BY id DESC LIMIT 1", (email,)).fetchone()
    if pending:
        reg_id = pending["id"]
        c.execute('UPDATE registrations SET name=?, school=?, major=?, "year"=? WHERE id=?',
                  (name, school, major, year, reg_id))
    else:
        reg_id = c.execute(
            'INSERT INTO registrations(name,email,school,major,"year",session,event_id,created_at,payment_status)'
            " VALUES(?,?,?,?,?,?,?,?,'pending')",
            (name, email, school, major, year, "All weekly talks", None, int(time.time())),
        ).lastrowid
    c.commit()
    try:
        session_id, url = create_checkout(reg_id, email)
    except Exception:
        app.logger.exception("Stripe checkout creation failed")
        return err("We couldn't start the payment. Please try again in a moment.", 502)
    c.execute("UPDATE registrations SET stripe_session_id=? WHERE id=?", (session_id, reg_id))
    c.commit()
    audit("checkout_started", email, f"reg {reg_id}")
    return jsonify(ok=True, checkout_url=url)


@app.get("/api/registrations/checkout-status")
def checkout_status():
    """Called by the post-payment page. Confirms with Stripe directly, so it works even before the webhook lands."""
    if not rate_limit(f"status:{request.remote_addr}", 60, 600):
        return err("Too many requests. Try again later.", 429)
    c = db()
    sim = request.args.get("sim", "")
    if sim:
        if not PAYMENTS_SIMULATED:
            return err("Not found", 404)
        try:
            reg_id = cancel_signer.loads(sim)["sim"]
        except (BadSignature, TypeError, KeyError):
            return err("This link isn't valid.")
        row = c.execute("SELECT * FROM registrations WHERE id=?", (reg_id,)).fetchone()
        if not row:
            return err("This link isn't valid.")
        mark_paid(reg_id, row["stripe_session_id"], PRICE_CENTS)
    else:
        session_id = request.args.get("session_id", "")
        if not re.fullmatch(r"cs_(test|live)_[A-Za-z0-9]{10,200}", session_id):
            return err("This link isn't valid.")
        row = c.execute("SELECT * FROM registrations WHERE stripe_session_id=?", (session_id,)).fetchone()
        if not row:
            return err("This link isn't valid.")
        if row["payment_status"] == "pending" and not PAYMENTS_SIMULATED:
            try:
                s = stripe_request("GET", "checkout/sessions/" + session_id)
            except Exception:
                app.logger.exception("Stripe session lookup failed")
                return jsonify(status="pending", first_name=row["name"].split()[0])
            if _verified_paid_session(s):
                mark_paid(row["id"], session_id, s["amount_total"])
    row = c.execute("SELECT * FROM registrations WHERE id=?", (row["id"],)).fetchone()
    status = "paid" if row["payment_status"] in ("paid", "free") else "pending"
    return jsonify(status=status, first_name=row["name"].split()[0], simulated=PAYMENTS_SIMULATED)


def _stripe_signature_ok(payload, header):
    """Verify Stripe's `Stripe-Signature` header (HMAC-SHA256 of 't.payload'), rejecting events older than 5 min."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
        ts = int(parts.get("t", "0"))
    except ValueError:
        return False
    signatures = [v for k, v in (p.split("=", 1) for p in header.split(",") if "=" in p) if k == "v1"]
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return abs(time.time() - ts) <= 300 and any(hmac.compare_digest(expected, s) for s in signatures)


@app.post("/api/stripe/webhook")
def stripe_webhook():
    payload = request.get_data()
    if not STRIPE_WEBHOOK_SECRET or not _stripe_signature_ok(payload, request.headers.get("Stripe-Signature", "")):
        return err("Invalid signature", 400)
    event = json.loads(payload)
    if event.get("type") in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        s = event["data"]["object"]
        reg_id = (s.get("metadata") or {}).get("registration_id", "")
        if reg_id.isdigit() and _verified_paid_session(s):
            mark_paid(int(reg_id), s["id"], s["amount_total"])
    return jsonify(received=True)


def _registration_with_event(where, params):
    return db().execute(
        "SELECT r.id, r.name, r.email, r.event_id, r.created_at, r.cancelled_at, r.payment_status, r.amount_cents,"
        " e.title, e.speaker_name, e.starts_at, e.status AS event_status"
        " FROM registrations r LEFT JOIN events e ON e.id=r.event_id WHERE " + where,
        params,
    )


@app.post("/api/registrations/cancel")
def cancel_by_token():
    d = json_body()
    if d is None or not isinstance(d.get("token"), str) or len(d["token"]) > 200:
        return err("This cancel link isn't valid.")
    if not rate_limit(f"cancel:{request.remote_addr}", 20, 600):
        return err("Too many attempts. Try again later.", 429)
    try:
        reg_id = cancel_signer.loads(d["token"])
    except BadSignature:
        return err("This cancel link isn't valid.")
    if not isinstance(reg_id, int):
        return err("This cancel link isn't valid.")
    row = _registration_with_event("r.id=?", (reg_id,)).fetchone()
    if not row:
        return err("This cancel link isn't valid.")
    if d.get("confirm") is True and row["cancelled_at"] is None:
        db().execute("UPDATE registrations SET cancelled_at=? WHERE id=?", (int(time.time()), reg_id))
        db().commit()
        audit("registration_cancelled", row["email"], "via email link")
        row = _registration_with_event("r.id=?", (reg_id,)).fetchone()
    return jsonify(registration={
        "title": row["title"] or "All weekly talks", "starts_at": row["starts_at"],
        "cancelled": row["cancelled_at"] is not None, "paid": row["payment_status"] == "paid",
    })


# ---------- api: signed-in user ----------
def _app_row(r):
    return {k: r[k] for k in ("id", "kind", "name", "topic", "status", "created_at")}


@app.get("/api/me/applications")
@login_required()
def my_applications():
    rows = db().execute("SELECT * FROM speaker_applications WHERE user_id=? ORDER BY id DESC LIMIT 50",
                        (g.user["id"],))
    return jsonify(applications=[_app_row(r) for r in rows])


def _validate_application(d):
    kind = d.get("kind")
    name = validated_text(d.get("name"), 100, required=True)
    topic = validated_text(d.get("topic", ""), 2000, multiline=True)
    if (kind not in ("speaker", "guest") or name is None or topic is None
            or (kind == "speaker" and len(topic) < 10)):
        return None
    return kind, name, topic


@app.post("/api/speaker-applications")
@login_required()
def speaker_apply():
    d = json_body()
    if d is None:
        return err("Invalid request")
    fields = _validate_application(d)
    if not fields:
        return err("Please complete all fields (a speaker topic needs at least 10 characters)")
    if db().execute("SELECT 1 FROM speaker_applications WHERE user_id=? AND status='pending'",
                    (g.user["id"],)).fetchone():
        return err("You already have an application under review. You can edit it from My account.", 409)
    if not rate_limit(f"app:{g.user['id']}", 5, 3600):
        return err("Too many submissions. Try later.", 429)
    if not verify_captcha(d.get("captcha")):
        return err("Captcha failed. Please retry.")
    kind, name, topic = fields
    db().execute(
        "INSERT INTO speaker_applications(user_id,kind,name,email,topic,created_at) VALUES(?,?,?,?,?,?)",
        (g.user["id"], kind, name, g.user["email"], topic, int(time.time())),
    )
    db().commit()
    audit("application_submitted", g.user["email"], kind)
    try_email(g.user["email"], "We received your Champ Camp College application",
              f"Hi {name},\n\nThanks for applying to join Champ Camp College as a {kind}. "
              "We'll email you after we review it. You can check its status any time under My account.\n\n"
              f"{site_url('/account')}\n\nChamp Camp College")
    return jsonify(ok=True)


def _own_pending_app(app_id):
    return db().execute("SELECT * FROM speaker_applications WHERE id=? AND user_id=?",
                        (app_id, g.user["id"])).fetchone()


@app.patch("/api/me/applications/<int:app_id>")
@login_required()
def edit_application(app_id):
    d = json_body()
    if d is None:
        return err("Invalid request")
    row = _own_pending_app(app_id)
    if not row:
        return err("Not found", 404)
    if row["status"] != "pending":
        return err("Only applications under review can be edited.", 409)
    fields = _validate_application(d)
    if not fields:
        return err("Please complete all fields (a speaker topic needs at least 10 characters)")
    if not rate_limit(f"app-edit:{g.user['id']}", 20, 3600):
        return err("Too many changes. Try later.", 429)
    db().execute("UPDATE speaker_applications SET kind=?, name=?, topic=?, updated_at=? WHERE id=?",
                 (*fields, int(time.time()), app_id))
    db().commit()
    audit("application_edited", g.user["email"], str(app_id))
    return jsonify(ok=True)


@app.post("/api/me/applications/<int:app_id>/withdraw")
@login_required()
def withdraw_application(app_id):
    row = _own_pending_app(app_id)
    if not row:
        return err("Not found", 404)
    if row["status"] != "pending":
        return err("Only applications under review can be withdrawn.", 409)
    db().execute("UPDATE speaker_applications SET status='withdrawn', updated_at=? WHERE id=?",
                 (int(time.time()), app_id))
    db().commit()
    audit("application_withdrawn", g.user["email"], str(app_id))
    return jsonify(ok=True)


@app.get("/api/me/registrations")
@login_required()
def my_registrations():
    rows = _registration_with_event(f"r.email=? AND {ACTIVE_REG} ORDER BY r.id DESC LIMIT 100", (g.user["email"],))
    return jsonify(registrations=[{
        "id": r["id"], "event_id": r["event_id"], "title": r["title"] or "All weekly talks",
        "speaker_name": r["speaker_name"], "starts_at": r["starts_at"], "event_status": r["event_status"],
        "created_at": r["created_at"], "paid": r["payment_status"] == "paid", "amount_cents": r["amount_cents"],
    } for r in rows])


@app.post("/api/me/registrations/<int:reg_id>/cancel")
@login_required()
def cancel_my_registration(reg_id):
    cur = db().execute("UPDATE registrations SET cancelled_at=? WHERE id=? AND email=? AND cancelled_at IS NULL",
                       (int(time.time()), reg_id, g.user["email"]))
    db().commit()
    if not cur.rowcount:
        return err("Not found", 404)
    audit("registration_cancelled", g.user["email"], "via account")
    return jsonify(ok=True)


# ---------- api: admin ----------
@app.get("/api/admin/summary")
@login_required(admin=True)
def admin_summary():
    c, now = db(), int(time.time())
    one = lambda q, *p: c.execute(q, p).fetchone()[0]
    return jsonify(
        pending_applications=one("SELECT COUNT(*) FROM speaker_applications WHERE status='pending'"),
        upcoming_events=one("SELECT COUNT(*) FROM events WHERE status='published' AND starts_at>?", now),
        active_registrations=one(f"SELECT COUNT(*) FROM registrations r WHERE {ACTIVE_REG}"),
        registrations_7d=one(f"SELECT COUNT(*) FROM registrations r WHERE {ACTIVE_REG} AND created_at>?", now - 7 * 86400),
        paid_registrations=one("SELECT COUNT(*) FROM registrations r WHERE payment_status='paid' AND cancelled_at IS NULL"),
        revenue_cents=one("SELECT COALESCE(SUM(amount_cents),0) FROM registrations WHERE payment_status='paid'"),
        abandoned_checkouts=one("SELECT COUNT(*) FROM registrations WHERE payment_status='pending' AND cancelled_at IS NULL"
                                " AND created_at<?", now - 3600),
        price_cents=PRICE_CENTS,
        payments_simulated=PAYMENTS_SIMULATED,
        next_event=dict(r) if (r := c.execute(
            "SELECT e.id,e.title,e.starts_at,e.join_url!='' AS has_link,e.invites_sent_at,"
            f" (SELECT COUNT(DISTINCT r.email) FROM registrations r WHERE (r.event_id=e.id OR r.event_id IS NULL) AND {ACTIVE_REG})"
            " AS registered FROM events e WHERE status='published' AND starts_at>? ORDER BY starts_at LIMIT 1", (now,)
        ).fetchone()) else None,
    )


def _paged(sql, params, page):
    total = db().execute(f"SELECT COUNT(*) FROM ({sql})", params).fetchone()[0]
    rows = db().execute(f"{sql} LIMIT ? OFFSET ?", (*params, PAGE_SIZE, (page - 1) * PAGE_SIZE))
    return jsonify(rows=[dict(r) for r in rows], total=total, page=page, page_size=PAGE_SIZE)


def _search_term():
    q = clean(request.args.get("q", ""), 100)
    return f"%{q.replace('%', '').replace('_', '')}%" if q else None


@app.get("/api/admin/applications")
@login_required(admin=True)
def admin_applications():
    where, params = [], []
    status, kind, q = request.args.get("status"), request.args.get("kind"), _search_term()
    if status in ("pending", "approved", "rejected", "withdrawn"):
        where.append("status=?"); params.append(status)
    if kind in ("speaker", "guest"):
        where.append("kind=?"); params.append(kind)
    if q:
        where.append("(name LIKE ? OR email LIKE ? OR topic LIKE ?)"); params += [q, q, q]
    sql = ("SELECT id,kind,name,email,topic,status,created_at FROM speaker_applications"
           + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC")
    return _paged(sql, params, page_arg())


def _registration_filter():
    where, params = ["1=1"], []
    status = request.args.get("status", "active")
    if status == "active":
        where.append(ACTIVE_REG)
    elif status == "paid":
        where.append("r.cancelled_at IS NULL AND r.payment_status='paid'")
    elif status == "pending":
        where.append("r.cancelled_at IS NULL AND r.payment_status='pending'")
    elif status == "cancelled":
        where.append("r.cancelled_at IS NOT NULL")
    q = _search_term()
    if q:
        where.append("(r.name LIKE ? OR r.email LIKE ? OR r.school LIKE ?)"); params += [q, q, q]
    sql = ('SELECT r.id,r.name,r.email,r.school,r.major,r."year" AS year,'
           " COALESCE(e.title, CASE WHEN r.session GLOB '[0-9]*' THEN 'Old placeholder talk #' || r.session END,"
           " 'All weekly talks') AS talk,r.payment_status AS payment,r.amount_cents,r.created_at,r.paid_at,"
           " r.cancelled_at"
           " FROM registrations r LEFT JOIN events e ON e.id=r.event_id WHERE " + " AND ".join(where)
           + " ORDER BY r.id DESC")
    return sql, params


@app.get("/api/admin/registrations")
@login_required(admin=True)
def admin_registrations():
    sql, params = _registration_filter()
    return _paged(sql, params, page_arg())


def _csv_safe(value):
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


@app.get("/api/admin/registrations.csv")
@login_required(admin=True)
def admin_registrations_csv():
    sql, params = _registration_filter()
    out = io.StringIO()
    w = csv.writer(out)
    cols = ["id", "name", "email", "school", "major", "year", "payment", "amount_cents", "created_at", "paid_at",
            "cancelled_at"]
    w.writerow(cols)
    for r in db().execute(sql + " LIMIT 10000", params):
        w.writerow([_csv_safe(datetime.fromtimestamp(r[c], timezone.utc).isoformat() if c.endswith("_at") and r[c]
                              else r[c]) for c in cols])
    audit("registrations_exported", g.user["email"], request.query_string.decode()[:200])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="ccc-registrations-{stamp}.csv"'})


@app.get("/api/admin/users")
@login_required(admin=True)
def admin_users():
    return _paged("SELECT id,email,role,created_at,last_login FROM users ORDER BY id DESC", [], page_arg())


@app.get("/api/admin/audit")
@login_required(admin=True)
def admin_audit():
    return _paged("SELECT id,ts,event,email,ip,detail FROM audit_log ORDER BY id DESC", [], page_arg())


@app.post("/api/admin/applications/<int:app_id>/status")
@login_required(admin=True)
def admin_status(app_id):
    data = json_body()
    if data is None:
        return err("Invalid request")
    status = data.get("status")
    if status not in ("pending", "approved", "rejected"):
        return err("Invalid status")
    row = db().execute("SELECT * FROM speaker_applications WHERE id=?", (app_id,)).fetchone()
    if not row:
        return err("Not found", 404)
    if row["status"] == "withdrawn":
        return err("The applicant withdrew this application.", 409)
    db().execute("UPDATE speaker_applications SET status=?, updated_at=? WHERE id=?",
                 (status, int(time.time()), app_id))
    db().commit()
    audit(f"application_{status}", g.user["email"], f"{app_id}->{status}")
    notified = False
    if status != row["status"] and status in ("approved", "rejected"):
        body = (f"Hi {row['name']},\n\nGood news: your Champ Camp College {row['kind']} application was approved. "
                "We'll reach out shortly to set up a date." if status == "approved" else
                f"Hi {row['name']},\n\nThank you for applying to Champ Camp College. We aren't able to offer a "
                "spot this season, but we'd love for you to apply again in the future.")
        notified = try_email(row["email"], "Update on your Champ Camp College application",
                             body + f"\n\n{site_url('/account')}\n\nChamp Camp College")
    return jsonify(ok=True, notified=notified)


@app.get("/api/admin/events")
@login_required(admin=True)
def admin_events():
    rows = db().execute(
        f"SELECT e.*, (SELECT COUNT(DISTINCT r.email) FROM registrations r WHERE (r.event_id=e.id OR r.event_id IS NULL)"
        f" AND {ACTIVE_REG}) AS registered FROM events e ORDER BY e.starts_at DESC LIMIT 200"
    )
    return jsonify(rows=[dict(r) for r in rows])


def _validate_event(d):
    title = validated_text(d.get("title"), 150, required=True)
    speaker = validated_text(d.get("speaker_name"), 100, required=True)
    speaker_title = validated_text(d.get("speaker_title", ""), 150)
    summary = validated_text(d.get("summary", ""), 1000, multiline=True)
    join_url = validated_text(d.get("join_url", ""), 500)
    starts_at, duration, status = d.get("starts_at"), d.get("duration_min", 60), d.get("status", "draft")
    if None in (title, speaker, speaker_title, summary, join_url):
        return None, "Title and speaker are required."
    if join_url and not re.fullmatch(r"https://[^\s<>\"']+", join_url):
        return None, "The join link must start with https://"
    if not isinstance(starts_at, int) or isinstance(starts_at, bool) or not 1_600_000_000 < starts_at < 4_102_444_800:
        return None, "Enter a valid date and time."
    if not isinstance(duration, int) or isinstance(duration, bool) or not 15 <= duration <= 480:
        return None, "Length must be between 15 and 480 minutes."
    if status not in EVENT_STATUSES:
        return None, "Invalid status."
    return (title, speaker, speaker_title, summary, starts_at, duration, join_url, status), None


@app.post("/api/admin/events")
@login_required(admin=True)
def admin_create_event():
    d = json_body()
    if d is None:
        return err("Invalid request")
    fields, problem = _validate_event(d)
    if problem:
        return err(problem)
    cur = db().execute(
        "INSERT INTO events(title,speaker_name,speaker_title,summary,starts_at,duration_min,join_url,status,created_at)"
        " VALUES(?,?,?,?,?,?,?,?,?)", (*fields, int(time.time())),
    )
    db().commit()
    audit("event_created", g.user["email"], f"{cur.lastrowid}: {fields[0]}")
    return jsonify(ok=True, id=cur.lastrowid)


def _event_audience(event_id):
    """Active registrants for one talk plus everyone signed up for all weekly talks (one row per email)."""
    return db().execute(
        f"SELECT email, MIN(name) AS name FROM registrations r WHERE {ACTIVE_REG}"
        " AND (event_id=? OR event_id IS NULL) GROUP BY email LIMIT 2000", (event_id,),
    ).fetchall()


@app.put("/api/admin/events/<int:event_id>")
@login_required(admin=True)
def admin_update_event(event_id):
    d = json_body()
    if d is None:
        return err("Invalid request")
    before = db().execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not before:
        return err("Not found", 404)
    fields, problem = _validate_event(d)
    if problem:
        return err(problem)
    db().execute(
        "UPDATE events SET title=?,speaker_name=?,speaker_title=?,summary=?,starts_at=?,duration_min=?,join_url=?,"
        "status=? WHERE id=?", (*fields, event_id),
    )
    db().commit()
    audit("event_updated", g.user["email"], f"{event_id}: {fields[0]} ({fields[7]})")
    notified = 0
    if fields[7] == "cancelled" and before["status"] == "published" and d.get("notify") is True:
        for r in _event_audience(event_id):
            notified += try_email(r["email"], f"Cancelled: {fields[0]} (Champ Camp College)",
                                  f"Hi {r['name']},\n\nUnfortunately \"{fields[0]}\" on {fmt_when(before['starts_at'])}"
                                  " has been cancelled. We're sorry for the change.\n\nUpcoming talks: "
                                  f"{site_url('/#events')}\n\nChamp Camp College")
        audit("event_cancel_notice", g.user["email"], f"{event_id}: {notified} emails")
    return jsonify(ok=True, notified=notified)


@app.post("/api/admin/events/<int:event_id>/send-invites")
@login_required(admin=True)
def admin_send_invites(event_id):
    e = db().execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not e:
        return err("Not found", 404)
    if e["status"] != "published" or e["starts_at"] + e["duration_min"] * 60 < time.time():
        return err("Invites can only be sent for upcoming, published talks.")
    if not e["join_url"]:
        return err("Add the join link to this talk first.")
    if not rate_limit(f"invites:{event_id}", 3, 3600):
        return err("Invites were just sent. Try again later.", 429)
    sent = 0
    for r in _event_audience(event_id):
        sent += try_email(
            r["email"], f"Your link for \"{e['title']}\" (Champ Camp College)",
            f"Hi {r['name']},\n\n\"{e['title']}\" with {e['speaker_name']} starts {fmt_when(e['starts_at'])}.\n\n"
            f"Join here: {e['join_url']}\n\nSee you there,\nChamp Camp College",
        )
    db().execute("UPDATE events SET invites_sent_at=? WHERE id=?", (int(time.time()), event_id))
    db().commit()
    audit("event_invites_sent", g.user["email"], f"{event_id}: {sent} emails")
    return jsonify(ok=True, sent=sent)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
