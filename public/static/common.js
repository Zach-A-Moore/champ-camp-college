// Shared helpers, site header/footer, and the localhost-only browser demo.
// Security notes: everything user-supplied is rendered with textContent (see h()), never innerHTML.
const CCC = (() => {
  let cfg = null, ready = null, demo = false, serviceUnavailable = false;
  const rel = p => p.replace(/^\//, "");
  const isLocalDemoHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const serviceError = "Service temporarily unavailable, please try again";

  // ---------- DOM helpers ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  const $ = s => document.querySelector(s);

  function say(target, text, kind) {
    const el = typeof target === "string" ? $(target) : target;
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = text || "";
    if (text && kind === "err") el.setAttribute("role", "alert"); else el.removeAttribute("role");
  }

  // Disable a submit button while a request is in flight.
  async function busy(button, label, fn) {
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    try { return await fn(); }
    finally { button.disabled = false; button.textContent = original; }
  }

  // Inline field validation. rules: [[input, test(value) -> bool, message], ...]
  function validate(form, rules) {
    let first = null;
    form.querySelectorAll("[aria-invalid]").forEach(i => i.removeAttribute("aria-invalid"));
    form.querySelectorAll(".field-error").forEach(e => (e.textContent = ""));
    for (const [input, test, message] of rules) {
      if (test(input.value.trim())) continue;
      input.setAttribute("aria-invalid", "true");
      const e = document.getElementById(input.id + "-err");
      if (e && !e.textContent) e.textContent = message;
      if (!first) first = input;
    }
    if (first) first.focus();
    return !first;
  }

  const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; } };
  const fmtDate = ts => new Date(ts * 1000).toLocaleDateString(undefined, {weekday: "long", month: "long", day: "numeric"});
  const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit", timeZoneName: "short"});
  const fmtWhen = ts => `${fmtDate(ts)} · ${fmtTime(ts)}`;
  const fmtStamp = ts => ts ? new Date(ts * 1000).toLocaleString() : "";

  // Build an .ics file in the browser so "Add to calendar" also works in demo mode.
  function calendarLink(ev) {
    const z = ts => new Date(ts * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Champ Camp College//Events//EN", "BEGIN:VEVENT",
      `UID:ccc-event-${ev.id}@champcampcollege.com`, `DTSTAMP:${z(Date.now() / 1000)}`,
      `DTSTART:${z(ev.starts_at)}`, `DTEND:${z(ev.starts_at + (ev.duration_min || 60) * 60)}`,
      `SUMMARY:${esc("Champ Camp College: " + ev.title)}`,
      `DESCRIPTION:${esc("With " + ev.speaker_name + ". Your join link arrives by email before the talk.")}`,
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = h("a", {class: "btn ghost", href: URL.createObjectURL(new Blob([ics], {type: "text/calendar"})),
      download: `champ-camp-talk-${ev.id}.ics`, text: "Add to calendar"});
    return a;
  }

  // ---------- config / API ----------
  const fetchConfig = () => fetch(rel("/api/config"), {credentials: "same-origin"})
    .then(r => { if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0; return r.json(); });

  const init = () => ready || (ready = fetchConfig()
    .then(c => (cfg = c))
    .catch(() => {
      if (isLocalDemoHost) {
        demo = true; cfg = Demo.config(); showBanner();
      } else {
        serviceUnavailable = true;
        cfg = {csrf: "", turnstileSiteKey: "", contactEmail: "", user: null};
        showServiceError();
      }
      return cfg;
    }));

  function showBanner() {
    document.body.prepend(h("div", {class: "demo-banner",
      text: "Demo mode: data stays in this browser and login codes appear on screen. Use an email containing \"admin\" to see the admin dashboard."}));
  }

  function showServiceError() {
    let b = $("#ccc-service-error");
    if (!b) {
      b = h("div", {id: "ccc-service-error", class: "service-error", role: "status", "aria-live": "polite"});
      document.body.prepend(b);
    }
    b.textContent = serviceError;
  }

  async function api(path, body, method, retried) {
    await init();
    if (demo) return Demo.handle(path, body, method);
    if (serviceUnavailable) throw new Error(serviceError);
    const opts = {method: method || (body === undefined ? "GET" : "POST"), credentials: "same-origin",
      headers: {"X-CSRF-Token": cfg.csrf}};
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(rel(path), opts); }
    catch {
      showServiceError();
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // The session (and its CSRF token) can expire or be reset; refresh once and retry.
      if (r.status === 403 && data.error === "Bad CSRF token" && !retried) {
        const fresh = await fetchConfig().catch(() => null);
        if (fresh) { cfg = fresh; return api(path, body, method, true); }
      }
      if (r.status >= 500) {
        showServiceError();
        const e = new Error(data.error && r.status !== 500 ? data.error : serviceError); e.status = r.status; throw e;
      }
      const e = new Error(data.error || "Request failed"); e.status = r.status; throw e;
    }
    if (data.csrf) cfg.csrf = data.csrf;
    return data;
  }

  async function logout() {
    try { await api("/api/auth/logout", {}); } catch { /* still leave */ }
    location.href = "index.html";
  }

  // ---------- captcha ----------
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
    const el = $(sel);
    const status = h("p", {class: "captcha-status", "aria-live": "polite", text: "Loading security check…"});
    if (el) el.replaceChildren(status);
    init().then(() => {
      if (serviceUnavailable || !el) { status.textContent = ""; return; }
      if (demo) {
        box = h("input", {type: "checkbox", id: el.id + "-box"});
        el.replaceChildren(h("label", {class: "demo-captcha", for: box.id}, box,
          h("span", {text: "I'm not a robot"}), h("span", {class: "demo-captcha-note", text: "captcha (demo)"})));
        return;
      }
      return loadTurnstile().then(() => {
        status.textContent = "";
        id = window.turnstile.render(sel, {sitekey: cfg.turnstileSiteKey, callback: t => (tok = t),
          "expired-callback": () => (tok = ""), "error-callback": () => {
            tok = ""; status.textContent = "The security check had a problem. Refresh the page and try again.";
          }});
      }).catch(() => { status.textContent = "The security check didn't load. Refresh the page and try again."; });
    });
    return {
      token: () => (demo ? (box && box.checked ? "ok" : "") : tok),
      reset: () => { tok = ""; if (box) box.checked = false; if (id !== null) window.turnstile.reset(id); },
    };
  }

  // ---------- site header & footer ----------
  const page = (() => {
    const last = location.pathname.split("/").pop() || "index";
    return last.replace(/\.html$/, "") || "index";
  })();

  function navLink(href, text, key) {
    return h("li", {}, h("a", {href, text, "aria-current": key && key === page ? "page" : null}));
  }

  function renderHeader(user) {
    const host = $("#site-header");
    if (!host) return;
    const items = [
      navLink("index.html#events", "Talks"),
      navLink("index.html#speakers", "Speakers"),
      navLink("speaker.html", "Speak", "speaker"),
      navLink("about.html", "About", "about"),
      navLink("faq.html", "FAQ", "faq"),
    ];
    if (user) {
      if (user.role === "admin") items.push(navLink("admin.html", "Admin", "admin"));
      items.push(navLink("account.html", "My account", "account"));
      items.push(h("li", {class: "nav-user", title: user.email, text: user.email}));
      items.push(h("li", {}, h("button", {type: "button", class: "linklike", text: "Log out", onclick: logout})));
    } else {
      items.push(navLink("login.html", "Log in", "login"));
    }
    items.push(h("li", {}, h("a", {class: "nav-cta", href: "index.html#register", text: "Register"})));
    const nav = h("nav", {class: "site-nav", id: "site-nav", "aria-label": "Main"}, h("ul", {}, items));
    const toggle = h("button", {type: "button", class: "nav-toggle", "aria-expanded": "false", "aria-controls": "site-nav",
      text: "Menu", onclick: () => {
        const open = nav.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
      }});
    nav.addEventListener("click", e => {
      if (e.target.closest("a")) { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    });
    host.className = "site-header";
    host.replaceChildren(h("div", {class: "wrap"},
      h("a", {class: "logo", href: "index.html"}, "CHAMP CAMP ", h("span", {class: "chev", "aria-hidden": "true", text: ">>"}), " COLLEGE"),
      toggle, nav));
  }

  function renderFooter(c) {
    const host = $("#site-footer");
    if (!host) return;
    const contact = c && c.contactEmail;
    host.className = "site-footer";
    host.replaceChildren(h("div", {class: "wrap"},
      h("div", {class: "about-col"}, h("b", {text: "CHAMP CAMP COLLEGE"}),
        h("p", {text: "Weekly business talks from real operators and leaders, live online for college students."}),
        contact ? h("p", {}, "Questions? ", h("a", {href: "mailto:" + contact, text: contact})) : null),
      h("div", {}, h("b", {text: "Students"}), h("ul", {},
        h("li", {}, h("a", {href: "index.html#events", text: "Upcoming talks"})),
        h("li", {}, h("a", {href: "index.html#register", text: "Register"})),
        h("li", {}, h("a", {href: "account.html", text: "My account"})))),
      h("div", {}, h("b", {text: "Champ Camp"}), h("ul", {},
        h("li", {}, h("a", {href: "about.html", text: "About"})),
        h("li", {}, h("a", {href: "speaker.html", text: "Speak or join as a guest"})),
        h("li", {}, h("a", {href: "faq.html", text: "FAQ"})),
        h("li", {}, h("a", {href: "privacy.html", text: "Privacy"})))),
      h("p", {class: "legal", text: `© ${new Date().getFullYear()} Champ Camp, a 501(c)(3) nonprofit · champcampcollege.com`})));
  }

  // Registration price, e.g. "$5". Falls back to $5 until the config has loaded.
  const money = cents => `$${(cents / 100).toFixed(2)}`.replace(".00", "");
  const price = () => money(cfg && cfg.priceCents ? cfg.priceCents : 500);

  renderHeader(null);
  renderFooter(null);
  init().then(c => {
    renderHeader(c.user); renderFooter(c);
    document.querySelectorAll("[data-price]").forEach(el => (el.textContent = price()));
  });

  return {init, api, captcha, logout, h, $, say, busy, validate, fmtDate, fmtTime, fmtWhen, fmtStamp, tzName,
    calendarLink, money, price, isDemo: () => demo, config: () => cfg};
})();

// ---------- Browser-only demo (localhost) ----------
const Demo = (() => {
  const K = "ccc_demo_v2";
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || null; } catch { return null; } };
  const now = () => Math.floor(Date.now() / 1000);
  const save = s => { try { localStorage.setItem(K, JSON.stringify(s)); } catch { /* private mode */ } };
  const fail = (m, status) => { const e = new Error(m); e.status = status || 400; throw e; };
  const okEmail = e => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
  const nextId = list => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;

  function seedEvents() {
    const t = new Date(); t.setHours(19, 0, 0, 0);
    t.setDate(t.getDate() + (((4 - t.getDay()) + 7) % 7 || 7));
    const rows = [
      ["A Winning Mindset", "Najam Usmani", "Founder, Champ Camp", "How a winning mindset changes the way you study, work and lead, with habits you can start this week."],
      ["Priority Management", "Speaker to be announced", "", "Calendars, to-do lists and planning that actually raise your output instead of filling your day."],
      ["'Co' for Collaboration", "Speaker to be announced", "", "Clear roles and responsibilities that make group projects and teams accountable."],
      ["Would You Hire Yourself?", "Speaker to be announced", "", "What hiring managers look for, and how to evaluate yourself before an interview does."],
      ["Seal the Deal", "Speaker to be announced", "", "Practical closing skills from 25 years of corporate and entrepreneurial deals."],
      ["Being a Mediator", "Speaker to be announced", "", "Resolving conflict so every party leaves with an outcome they can accept."],
    ];
    return rows.map(([title, speaker_name, speaker_title, summary], i) => ({
      id: i + 1, title, speaker_name, speaker_title, summary, duration_min: 60, join_url: "", status: "published",
      starts_at: Math.floor(t.getTime() / 1000) + i * 7 * 86400, created_at: now(), invites_sent_at: null}));
  }

  const st = () => Object.assign({users: [], apps: [], regs: [], audit: [], codes: {}, me: null, events: null}, load() || {});
  const state = () => { const s = st(); if (!s.events) { s.events = seedEvents(); save(s); } return s; };
  const log = (s, event, email, detail) => s.audit.unshift({id: nextId(s.audit), ts: now(), event, email: email || "", ip: "demo", detail: detail || ""});
  const pub = e => ({id: e.id, title: e.title, speaker_name: e.speaker_name, speaker_title: e.speaker_title,
    summary: e.summary, starts_at: e.starts_at, duration_min: e.duration_min, status: e.status});
  const active = r => !r.cancelled_at && ["paid", "free"].includes(r.payment_status || "free");
  const upcoming = e => e.status === "published" && e.starts_at + e.duration_min * 60 > now();
  const page = (rows, q) => {
    const p = Math.max(1, +(q.get("page") || 1));
    return {rows: rows.slice((p - 1) * 50, p * 50), total: rows.length, page: p, page_size: 50};
  };

  function popup(code, email) {
    const previousFocus = document.activeElement;
    const button = CCC.h("button", {type: "button", class: "btn", text: "Got it"});
    const o = CCC.h("div", {role: "dialog", "aria-modal": "true", "aria-labelledby": "ccc-demo-title", class: "demo-code-backdrop"},
      CCC.h("div", {class: "demo-code-dialog"},
        CCC.h("div", {class: "demo-code-recipient"}, "Demo email to ", CCC.h("b", {text: email})),
        CCC.h("h3", {id: "ccc-demo-title", text: "Your login code"}),
        CCC.h("div", {class: "demo-code", text: code}),
        CCC.h("p", {class: "demo-code-explanation", text: "On the live site this arrives by email."}),
        button));
    const close = () => { o.remove(); if (previousFocus) previousFocus.focus(); };
    button.onclick = close;
    o.addEventListener("keydown", event => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") { event.preventDefault(); button.focus(); }
    });
    document.body.appendChild(o);
    button.focus();
  }

  const config = () => {
    const s = st();
    return {csrf: "demo", turnstileSiteKey: "", contactEmail: "", priceCents: 500, paymentsSimulated: true, user: s.me ? {email: s.me.email, role: s.me.role} : null};
  };

  function regView(s, r) {
    const e = s.events.find(x => x.id === r.event_id);
    return {id: r.id, event_id: r.event_id, title: e ? e.title : "All weekly talks", speaker_name: e ? e.speaker_name : null,
      starts_at: e ? e.starts_at : null, event_status: e ? e.status : null, created_at: r.created_at};
  }

  function handle(fullPath, body, method) {
    const s = state();
    const d = body || {};
    const [path, qs] = fullPath.split("?");
    const q = new URLSearchParams(qs || "");
    const verb = method || (body === undefined ? "GET" : "POST");
    const need = admin => {
      if (!s.me) fail("Login required", 401);
      if (admin && s.me.role !== "admin") fail("Forbidden", 403);
    };
    const done = v => { save(s); return v; };
    let m;

    if (path === "/api/events") return {events: s.events.filter(upcoming).sort((a, b) => a.starts_at - b.starts_at).map(pub)};

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
      if (!c || c.exp < now() || c.tries >= 5) fail("That code has expired or was used too many times. Request a new code.");
      c.tries++;
      if (c.code !== String(d.code).trim()) { log(s, "login_failed", email, "wrong code"); save(s); fail("That code isn't right. Check the latest email and try again."); }
      delete s.codes[email];
      const role = email.includes("admin") ? "admin" : "user";
      let u = s.users.find(x => x.email === email);
      if (!u) s.users.unshift(u = {id: nextId(s.users), email, role, created_at: now()});
      u.role = role; u.last_login = now(); s.me = {email, role, id: u.id};
      log(s, role === "admin" ? "admin_login" : "login_ok", email);
      return done({ok: true, role, csrf: "demo"});
    }
    if (path === "/api/auth/logout") { if (s.me) log(s, "logout", s.me.email); s.me = null; return done({ok: true}); }

    if (path === "/api/registrations") {
      if (!String(d.name || "").trim() || !okEmail(d.email) || !String(d.major || "").trim() || !d.year)
        fail("Please provide your name, school email, major, and year in school");
      if (d.captcha !== "ok") fail("Please tick the captcha box");
      const email = d.email.trim().toLowerCase();
      if (s.regs.some(x => x.email === email && active(x))) { log(s, "registration_duplicate", email); return done({ok: true, already_registered: true}); }
      let r = s.regs.find(x => x.email === email && !x.cancelled_at && x.payment_status === "pending");
      if (!r) {
        r = {id: nextId(s.regs), email, event_id: null, created_at: now(), cancelled_at: null, payment_status: "pending", amount_cents: 0, paid_at: null};
        s.regs.unshift(r);
      }
      Object.assign(r, {name: d.name.trim(), school: d.school || "", major: d.major, year: d.year});
      log(s, "checkout_started", email, `reg ${r.id}`);
      return done({ok: true, checkout_url: "registered.html?demo=" + r.id});
    }
    if (path === "/api/registrations/checkout-status") {
      const r = s.regs.find(x => String(x.id) === q.get("demo"));
      if (!r) fail("This link isn't valid.");
      if (r.payment_status === "pending") { r.payment_status = "paid"; r.paid_at = now(); r.amount_cents = 500; log(s, "payment_received", r.email, `reg ${r.id}: 500 cents`); }
      return done({status: "paid", first_name: r.name.split(" ")[0], simulated: true, demoCancelUrl: "cancel.html?t=demo-" + r.id});
    }
    if (path === "/api/registrations/cancel") {
      const r = s.regs.find(x => "demo-" + x.id === d.token);
      if (!r) fail("This cancel link isn't valid.");
      if (d.confirm === true && !r.cancelled_at) { r.cancelled_at = now(); log(s, "registration_cancelled", r.email, "via email link"); }
      const v = regView(s, r);
      return done({registration: {title: v.title, starts_at: v.starts_at, cancelled: !!r.cancelled_at, paid: r.payment_status === "paid"}});
    }

    if (path === "/api/speaker-applications") {
      need();
      const name = String(d.name || "").trim(), topic = String(d.topic || "").trim();
      if (!["speaker", "guest"].includes(d.kind) || !name || (d.kind === "speaker" && topic.length < 10))
        fail("Please complete all fields (a speaker topic needs at least 10 characters)");
      if (s.apps.some(a => a.email === s.me.email && a.status === "pending"))
        fail("You already have an application under review. You can edit it from My account.", 409);
      if (d.captcha !== "ok") fail("Please tick the captcha box");
      s.apps.unshift({id: nextId(s.apps), kind: d.kind, name, email: s.me.email, topic, status: "pending", created_at: now()});
      log(s, "application_submitted", s.me.email, d.kind);
      return done({ok: true});
    }
    if (path === "/api/me/applications") { need(); return {applications: s.apps.filter(a => a.email === s.me.email)}; }
    if ((m = path.match(/^\/api\/me\/applications\/(\d+)(\/withdraw)?$/))) {
      need();
      const a = s.apps.find(x => x.id === +m[1] && x.email === s.me.email);
      if (!a) fail("Not found", 404);
      if (a.status !== "pending") fail("Only applications under review can be changed.", 409);
      if (m[2]) { a.status = "withdrawn"; log(s, "application_withdrawn", s.me.email, String(a.id)); return done({ok: true}); }
      const name = String(d.name || "").trim(), topic = String(d.topic || "").trim();
      if (!["speaker", "guest"].includes(d.kind) || !name || (d.kind === "speaker" && topic.length < 10))
        fail("Please complete all fields (a speaker topic needs at least 10 characters)");
      Object.assign(a, {kind: d.kind, name, topic}); log(s, "application_edited", s.me.email, String(a.id));
      return done({ok: true});
    }
    if (path === "/api/me/registrations") {
      need();
      return {registrations: s.regs.filter(r => r.email === s.me.email && active(r))
        .map(r => Object.assign(regView(s, r), {paid: r.payment_status === "paid", amount_cents: r.amount_cents}))};
    }
    if ((m = path.match(/^\/api\/me\/registrations\/(\d+)\/cancel$/))) {
      need();
      const r = s.regs.find(x => x.id === +m[1] && x.email === s.me.email && !x.cancelled_at);
      if (!r) fail("Not found", 404);
      r.cancelled_at = now(); log(s, "registration_cancelled", s.me.email, "via account");
      return done({ok: true});
    }

    // ---- admin ----
    if (path.startsWith("/api/admin/")) need(true);
    const audience = id => [...new Set(s.regs.filter(r => active(r) && (r.event_id === id || r.event_id === null)).map(r => r.email))];
    if (path === "/api/admin/summary") {
      const next = s.events.filter(e => e.status === "published" && e.starts_at > now()).sort((a, b) => a.starts_at - b.starts_at)[0];
      return {
        pending_applications: s.apps.filter(a => a.status === "pending").length,
        upcoming_events: s.events.filter(e => e.status === "published" && e.starts_at > now()).length,
        active_registrations: s.regs.filter(active).length,
        registrations_7d: s.regs.filter(r => active(r) && r.created_at > now() - 7 * 86400).length,
        paid_registrations: s.regs.filter(r => !r.cancelled_at && r.payment_status === "paid").length,
        revenue_cents: s.regs.filter(r => r.payment_status === "paid").reduce((t, r) => t + r.amount_cents, 0),
        abandoned_checkouts: s.regs.filter(r => !r.cancelled_at && r.payment_status === "pending" && r.created_at < now() - 3600).length,
        price_cents: 500, payments_simulated: true,
        next_event: next ? {id: next.id, title: next.title, starts_at: next.starts_at, has_link: next.join_url ? 1 : 0,
          invites_sent_at: next.invites_sent_at, registered: audience(next.id).length} : null,
      };
    }
    if (path === "/api/admin/applications") {
      const term = (q.get("q") || "").toLowerCase();
      return page(s.apps.filter(a => (!q.get("status") || a.status === q.get("status")) && (!q.get("kind") || a.kind === q.get("kind"))
        && (!term || [a.name, a.email, a.topic].some(v => String(v).toLowerCase().includes(term)))), q);
    }
    if (path === "/api/admin/registrations") {
      const term = (q.get("q") || "").toLowerCase(), st8 = q.get("status") || "active";
      const match = {active, paid: r => !r.cancelled_at && r.payment_status === "paid",
        pending: r => !r.cancelled_at && r.payment_status === "pending", cancelled: r => !!r.cancelled_at}[st8] || (() => true);
      return page(s.regs.filter(r => match(r)
        && (!term || [r.name, r.email, r.school].some(v => String(v).toLowerCase().includes(term))))
        .map(r => ({id: r.id, name: r.name, email: r.email, school: r.school, major: r.major, year: r.year,
          talk: regView(s, r).title, payment: r.payment_status, amount_cents: r.amount_cents, created_at: r.created_at,
          paid_at: r.paid_at, cancelled_at: r.cancelled_at})), q);
    }
    if (path === "/api/admin/users") return page(s.users, q);
    if (path === "/api/admin/audit") return page(s.audit, q);
    if ((m = path.match(/^\/api\/admin\/applications\/(\d+)\/status$/))) {
      const a = s.apps.find(x => x.id === +m[1]);
      if (!a) fail("Not found", 404);
      if (a.status === "withdrawn") fail("The applicant withdrew this application.", 409);
      a.status = d.status; log(s, `application_${d.status}`, s.me.email, `${a.id}->${d.status}`);
      return done({ok: true, notified: true});
    }
    if (path === "/api/admin/events" && verb === "GET")
      return {rows: [...s.events].sort((a, b) => b.starts_at - a.starts_at)
        .map(e => Object.assign({}, e, {registered: audience(e.id).length}))};
    const checkEvent = () => {
      if (!String(d.title || "").trim() || !String(d.speaker_name || "").trim()) fail("Title and speaker are required.");
      if (d.join_url && !/^https:\/\/\S+$/.test(d.join_url)) fail("The join link must start with https://");
      if (!Number.isInteger(d.starts_at)) fail("Enter a valid date and time.");
    };
    const fields = ["title", "speaker_name", "speaker_title", "summary", "starts_at", "duration_min", "join_url", "status"];
    if (path === "/api/admin/events" && verb === "POST") {
      checkEvent();
      const e = {id: nextId(s.events), created_at: now(), invites_sent_at: null};
      fields.forEach(f => (e[f] = d[f])); s.events.push(e); log(s, "event_created", s.me.email, `${e.id}: ${e.title}`);
      return done({ok: true, id: e.id});
    }
    if ((m = path.match(/^\/api\/admin\/events\/(\d+)$/))) {
      checkEvent();
      const e = s.events.find(x => x.id === +m[1]);
      if (!e) fail("Not found", 404);
      const wasPublished = e.status === "published";
      fields.forEach(f => (e[f] = d[f])); log(s, "event_updated", s.me.email, `${e.id}: ${e.title} (${e.status})`);
      const notified = e.status === "cancelled" && wasPublished && d.notify === true ? audience(e.id).length : 0;
      return done({ok: true, notified});
    }
    if ((m = path.match(/^\/api\/admin\/events\/(\d+)\/send-invites$/))) {
      const e = s.events.find(x => x.id === +m[1]);
      if (!e) fail("Not found", 404);
      if (!upcoming(e)) fail("Invites can only be sent for upcoming, published talks.");
      if (!e.join_url) fail("Add the join link to this talk first.");
      e.invites_sent_at = now(); const sent = audience(e.id).length;
      log(s, "event_invites_sent", s.me.email, `${e.id}: ${sent} emails`);
      return done({ok: true, sent});
    }
    fail("Not found", 404);
  }
  return {config, handle};
})();
