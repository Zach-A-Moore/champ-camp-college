// Homepage: upcoming talks, speakers, and student registration ($5 via Stripe Checkout).
(() => {
  const {h, $, api, say, busy, validate, fmtWhen} = CCC;
  const form = $("#regForm");
  const regArea = $("#regArea");
  const regCap = CCC.captcha("#regCaptcha");
  let events = [];

  const isTba = e => /to be announced/i.test(e.speaker_name);
  const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");

  function goRegister() {
    $("#register").scrollIntoView();
    $("#regName").focus({preventScroll: true});
  }

  function renderEvents() {
    const list = $("#eventList");
    if (!events.length) {
      list.replaceChildren(h("div", {class: "empty"},
        h("p", {text: "The next talks will be announced soon."}),
        h("p", {}, h("a", {href: "#register", text: "Register now"}), " and we'll email you when they're scheduled.")));
      return;
    }
    list.replaceChildren(...events.map(e => {
      const d = new Date(e.starts_at * 1000);
      return h("article", {class: "event", "aria-labelledby": "ev-" + e.id},
        h("div", {class: "date", "aria-hidden": "true"}, d.toLocaleDateString(undefined, {month: "short"}),
          h("b", {text: String(d.getDate())})),
        h("div", {class: "info"},
          h("span", {class: "tag", text: "Live online"}),
          h("h3", {id: "ev-" + e.id, text: e.title}),
          h("p", {class: "muted", text: `${fmtWhen(e.starts_at)} · ${isTba(e) ? "Speaker to be announced" : e.speaker_name}`}),
          e.summary ? h("p", {text: e.summary}) : null),
        h("button", {type: "button", class: "btn ghost", onclick: goRegister,
          text: "Register to attend", "aria-describedby": "ev-" + e.id}));
    }));
  }

  function renderSpeakers() {
    const seen = new Set();
    const cards = events.filter(e => !isTba(e) && !seen.has(e.speaker_name) && seen.add(e.speaker_name)).map(e =>
      h("article", {class: "card"},
        h("div", {class: "photo", "aria-hidden": "true", text: initials(e.speaker_name)}),
        h("h3", {text: e.speaker_name}),
        e.speaker_title ? h("p", {class: "muted", text: e.speaker_title}) : null,
        h("p", {}, "Talk: ", h("a", {href: "#ev-" + e.id, text: e.title})),
        h("p", {class: "muted", text: fmtWhen(e.starts_at)})));
    cards.push(h("div", {class: "card invite"},
      h("h3", {text: "Could this be you?"}),
      h("p", {class: "muted", text: "We're booking business owners and leaders for this season."}),
      h("a", {class: "btn ghost sm", href: "speaker.html", text: "Apply to speak"})));
    $("#speakerGrid").replaceChildren(...cards);
  }

  api("/api/events").then(r => {
    events = r.events || [];
    renderEvents(); renderSpeakers();
    if (events[0]) $("#heroFacts").textContent = `Next talk: ${fmtWhen(events[0].starts_at)} · Online · ${CCC.price()} for every talk this season`;
    if (location.hash && location.hash !== "#") { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }).catch(e => {
    $("#eventList").replaceChildren(h("p", {class: "empty", text: "We couldn't load the schedule right now. " + e.message}));
    renderSpeakers();
  });

  if (new URLSearchParams(location.search).get("payment") === "cancelled") {
    say("#payNote", "Payment wasn't completed, so you aren't registered yet. Fill in the form again whenever you're ready.", "err");
  }

  function showAlready(email) {
    const heading = h("h3", {tabindex: "-1", text: "You're already registered"});
    const panel = h("div", {class: "success-panel", role: "status"}, heading,
      h("p", {}, h("b", {text: email}), " already has a paid registration, so we didn't charge you again. We re-sent your confirmation email."),
      h("div", {class: "btn-row"},
        h("a", {class: "btn", href: "account.html", text: "See my registration"}),
        h("button", {type: "button", class: "btn ghost", text: "Register a different email", onclick: () => {
          panel.remove(); form.hidden = false; form.reset(); regCap.reset(); $("#regName").focus();
        }})));
    form.hidden = true;
    regArea.append(panel);
    heading.focus();
  }

  // Only follow redirects to Stripe Checkout or back to our own confirmation page.
  function safeCheckout(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === "https://checkout.stripe.com" || (u.origin === location.origin && /\/registered(\.html)?$/.test(u.pathname));
    } catch { return false; }
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    say("#regErr", "");
    const els = form.elements;
    const ok = validate(form, [
      [els.name, v => v.length > 0, "Enter your full name."],
      [els.email, v => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v), "Enter a valid email address, like you@school.edu."],
      [els.major, v => v.length > 0, "Enter your major (or \"Undecided\")."],
      [els.year, v => v.length > 0, "Choose your year in school."],
    ]);
    if (!ok) return;
    const captcha = regCap.token();
    if (!captcha) { say("#regErr", "Please complete the security check above the button.", "err"); return; }
    const button = form.querySelector("button[type=submit]");
    await busy(button, "Starting secure checkout…", async () => {
      try {
        const r = await api("/api/registrations", {
          name: els.name.value, email: els.email.value, school: els.school.value, major: els.major.value,
          year: els.year.value, captcha,
        });
        if (r.already_registered) return showAlready(els.email.value.trim());
        if (!r.checkout_url || !safeCheckout(r.checkout_url)) throw new Error("We couldn't start the payment. Please try again.");
        button.textContent = "Redirecting to payment…";
        location.href = r.checkout_url;
        await new Promise(() => {}); // keep the button disabled while the browser navigates away
      } catch (x) {
        say("#regErr", x.message, "err");
        regCap.reset();
      }
    });
  });

  CCC.init().then(c => {
    if (c.user && !$("#regEmail").value) $("#regEmail").value = c.user.email;
    if (c.contactEmail) {
      $("#supportContact").replaceChildren("Want to sponsor a talk or help now? Email ",
        h("a", {href: "mailto:" + c.contactEmail, text: c.contactEmail}), ".");
    }
  });
})();
