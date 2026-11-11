// "My account": registrations and applications for the signed-in email.
(() => {
  const {h, $, api, say, busy, fmtWhen, fmtStamp} = CCC;
  const STATUS = {pending: "Under review", approved: "Approved", rejected: "Not selected", withdrawn: "Withdrawn"};

  // Two-step inline confirmation instead of a blocking browser dialog.
  function confirmButton(label, confirmLabel, action) {
    const b = h("button", {type: "button", class: "btn danger ghost sm", text: label});
    let armed = false, timer = null;
    b.addEventListener("click", async () => {
      if (!armed) {
        armed = true; b.textContent = confirmLabel;
        timer = setTimeout(() => { armed = false; b.textContent = label; }, 5000);
        return;
      }
      clearTimeout(timer);
      await busy(b, "Working…", action);
    });
    return b;
  }

  async function loadRegs() {
    const list = $("#regs");
    try {
      const {registrations} = await api("/api/me/registrations");
      if (!registrations.length) {
        list.replaceChildren(h("li", {}, h("div", {class: "grow"},
          h("p", {text: "You haven't registered with this email yet."}),
          h("p", {}, h("a", {class: "btn sm", href: "index.html#register", text: `Register for ${CCC.price()}`})))));
        return;
      }
      list.replaceChildren(...registrations.map(r => h("li", {},
        h("div", {class: "grow"},
          h("h3", {text: r.title}),
          h("p", {class: "muted", text: r.starts_at ? `${fmtWhen(r.starts_at)} · ${r.speaker_name}` : "You'll get an email invite for every weekly talk."}),
          r.event_status === "cancelled" ? h("p", {}, h("span", {class: "badge cancelled", text: "Talk cancelled"})) : null,
          r.paid ? h("p", {}, h("span", {class: "badge approved", text: `Paid ${CCC.money(r.amount_cents)}`}),
            " Cancelling stops talk emails but doesn't refund automatically.") : null),
        h("div", {class: "btn-row"},
          r.starts_at && r.event_status === "published" ? CCC.calendarLink({id: r.event_id, title: r.title, speaker_name: r.speaker_name, starts_at: r.starts_at, duration_min: 60}) : null,
          confirmButton("Cancel registration", "Tap again to confirm", async () => {
            try { await api(`/api/me/registrations/${r.id}/cancel`, {}); say("#msg", `Cancelled: ${r.title}.`, "ok"); loadRegs(); }
            catch (x) { say("#msg", x.message, "err"); }
          })))));
    } catch (x) { say("#msg", x.message, "err"); }
  }

  function editForm(a, li) {
    const kind = h("select", {id: `k${a.id}`},
      h("option", {value: "speaker", text: "Give a talk (speaker)"}), h("option", {value: "guest", text: "Sit in as a professional guest"}));
    kind.value = a.kind;
    const name = h("input", {id: `n${a.id}`, maxlength: "100", value: a.name, autocomplete: "name"});
    const topic = h("textarea", {id: `t${a.id}`, rows: "5", maxlength: "2000"});
    topic.value = a.topic;
    const err = h("div", {class: "msg", "aria-live": "polite"});
    const save = h("button", {type: "submit", class: "btn sm", text: "Save changes"});
    const f = h("form", {class: "grow"},
      h("div", {class: "field"}, h("label", {for: kind.id, text: "I'd like to"}), kind),
      h("div", {class: "field"}, h("label", {for: name.id, text: "Your name"}), name),
      h("div", {class: "field"}, h("label", {for: topic.id, text: "Talk title and summary / notes"}), topic),
      h("div", {class: "btn-row"}, save, h("button", {type: "button", class: "btn ghost sm", text: "Cancel", onclick: loadApps})),
      err);
    f.addEventListener("submit", async e => {
      e.preventDefault();
      await busy(save, "Saving…", async () => {
        try {
          await api(`/api/me/applications/${a.id}`, {kind: kind.value, name: name.value, topic: topic.value}, "PATCH");
          say("#msg", "Application updated.", "ok"); loadApps();
        } catch (x) { say(err, x.message, "err"); }
      });
    });
    li.replaceChildren(f);
    name.focus();
  }

  async function loadApps() {
    const list = $("#apps");
    try {
      const {applications} = await api("/api/me/applications");
      if (!applications.length) {
        list.replaceChildren(h("li", {}, h("div", {class: "grow"},
          h("p", {text: "No applications yet."}),
          h("p", {}, h("a", {class: "btn sm", href: "speaker.html", text: "Apply to speak or join as a guest"})))));
        return;
      }
      list.replaceChildren(...applications.map(a => {
        const li = h("li", {});
        li.append(
          h("div", {class: "grow"},
            h("h3", {}, a.kind === "speaker" ? "Speaker application " : "Guest application ",
              h("span", {class: `badge ${a.status}`, text: STATUS[a.status] || a.status})),
            h("p", {class: "muted", text: `Submitted ${fmtStamp(a.created_at)}`}),
            a.topic ? h("p", {class: "topic", text: a.topic}) : null),
          a.status === "pending" ? h("div", {class: "btn-row"},
            h("button", {type: "button", class: "btn ghost sm", text: "Edit", onclick: () => editForm(a, li)}),
            confirmButton("Withdraw", "Tap again to withdraw", async () => {
              try { await api(`/api/me/applications/${a.id}/withdraw`, {}); say("#msg", "Application withdrawn.", "ok"); loadApps(); }
              catch (x) { say("#msg", x.message, "err"); }
            })) : null);
        return li;
      }));
    } catch (x) { say("#msg", x.message, "err"); }
  }

  CCC.init().then(c => {
    if (!c.user) { location.replace("login.html?next=account.html"); return; }
    $("#who").textContent = `Signed in as ${c.user.email}.`;
    loadRegs(); loadApps();
  });
})();
