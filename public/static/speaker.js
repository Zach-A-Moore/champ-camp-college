const $ = s => document.querySelector(s);
const msg = (t, bad) => { const m = $("#msg"); m.textContent = t; m.className = "msg" + (bad ? " err" : ""); m.style.display = "block"; };
const cap = CCC.captcha("#cap");

CCC.init().then(c => {
  if (!c.user) { $("#needLogin").classList.remove("hidden"); return; }
  $("#who").textContent = c.user.email;
  $("#f").classList.remove("hidden");
});

$("#f").onsubmit = async e => {
  e.preventDefault();
  try {
    await CCC.api("/api/speaker-applications", {kind: $("#kind").value, name: $("#name").value,
      topic: $("#topic").value, captcha: cap.token()});
    $("#f").classList.add("hidden");
    msg("Thanks! Your application was received. We'll be in touch.");
  } catch (x) {
    if (x.status === 401) location.href = "/login?next=/speaker";
    msg(x.message, true); cap.reset();
  }
};
