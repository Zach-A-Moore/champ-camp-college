// Landing page after Stripe Checkout: confirm the payment with the server, then show next steps.
(() => {
  const {h, $, api} = CCC;
  const params = new URLSearchParams(location.search);
  const state = $("#state");
  const query = ["session_id", "sim", "demo"].filter(k => params.get(k)).map(k => `${k}=${encodeURIComponent(params.get(k))}`)[0];

  function paid(r) {
    const heading = h("h2", {tabindex: "-1", text: `You're registered, ${r.first_name}!`});
    state.replaceChildren(h("div", {class: "success-panel", role: "status"}, heading,
      h("p", {text: "Your payment went through and your spot is confirmed for every weekly talk this season."}),
      h("p", {text: "We emailed your confirmation. Join links arrive by email before each talk; check your spam folder if you don't see them."}),
      r.simulated ? h("p", {class: "muted", text: "Development mode: no Stripe key is set, so the payment step was simulated and no money was charged."}) : null,
      r.demoCancelUrl ? h("p", {class: "muted"}, "Demo: the cancel link from the email would be ", h("a", {href: r.demoCancelUrl, text: r.demoCancelUrl}), ".") : null,
      h("div", {class: "btn-row"},
        h("a", {class: "btn", href: "index.html#events", text: "See upcoming talks"}),
        h("a", {class: "btn ghost", href: "account.html", text: "My account"}))));
    heading.focus();
  }

  function stillPending() {
    state.replaceChildren(
      h("p", {text: "We haven't received confirmation of your payment yet. This usually takes a few seconds."}),
      h("p", {text: "If you completed checkout, you'll get a confirmation email shortly. If you closed the payment page early, you can register again; you won't be charged twice."}),
      h("div", {class: "btn-row"},
        h("button", {type: "button", class: "btn", text: "Check again", onclick: () => check(0)}),
        h("a", {class: "btn ghost", href: "index.html#register", text: "Back to registration"})));
  }

  async function check(attempt) {
    if (!query) {
      state.replaceChildren(h("p", {text: "This page is shown after paying for registration."}),
        h("p", {}, h("a", {class: "btn", href: "index.html#register", text: "Register"})));
      return;
    }
    if (attempt === 0) state.replaceChildren(h("p", {class: "muted", text: "Confirming your payment…"}));
    try {
      const r = await api("/api/registrations/checkout-status?" + query);
      if (r.status === "paid") return paid(r);
      if (attempt < 6) return setTimeout(() => check(attempt + 1), 2000);
      stillPending();
    } catch (x) {
      state.replaceChildren(h("p", {text: x.message}), h("p", {}, h("a", {class: "btn", href: "index.html#register", text: "Back to registration"})));
    }
  }
  check(0);
})();
