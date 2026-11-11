// Admin dashboard. All stored values are untrusted user input: render with textContent only (CCC.h).
(() => {
  const {h, $, api, say, busy, fmtStamp, fmtWhen} = CCC;
  const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
  const pages = {applications: 1, registrations: 1, users: 1, audit: 1};
  let events = [];
  let editingId = null;

  const label = c => c.replace(/_/g, " ");
  const isTime = c => /(_at|^ts|last_login)$/.test(c);
  const STATUS = {pending: "Pending", approved: "Approved", rejected: "Not selected", withdrawn: "Withdrawn",
    draft: "Draft", published: "Published", cancelled: "Cancelled"};
  const badge = s => h("span", {class: `badge ${s}`, text: STATUS[s] || s});

  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  function table(host, cols, rows, cell, caption) {
    const head = h("tr", {}, cols.map(c => h("th", {scope: "col", text: label(c)})));
    const body = rows.length ? rows.map(r => h("tr", {}, cols.map(c => {
      const custom = cell ? cell(c, r) : undefined;
      if (custom !== undefined) return custom;
      return h("td", {class: ["topic", "detail", "summary"].includes(c) ? "long" : null, text: isTime(c) ? fmtStamp(r[c]) : (r[c] ?? "")});
    }))) : [h("tr", {}, h("td", {colspan: String(cols.length), text: "Nothing here yet."}))];
    host.replaceChildren(h("table", {}, h("caption", {class: "sr-only", text: caption}), h("thead", {}, head), h("tbody", {}, body)));
  }

  function pager(host, data, key, reload) {
    const pagesTotal = Math.max(1, Math.ceil(data.total / data.page_size));
    const prev = h("button", {type: "button", class: "btn ghost sm", text: "Previous", disabled: data.page <= 1,
      onclick: () => { pages[key]--; reload(); }});
    const next = h("button", {type: "button", class: "btn ghost sm", text: "Next", disabled: data.page >= pagesTotal,
      onclick: () => { pages[key]++; reload(); }});
    host.append(h("div", {class: "pager"}, h("span", {class: "muted", text: `${data.total} total · page ${data.page} of ${pagesTotal}`}), prev, next));
  }

  // ---------- overview ----------
  async function loadOverview() {
    const s = await api("/api/admin/summary");
    const stat = (n, text, tab) => h("div", {class: "stat"}, h("b", {text: String(n)}), h("span", {text}),
      tab ? h("div", {}, h("button", {type: "button", class: "linklike", text: "View", onclick: () => select(tab)})) : null);
    $("#stats").replaceChildren(
      stat(s.pending_applications, "applications waiting for review", "applications"),
      stat(s.upcoming_events, "upcoming published talks", "events"),
      stat(s.active_registrations, "active registrations", "registrations"),
      stat(s.registrations_7d, "new registrations in the last 7 days"),
      stat(CCC.money(s.revenue_cents), `collected from ${s.paid_registrations} paid registration${s.paid_registrations === 1 ? "" : "s"}` + (s.payments_simulated ? " (simulated payments)" : "")),
      stat(s.abandoned_checkouts, "checkouts started but not paid (over an hour old)", "registrations"));
    const n = s.next_event;
    if (!n) {
      $("#nextEvent").replaceChildren(h("p", {}, "No upcoming talks are published. ",
        h("button", {type: "button", class: "linklike", text: "Add a talk", onclick: () => { select("events"); openForm(); }})));
      return;
    }
    $("#nextEvent").replaceChildren(h("div", {class: "next-event"},
      h("h3", {text: n.title}), h("p", {class: "muted", text: fmtWhen(n.starts_at)}),
      h("p", {text: `${n.registered} registered students will get the join link.`}),
      h("p", {text: n.invites_sent_at ? `Join links sent ${fmtStamp(n.invites_sent_at)}.` :
        n.has_link ? "Join links have not been sent yet." : "No join link yet. Add one before sending invites."}),
      h("div", {class: "btn-row"},
        n.has_link ? sendInvitesButton(n.id) : null,
        h("button", {type: "button", class: "btn ghost sm", text: "Edit talk", onclick: async () => {
          select("events"); await loadEvents(); const e = events.find(x => x.id === n.id); if (e) openForm(e);
        }}))));
  }

  function sendInvitesButton(id) {
    const b = h("button", {type: "button", class: "btn sm", text: "Email join links"});
    b.addEventListener("click", () => busy(b, "Sending…", async () => {
      try { const r = await api(`/api/admin/events/${id}/send-invites`, {}); say("#msg", `Join links sent to ${r.sent} people.`, "ok"); refresh(); }
      catch (x) { say("#msg", x.message, "err"); }
    }));
    return b;
  }

  // ---------- applications ----------
  async function setStatus(id, status, button) {
    await busy(button, "Saving…", async () => {
      try {
        const r = await api(`/api/admin/applications/${id}/status`, {status});
        say("#msg", `Application #${id} marked ${STATUS[status].toLowerCase()}.${r.notified ? " The applicant was emailed." : ""}`, "ok");
        loadApplications(); loadOverview().catch(() => {});
      } catch (x) { say("#msg", x.message, "err"); }
    });
  }

  async function loadApplications() {
    const q = new URLSearchParams({page: pages.applications, status: $("#appStatus").value, kind: $("#appKind").value, q: $("#appQ").value.trim()});
    const data = await api("/api/admin/applications?" + q);
    const host = $("#appTable");
    table(host, ["id", "kind", "name", "email", "topic", "status", "created_at", "actions"], data.rows, (c, r) => {
      if (c === "status") return h("td", {}, badge(r.status));
      if (c === "email") return h("td", {}, h("a", {href: "mailto:" + r.email, text: r.email}));
      if (c !== "actions") return undefined;
      if (r.status === "withdrawn") return h("td", {class: "muted", text: "Withdrawn by applicant"});
      const cellEl = h("td", {});
      [["approved", "Approve", "btn sm"], ["rejected", "Reject", "btn danger ghost sm"], ["pending", "Back to pending", "btn ghost sm"]]
        .filter(([s]) => s !== r.status)
        .forEach(([s, text, cls]) => {
          const b = h("button", {type: "button", class: cls, text, "aria-label": `${text} application ${r.id} from ${r.name}`});
          b.addEventListener("click", () => setStatus(r.id, s, b));
          cellEl.append(b);
        });
      return cellEl;
    }, "Speaker and guest applications");
    pager(host, data, "applications", loadApplications);
  }

  // ---------- events ----------
  const toLocalInput = ts => {
    const d = new Date(ts * 1000), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function openForm(e) {
    editingId = e ? e.id : null;
    $("#eventFormTitle").textContent = e ? `Edit talk #${e.id}` : "Add a talk";
    $("#evTitle").value = e ? e.title : "";
    $("#evSpeaker").value = e ? e.speaker_name : "";
    $("#evSpeakerTitle").value = e ? e.speaker_title : "";
    $("#evStart").value = e ? toLocalInput(e.starts_at) : "";
    $("#evDuration").value = e ? e.duration_min : 60;
    $("#evSummary").value = e ? e.summary : "";
    $("#evJoin").value = e ? e.join_url : "";
    $("#evStatus").value = e ? e.status : "draft";
    $("#eventForm").dataset.was = e ? e.status : "";
    syncNotify();
    $("#eventForm").hidden = false;
    $("#evTitle").focus();
  }
  function syncNotify() {
    $("#notifyWrap").hidden = !($("#evStatus").value === "cancelled" && $("#eventForm").dataset.was === "published");
  }

  async function loadEvents() {
    const data = await api("/api/admin/events");
    events = data.rows;
    table($("#eventTable"), ["starts_at", "title", "speaker_name", "status", "registered", "join_link", "actions"], events, (c, r) => {
      if (c === "starts_at") return h("td", {text: fmtWhen(r.starts_at)});
      if (c === "status") return h("td", {}, badge(r.status));
      if (c === "join_link") return h("td", {text: r.join_url ? (r.invites_sent_at ? `Sent ${fmtStamp(r.invites_sent_at)}` : "Added, not sent") : "Missing"});
      if (c !== "actions") return undefined;
      const upcoming = r.status === "published" && r.starts_at + r.duration_min * 60 > Date.now() / 1000;
      return h("td", {},
        h("button", {type: "button", class: "btn ghost sm", text: "Edit", "aria-label": `Edit ${r.title}`, onclick: () => openForm(r)}),
        upcoming && r.join_url ? sendInvitesButton(r.id) : null);
    }, "Talks");
  }

  $("#newEvent").addEventListener("click", () => openForm(null));
  $("#cancelEdit").addEventListener("click", () => { $("#eventForm").hidden = true; $("#newEvent").focus(); });
  $("#evStatus").addEventListener("change", syncNotify);
  $("#eventForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const start = $("#evStart").value ? Math.floor(new Date($("#evStart").value).getTime() / 1000) : NaN;
    if (!$("#evTitle").value.trim() || !$("#evSpeaker").value.trim() || !Number.isFinite(start)) {
      say("#msg", "Title, speaker and date/time are required.", "err"); return;
    }
    const body = {title: $("#evTitle").value, speaker_name: $("#evSpeaker").value, speaker_title: $("#evSpeakerTitle").value,
      summary: $("#evSummary").value, starts_at: start, duration_min: Number($("#evDuration").value) || 60,
      join_url: $("#evJoin").value.trim(), status: $("#evStatus").value, notify: !$("#notifyWrap").hidden && $("#evNotify").checked};
    await busy(ev.target.querySelector("button[type=submit]"), "Saving…", async () => {
      try {
        const r = editingId ? await api(`/api/admin/events/${editingId}`, body, "PUT") : await api("/api/admin/events", body);
        say("#msg", `Talk saved.${r.notified ? ` ${r.notified} registrants were emailed about the cancellation.` : ""}`, "ok");
        $("#eventForm").hidden = true;
        loadEvents(); loadOverview().catch(() => {});
      } catch (x) { say("#msg", x.message, "err"); }
    });
  });

  // ---------- registrations ----------
  const regQuery = () => new URLSearchParams({status: $("#regStatus").value, q: $("#regQ").value.trim()});
  const PAY = {paid: "Paid", pending: "Not paid", free: "Pre-fee"};

  async function loadRegistrations() {
    const q = regQuery(); q.set("page", pages.registrations);
    const data = await api("/api/admin/registrations?" + q);
    const host = $("#regTable");
    table(host, ["id", "name", "email", "school", "major", "year", "payment", "created_at", "paid_at", "cancelled_at"], data.rows, (c, r) => {
      if (c !== "payment") return undefined;
      const cls = r.payment === "paid" ? "approved" : r.payment === "pending" ? "pending" : "draft";
      return h("td", {}, h("span", {class: `badge ${cls}`, text: PAY[r.payment] || r.payment}), r.amount_cents ? ` ${CCC.money(r.amount_cents)}` : "");
    }, "Student registrations");
    pager(host, data, "registrations", loadRegistrations);
  }

  $("#exportCsv").addEventListener("click", async () => {
    if (!CCC.isDemo()) { location.href = "api/admin/registrations.csv?" + regQuery(); return; }
    const q = regQuery(); q.set("page", 1);
    const {rows} = await api("/api/admin/registrations?" + q);
    const cols = ["id", "name", "email", "school", "major", "year", "payment", "amount_cents", "created_at", "paid_at", "cancelled_at"];
    const safe = v => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => safe(r[c])).join(","))].join("\r\n");
    const a = h("a", {href: URL.createObjectURL(new Blob([csv], {type: "text/csv"})), download: "ccc-registrations-demo.csv"});
    document.body.append(a); a.click(); a.remove();
  });

  // ---------- users & audit ----------
  async function loadUsers() {
    const data = await api("/api/admin/users?page=" + pages.users);
    table($("#userTable"), ["id", "email", "role", "created_at", "last_login"], data.rows, null, "Users");
    pager($("#userTable"), data, "users", loadUsers);
  }
  async function loadAudit() {
    const data = await api("/api/admin/audit?page=" + pages.audit);
    table($("#auditTable"), ["ts", "event", "email", "ip", "detail"], data.rows, null, "Activity log");
    pager($("#auditTable"), data, "audit", loadAudit);
  }

  // ---------- tabs ----------
  const loaders = {overview: loadOverview, applications: loadApplications, events: loadEvents,
    registrations: loadRegistrations, users: loadUsers, audit: loadAudit};
  let current = "overview";
  const refresh = () => loaders[current]().catch(x => say("#msg", x.message, "err"));

  function select(name, focus) {
    current = name;
    tabs.forEach(t => {
      const on = t.dataset.t === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      if (on && focus) t.focus();
    });
    history.replaceState(null, "", "#" + name);
    refresh();
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => { say("#msg", ""); select(t.dataset.t); });
    t.addEventListener("keydown", e => {
      const k = {ArrowRight: 1, ArrowLeft: -1}[e.key];
      if (k) { e.preventDefault(); select(tabs[(i + k + tabs.length) % tabs.length].dataset.t, true); }
      if (e.key === "Home") { e.preventDefault(); select(tabs[0].dataset.t, true); }
      if (e.key === "End") { e.preventDefault(); select(tabs[tabs.length - 1].dataset.t, true); }
    });
  });

  const reApps = () => { pages.applications = 1; loadApplications().catch(x => say("#msg", x.message, "err")); };
  const reRegs = () => { pages.registrations = 1; loadRegistrations().catch(x => say("#msg", x.message, "err")); };
  $("#appStatus").addEventListener("change", reApps);
  $("#appKind").addEventListener("change", reApps);
  $("#appQ").addEventListener("input", debounce(reApps, 300));
  $("#regStatus").addEventListener("change", reRegs);
  $("#regQ").addEventListener("input", debounce(reRegs, 300));

  CCC.init().then(c => {
    if (!c.user) { location.replace("login.html?next=admin.html"); return; }
    $("#who").textContent = `Signed in as ${c.user.email}.`;
    if (c.user.role !== "admin") { $("#denied").hidden = false; return; }
    $("#dash").hidden = false;
    const start = location.hash.slice(1);
    select(loaders[start] ? start : "overview");
  });
})();
