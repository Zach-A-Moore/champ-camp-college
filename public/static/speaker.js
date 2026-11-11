// Speaker / guest application.
(() => {
  const {h, $, api, say, busy, validate, fmtStamp} = CCC;
  const form = $("#f"), kind = $("#kind"), topic = $("#topic");
  const cap = CCC.captcha("#cap");

  function syncKind() {
    const speaker = kind.value === "speaker";
    $("#topicLabel").replaceChildren(speaker ? "Proposed talk title and summary " : "Anything we should know? (optional)",
      speaker ? h("span", {class: "req", "aria-hidden": "true", text: "*"}) : "");
    $("#topic-hint").textContent = speaker
      ? "Tell us what students will learn and a little about your background (at least 10 characters)."
      : "For example, your industry and what you'd like to share with students.";
    topic.required = speaker;
  }
  const syncCount = () => ($("#topic-count").textContent = `${topic.value.length} / 2000`);
  kind.addEventListener("change", syncKind);
  topic.addEventListener("input", syncCount);
  syncKind();

  function showPending(a) {
    form.hidden = true;
    $("#existing").hidden = false;
    $("#existing").replaceChildren(
      h("h2", {text: "Your application is under review"}),
      h("p", {}, h("span", {class: "badge pending", text: "Pending"}), ` Submitted ${fmtStamp(a.created_at)} as a ${a.kind}.`),
      h("p", {text: "We'll email you after we review it. You can edit or withdraw it until then."}),
      h("p", {}, h("a", {class: "btn", href: "account.html", text: "View, edit or withdraw"})));
  }

  CCC.init().then(async c => {
    if (!c.user) { $("#needLogin").hidden = false; return; }
    $("#who").textContent = `Applying as ${c.user.email}. We'll reply to this address.`;
    try {
      const {applications} = await api("/api/me/applications");
      const pending = applications.find(a => a.status === "pending");
      if (pending) return showPending(pending);
      if (applications[0]) $("#name").value = applications[0].name;
    } catch { /* still allow applying */ }
    form.hidden = false;
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    say("#msg", "");
    const speaker = kind.value === "speaker";
    if (!validate(form, [
      [$("#name"), v => v.length > 0, "Enter your name."],
      [topic, v => !speaker || v.length >= 10, "Describe your talk in at least 10 characters."],
    ])) return;
    const token = cap.token();
    if (!token) { say("#msg", "Please complete the security check above the button.", "err"); return; }
    await busy(form.querySelector("button[type=submit]"), "Submitting…", async () => {
      try {
        await api("/api/speaker-applications", {kind: kind.value, name: $("#name").value, topic: topic.value, captcha: token});
        form.hidden = true;
        const heading = h("h2", {tabindex: "-1", text: "Application received"});
        $("#existing").hidden = false;
        $("#existing").replaceChildren(h("div", {class: "success-panel", role: "status"}, heading,
          h("p", {text: "Thank you! We'll email you after we review it, usually within a week."}),
          h("div", {class: "btn-row"}, h("a", {class: "btn", href: "account.html", text: "Check status in My account"}),
            h("a", {class: "btn ghost", href: "index.html#events", text: "See upcoming talks"}))));
        heading.focus();
      } catch (x) {
        if (x.status === 401) { location.href = "login.html?next=speaker.html"; return; }
        say("#msg", x.message, "err"); cap.reset();
      }
    });
  });
})();
