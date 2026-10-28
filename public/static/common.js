// Shared helpers. Talks to the Flask API when present; otherwise falls back to a
// browser-only DEMO mode (localStorage) so the site works on static hosting.
const CCC = (() => {
  let cfg = null, ready = null, demo = false;
  const rel = p => p.replace(/^\//, "");

  const init = () => ready || (ready = fetch(rel("/api/config"), {credentials: "same-origin"})
    .then(r => { if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0; return r.json(); })
    .then(c => (cfg = c))
    .catch(() => { demo = true; cfg = Demo.config(); showBanner(); return cfg; }));

  function showBanner() {
    const b = document.createElement("div");
    b.textContent = "DEMO MODE — data is stored only in your browser. Login codes appear on screen. Use an email containing \"admin\" to see the admin page.";
    b.style.cssText = "background:#fffbe0;border-bottom:1px solid #e6dc8a;text-align:center;font:13px Arial;padding:6px;color:#554";
    document.body.prepend(b);
  }

  async function api(path, body, method) {
    await init();
    if (demo) return Demo.handle(path, body);
    const opts = {method: method || (body === undefined ? "GET" : "POST"), credentials: "same-origin",
      headers: {"X-CSRF-Token": cfg.csrf}};
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    const r = await fetch(rel(path), opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || "Request failed"); e.status = r.status; throw e; }
    return data;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  function captcha(sel) {
    let id = null, tok = "", box = null;
    init().then(() => {
      if (demo) {
        const el = document.querySelector(sel);
        el.innerHTML = '<label style="display:flex;gap:8px;align-items:center;border:1px solid #bbb;padding:10px;background:#fafafa;text-transform:none;letter-spacing:0;font-weight:400"><input type="checkbox" style="width:auto"> I\'m not a robot <span style="margin-left:auto;font-size:.7rem;color:#777">captcha (demo)</span></label>';
        box = el.querySelector("input");
        return;
      }
      return loadTurnstile().then(() => {
        id = window.turnstile.render(sel, {sitekey: cfg.turnstileSiteKey, callback: t => (tok = t),
          "expired-callback": () => (tok = ""), "error-callback": () => (tok = "")});
      });
    });
    return {
      token: () => (demo ? (box && box.checked ? "ok" : "") : tok),
      reset: () => { tok = ""; if (box) box.checked = false; if (id !== null) window.turnstile.reset(id); },
    };
  }

  const setCsrf = t => { if (cfg) cfg.csrf = t; };
  return {init, api, captcha, setCsrf};
})();

const Demo = (() => {
  const K = "ccc_demo";
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch { return {}; } };
  const st = () => Object.assign({users: [], apps: [], regs: [], audit: [], codes: {}, me: null}, load());
  const save = s => localStorage.setItem(K, JSON.stringify(s));
  const now = () => Math.floor(Date.now() / 1000);
  const fail = (m, status) => { const e = new Error(m); e.status = status || 400; throw e; };
  const okEmail = e => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
  const log = (s, event, email, detail) => s.audit.unshift({id: s.audit.length + 1, ts: now(), event, email: email || "", ip: "demo", detail: detail || ""});

  function popup(code, email) {
    const o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99";
    o.innerHTML = '<div style="background:#fff;padding:28px;max-width:380px;text-align:center;font-family:Arial"><div style="font-size:.8rem;color:#777">Demo email to <b></b></div><h3 style="margin:8px 0">Your login code</h3><div class="c" style="font:700 2.2rem monospace;letter-spacing:.3em"></div><p style="color:#777;font-size:.85rem;margin:10px 0 16px">In the live site this arrives by email.</p><button style="padding:10px 22px;border:0;background:#111;color:#fff;font-weight:700;cursor:pointer">Got it</button></div>';
    o.querySelector("b").textContent = email;
    o.querySelector(".c").textContent = code;
    o.querySelector("button").onclick = () => o.remove();
    document.body.appendChild(o);
  }

  const config = () => {
    const s = st();
    return {csrf: "demo", turnstileSiteKey: "", user: s.me ? {email: s.me.email, role: s.me.role} : null};
  };

  function handle(path, body) {
    const s = st();
    const d = body || {};
    const need = admin => {
      if (!s.me) fail("Login required", 401);
      if (admin && s.me.role !== "admin") fail("Forbidden", 403);
    };
    if (path === "/api/auth/request") {
      if (!okEmail(d.email)) fail("Enter a valid email address");
      if (d.captcha !== "ok") fail("Please tick the captcha box");
      const email = d.email.trim().toLowerCase(), code = String(Math.floor(100000 + Math.random() * 900000));
      s.codes[email] = {code, exp: now() + 600, tries: 0};
      log(s, "code_requested", email); save(s); popup(code, email);
      return {ok: true};
    }
    if (path === "/api/auth/verify") {
      const email = String(d.email || "").trim().toLowerCase(), c = s.codes[email];
      if (!c || c.exp < now() || c.tries >= 5) fail("Invalid or expired code");
      c.tries++;
      if (c.code !== String(d.code).trim()) { log(s, "login_failed", email, "wrong code"); save(s); fail("Invalid or expired code"); }
      delete s.codes[email];
      const role = email.includes("admin") ? "admin" : "user";
      let u = s.users.find(x => x.email === email);
      if (!u) s.users.unshift(u = {id: s.users.length + 1, email, role, created_at: now()});
      u.role = role; u.last_login = now(); s.me = {email, role};
      log(s, "login_ok", email); save(s);
      return {ok: true, role, csrf: "demo"};
    }
    if (path === "/api/auth/logout") { if (s.me) log(s, "logout", s.me.email); s.me = null; save(s); return {ok: true}; }
    if (path === "/api/speaker-applications") {
      need();
      const name = String(d.name || "").trim(), topic = String(d.topic || "").trim();
      if (!["speaker", "guest"].includes(d.kind) || !name || (d.kind === "speaker" && topic.length < 10))
        fail("Please complete all fields (topic needs at least 10 characters)");
      if (d.captcha !== "ok") fail("Please tick the captcha box");
      s.apps.unshift({id: s.apps.length + 1, kind: d.kind, name, email: s.me.email, topic, status: "pending", created_at: now()});
      log(s, "application_submitted", s.me.email, d.kind); save(s);
      return {ok: true};
    }
    if (path === "/api/registrations") {
      if (!String(d.name || "").trim() || !okEmail(d.email)) fail("Name and a valid email are required");
      if (d.captcha !== "ok") fail("Please tick the captcha box");
      s.regs.unshift({id: s.regs.length + 1, name: d.name.trim(), email: d.email.trim(), school: d.school || "", session: d.session || "", created_at: now()});
      log(s, "registration", d.email); save(s);
      return {ok: true};
    }
    let m = path.match(/^\/api\/admin\/applications\/(\d+)\/status$/);
    if (m) {
      need(true);
      const a = s.apps.find(x => x.id === +m[1]);
      if (!a) fail("Not found", 404);
      a.status = d.status; log(s, "application_status", s.me.email, `${a.id}->${d.status}`); save(s);
      return {ok: true};
    }
    m = path.match(/^\/api\/admin\/(applications|registrations|users|audit)$/);
    if (m) { need(true); return {rows: s[{applications: "apps", registrations: "regs", users: "users", audit: "audit"}[m[1]]]}; }
    fail("Not found", 404);
  }
  return {config, handle};
})();
