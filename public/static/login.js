const $ = s => document.querySelector(s);
const cap = CCC.captcha("#cap");
const msg = (t, bad) => { const m = $("#msg"); m.textContent = t; m.className = "msg" + (bad ? " err" : ""); m.style.display = "block"; };
const dest = new URLSearchParams(location.search).get("next");

$("#f1").onsubmit = async e => {
  e.preventDefault();
  try {
    await CCC.api("/api/auth/request", {email: $("#email").value, captcha: cap.token()});
    $("#f1").classList.add("hidden"); $("#f2").classList.remove("hidden");
    msg("If that address is valid, a code is on its way. It expires in 10 minutes.");
  } catch (x) { msg(x.message, true); cap.reset(); }
};
$("#f2").onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await CCC.api("/api/auth/verify", {email: $("#email").value, code: $("#code").value});
    CCC.setCsrf(r.csrf);
    // only allow same-site relative redirects
    location.href = dest && /^[A-Za-z][\w.\-]*$/.test(dest) ? dest : (r.role === "admin" ? "admin.html" : "speaker.html");
  } catch (x) { msg(x.message, true); }
};
$("#back").onclick = () => location.reload();
