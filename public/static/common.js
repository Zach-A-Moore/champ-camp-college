// Shared helpers: API calls with CSRF token, Turnstile captcha widget.
const CCC = (() => {
  let cfg = null, ready = null;
  const init = () => ready || (ready = fetch("/api/config", {credentials: "same-origin"})
    .then(r => r.json()).then(c => (cfg = c)));

  async function api(path, body, method) {
    await init();
    const opts = {method: method || (body === undefined ? "GET" : "POST"), credentials: "same-origin",
      headers: {"X-CSRF-Token": cfg.csrf}};
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
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
    let id = null, tok = "";
    init().then(loadTurnstile).then(() => {
      id = window.turnstile.render(sel, {sitekey: cfg.turnstileSiteKey, callback: t => (tok = t),
        "expired-callback": () => (tok = ""), "error-callback": () => (tok = "")});
    });
    return {token: () => tok, reset: () => { tok = ""; if (id !== null) window.turnstile.reset(id); }};
  }

  const setCsrf = t => { if (cfg) cfg.csrf = t; };
  return {init, api, captcha, setCsrf};
})();
