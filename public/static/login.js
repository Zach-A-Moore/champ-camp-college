// Two-step email-code login.
(() => {
  const {$, api, say, busy, validate} = CCC;
  const cap = CCC.captcha("#cap");
  const f1 = $("#f1"), f2 = $("#f2"), email = $("#email"), code = $("#code");

  // Only these pages may be used as a post-login destination (prevents open redirects).
  const ALLOWED_NEXT = {"speaker.html": "speaker.html", "admin.html": "admin.html", "account.html": "account.html",
    "speaker": "speaker.html", "admin": "admin.html", "account": "account.html"};
  const dest = ALLOWED_NEXT[new URLSearchParams(location.search).get("next") || ""] || null;
  if (dest === "speaker.html") $("#intro").textContent = "Verify your email to apply to speak or join as a guest. We'll email you a 6-digit code.";
  if (dest) $("#why").hidden = true;

  let cooldownTimer = null;
  function startCooldown(seconds) {
    const btn = $("#resend");
    let left = seconds;
    clearInterval(cooldownTimer);
    btn.disabled = true;
    btn.textContent = `Send a new code (${left}s)`;
    cooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(cooldownTimer); btn.disabled = false; btn.textContent = "Send a new code"; }
      else btn.textContent = `Send a new code (${left}s)`;
    }, 1000);
  }

  function showStep1(message) {
    f2.hidden = true; f1.hidden = false; code.value = "";
    say("#msg", message || "", message ? "" : undefined);
    email.focus();
  }

  f1.addEventListener("submit", async e => {
    e.preventDefault();
    say("#msg", "");
    if (!validate(f1, [[email, v => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v), "Enter a valid email address."]])) return;
    const token = cap.token();
    if (!token) { say("#msg", "Please complete the security check first.", "err"); return; }
    await busy(f1.querySelector("button[type=submit]"), "Sending…", async () => {
      try {
        await api("/api/auth/request", {email: email.value, captcha: token});
        f1.hidden = true; f2.hidden = false;
        $("#sentTo").textContent = `We sent a code to ${email.value.trim()}. Check your inbox (and spam).`;
        startCooldown(30);
        code.focus();
      } catch (x) { say("#msg", x.message, "err"); }
      finally { cap.reset(); }
    });
  });

  async function verify() {
    say("#msg", "");
    const value = code.value.replace(/\D/g, "");
    if (value.length !== 6) { say("#msg", "Enter the 6-digit code from your email.", "err"); code.focus(); return; }
    await busy(f2.querySelector("button[type=submit]"), "Checking…", async () => {
      try {
        const r = await api("/api/auth/verify", {email: email.value, code: value});
        if (dest === "admin.html" && r.role !== "admin") {
          say("#msg", "You're logged in, but this email doesn't have admin access. Ask the site administrator to add it.", "err");
          setTimeout(() => (location.href = "account.html"), 2500);
          return;
        }
        say("#msg", "Logged in. Taking you there…", "ok");
        location.href = dest || (r.role === "admin" ? "admin.html" : "account.html");
      } catch (x) { say("#msg", x.message, "err"); code.select(); }
    });
  }

  f2.addEventListener("submit", e => { e.preventDefault(); verify(); });
  code.addEventListener("input", () => {
    const digits = code.value.replace(/\D/g, "").slice(0, 6);
    if (digits !== code.value) code.value = digits;
    if (digits.length === 6) verify();
  });
  $("#resend").addEventListener("click", () => showStep1("Complete the security check, then send a new code."));
  $("#back").addEventListener("click", () => { email.value = ""; showStep1(); });

  CCC.init().then(c => {
    if (!c.user) return;
    f1.hidden = true; $("#why").hidden = true;
    $("#already").hidden = false;
    $("#alreadyText").textContent = `You're already logged in as ${c.user.email}.`;
    $("#alreadyOut").addEventListener("click", CCC.logout);
    if (dest && !(dest === "admin.html" && c.user.role !== "admin")) location.replace(dest);
  });
})();
