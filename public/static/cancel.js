// Cancel a registration from the signed link in a confirmation email.
(() => {
  const {h, $, api, say, busy, fmtWhen} = CCC;
  const token = new URLSearchParams(location.search).get("t") || "";
  const state = $("#state");

  const describe = r => r.starts_at ? `"${r.title}" on ${fmtWhen(r.starts_at)}` : "all weekly talks";

  function done(r) {
    const heading = h("h2", {tabindex: "-1", text: "Registration cancelled"});
    state.replaceChildren(h("div", {class: "success-panel", role: "status"}, heading,
      h("p", {text: `You won't get emails for ${describe(r)}.`}),
      r.paid ? h("p", {class: "muted", text: "Cancelling doesn't refund your payment automatically. Reply to your confirmation email if you need a refund."}) : null,
      h("div", {class: "btn-row"}, h("a", {class: "btn", href: "index.html#events", text: "See other talks"}))));
    heading.focus();
  }

  async function load() {
    if (!token) { state.replaceChildren(h("p", {text: "This link is missing its code. Use the cancel link from your confirmation email, or manage registrations in My account."}), h("p", {}, h("a", {class: "btn", href: "account.html", text: "My account"}))); return; }
    try {
      const {registration: r} = await api("/api/registrations/cancel", {token});
      if (r.cancelled) return done(r);
      const btn = h("button", {type: "button", class: "btn danger", text: "Yes, cancel it"});
      btn.addEventListener("click", () => busy(btn, "Cancelling…", async () => {
        try { const res = await api("/api/registrations/cancel", {token, confirm: true}); done(res.registration); }
        catch (x) { say("#msg", x.message, "err"); }
      }));
      state.replaceChildren(h("p", {text: `Cancel your registration for ${describe(r)}?`}),
        r.paid ? h("p", {class: "muted", text: "Cancelling doesn't refund your payment automatically. Reply to your confirmation email if you need a refund."}) : null,
        h("div", {class: "btn-row"}, btn, h("a", {class: "btn ghost", href: "index.html", text: "Keep it"})));
    } catch (x) {
      state.replaceChildren(h("p", {text: x.message}), h("p", {}, "You can also manage registrations in ", h("a", {href: "account.html", text: "My account"}), "."));
    }
  }
  load();
})();
