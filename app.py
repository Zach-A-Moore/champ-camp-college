"""Champ Camp College backend: email-code login, speaker applications, admin."""
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import sqlite3
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import timedelta
from email.message import EmailMessage
from functools import wraps
from pathlib import Path

from flask import Flask, abort, g, jsonify, request, send_from_directory, session

BASE = Path(__file__).parent
DB_PATH = os.environ.get("CCC_DB", str(BASE / "ccc.db"))
IS_PROD = os.environ.get("CCC_ENV", "dev") == "prod"

# Cloudflare Turnstile "always passes" test keys are used until real keys are set.
TURNSTILE_SITE = os.environ.get("TURNSTILE_SITE_KEY", "1x00000000000000000000AA")
TURNSTILE_SECRET = os.environ.get("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA")
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
CODE_TTL = 10 * 60
MAX_CODE_ATTEMPTS = 5


def _secret_key():
    env = os.environ.get("SECRET_KEY")
    if env:
        return env
    if IS_PROD:
        raise SystemExit("SECRET_KEY must be set when CCC_ENV=prod")
    f = BASE / ".secret_key"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
    return f.read_text().strip()


app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PROD,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=32 * 1024,
)

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
CREATE TABLE IF NOT EXISTS registrations(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, school TEXT, session TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, event TEXT NOT NULL, email TEXT, ip TEXT, detail TEXT);
"""


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


def init_db():
    with sqlite3.connect(DB_PATH) as c:
        c.executescript(SCHEMA)


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
    return val.strip()[:maxlen] if isinstance(val, str) else ""


def norm_email(val):
    e = clean(val, 254).lower()
    return e if EMAIL_RE.match(e) else None


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
    except Exception:
        return False


def code_hash(email, code):
    return hmac.new(app.config["SECRET_KEY"].encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def send_code(email, code):
    host = os.environ.get("SMTP_HOST")
    if not host:
        print(f"[DEV EMAIL] login code for {email}: {code}", flush=True)
        return
    msg = EmailMessage()
    msg["Subject"] = "Your Champ Camp College login code"
    msg["From"] = os.environ.get("SMTP_FROM", "no-reply@example.com")
    msg["To"] = email
    msg.set_content(f"Your login code is {code}. It expires in 10 minutes.\nIf you didn't request it, ignore this email.")
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=10) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
        s.send_message(msg)


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
                return err("Login required", 401)
            if admin and u["role"] != "admin":
                return err("Forbidden", 403)
            g.user = u
            return fn(*a, **kw)
        return wrapper
    return deco


# ---------- security hooks ----------
@app.before_request
def _csrf():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        tok = session.get("csrf")
        sent = request.headers.get("X-CSRF-Token", "")
        if not tok or not hmac.compare_digest(tok, sent):
            return err("Bad CSRF token", 403)


@app.after_request
def _headers(r):
    r.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
        "frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
        "form-action 'self'; frame-ancestors 'none'"
    )
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Referrer-Policy"] = "same-origin"
    r.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if IS_PROD:
        r.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.path.startswith("/api/"):
        r.headers["Cache-Control"] = "no-store"
    return r


# ---------- pages ----------
PAGES = {"/": "index.html", "/login": "login.html", "/admin": "admin.html", "/speaker": "speaker.html"}
for _path, _file in PAGES.items():
    app.add_url_rule(_path, _file, lambda f=_file: send_from_directory(BASE / "public", f))
    app.add_url_rule("/" + _file, "html_" + _file, lambda f=_file: send_from_directory(BASE / "public", f))


@app.route("/static/<path:name>")
def static_files(name):
    return send_from_directory(BASE / "public" / "static", name)


# ---------- api ----------
@app.get("/api/config")
def config():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    u = current_user()
    return jsonify(
        csrf=session["csrf"],
        turnstileSiteKey=TURNSTILE_SITE,
        user={"email": u["email"], "role": u["role"]} if u else None,
    )


@app.post("/api/auth/request")
def auth_request():
    d = request.get_json(silent=True) or {}
    email = norm_email(d.get("email"))
    if not email:
        return err("Enter a valid email address")
    if not rate_limit(f"req-ip:{request.remote_addr}", 10, 600) or not rate_limit(f"req-em:{email}", 3, 600):
        return err("Too many requests. Try again later.", 429)
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
    except Exception as e:
        app.logger.error("email send failed: %s", e)
        return err("Could not send email. Try again later.", 502)
    audit("code_requested", email)
    return jsonify(ok=True)


@app.post("/api/auth/verify")
def auth_verify():
    d = request.get_json(silent=True) or {}
    email = norm_email(d.get("email"))
    code = clean(d.get("code"), 12)
    if not email or not re.fullmatch(r"\d{6}", code):
        return err("Invalid code")
    if not rate_limit(f"ver-ip:{request.remote_addr}", 20, 600):
        return err("Too many attempts. Try again later.", 429)
    c = db()
    row = c.execute(
        "SELECT * FROM login_codes WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1", (email,)
    ).fetchone()
    if not row or row["expires_at"] < time.time() or row["attempts"] >= MAX_CODE_ATTEMPTS:
        audit("login_failed", email, "no valid code")
        return err("Invalid or expired code")
    c.execute("UPDATE login_codes SET attempts=attempts+1 WHERE id=?", (row["id"],))
    if not hmac.compare_digest(row["code_hash"], code_hash(email, code)):
        c.commit()
        audit("login_failed", email, "wrong code")
        return err("Invalid or expired code")
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
    audit("login_ok", email)
    return jsonify(ok=True, role=role, csrf=session["csrf"])


@app.post("/api/auth/logout")
def logout():
    u = current_user()
    if u:
        audit("logout", u["email"])
    session.clear()
    return jsonify(ok=True)


@app.post("/api/speaker-applications")
@login_required()
def speaker_apply():
    d = request.get_json(silent=True) or {}
    kind = d.get("kind")
    name, topic = clean(d.get("name"), 100), clean(d.get("topic"), 2000)
    if kind not in ("speaker", "guest") or not name or (kind == "speaker" and len(topic) < 10):
        return err("Please complete all fields (topic needs at least 10 characters)")
    if not rate_limit(f"app:{g.user['id']}", 5, 3600):
        return err("Too many submissions. Try later.", 429)
    if not verify_captcha(d.get("captcha")):
        return err("Captcha failed. Please retry.")
    db().execute(
        "INSERT INTO speaker_applications(user_id,kind,name,email,topic,created_at) VALUES(?,?,?,?,?,?)",
        (g.user["id"], kind, name, g.user["email"], topic, int(time.time())),
    )
    db().commit()
    audit("application_submitted", g.user["email"], kind)
    return jsonify(ok=True)


@app.post("/api/registrations")
def register_student():
    d = request.get_json(silent=True) or {}
    name, email = clean(d.get("name"), 100), norm_email(d.get("email"))
    if not name or not email:
        return err("Name and a valid email are required")
    if not rate_limit(f"reg:{request.remote_addr}", 10, 3600):
        return err("Too many submissions. Try later.", 429)
    if not verify_captcha(d.get("captcha")):
        return err("Captcha failed. Please retry.")
    db().execute(
        "INSERT INTO registrations(name,email,school,session,created_at) VALUES(?,?,?,?,?)",
        (name, email, clean(d.get("school"), 100), clean(d.get("session"), 50), int(time.time())),
    )
    db().commit()
    audit("registration", email)
    return jsonify(ok=True)


@app.get("/api/admin/<what>")
@login_required(admin=True)
def admin_list(what):
    q = {
        "applications": "SELECT id,kind,name,email,topic,status,created_at FROM speaker_applications ORDER BY id DESC LIMIT 500",
        "registrations": "SELECT id,name,email,school,session,created_at FROM registrations ORDER BY id DESC LIMIT 500",
        "users": "SELECT id,email,role,created_at,last_login FROM users ORDER BY id DESC LIMIT 500",
        "audit": "SELECT id,ts,event,email,ip,detail FROM audit_log ORDER BY id DESC LIMIT 500",
    }.get(what)
    if not q:
        abort(404)
    return jsonify(rows=[dict(r) for r in db().execute(q)])


@app.post("/api/admin/applications/<int:app_id>/status")
@login_required(admin=True)
def admin_status(app_id):
    status = (request.get_json(silent=True) or {}).get("status")
    if status not in ("pending", "approved", "rejected"):
        return err("Invalid status")
    cur = db().execute("UPDATE speaker_applications SET status=? WHERE id=?", (status, app_id))
    db().commit()
    if not cur.rowcount:
        return err("Not found", 404)
    audit("application_status", g.user["email"], f"{app_id}->{status}")
    return jsonify(ok=True)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
