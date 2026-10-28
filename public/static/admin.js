const $ = s => document.querySelector(s);
const fmt = ts => ts ? new Date(ts * 1000).toLocaleString() : "";
const COLS = {
  applications: ["id", "kind", "name", "email", "topic", "status", "created_at", "actions"],
  registrations: ["id", "name", "email", "school", "session", "created_at"],
  users: ["id", "email", "role", "created_at", "last_login"],
  audit: ["ts", "event", "email", "ip", "detail"],
};
let current = "applications";

function td(text, cls) { const c = document.createElement("td"); c.textContent = text ?? ""; if (cls) c.className = cls; return c; }

async function setStatus(id, status) {
  try { await CCC.api(`/api/admin/applications/${id}/status`, {status}); load(); }
  catch (x) { alert(x.message); }
}

async function load() {
  const cols = COLS[current];
  const head = document.createElement("tr");
  cols.forEach(c => { const th = document.createElement("th"); th.textContent = c.replace("_", " "); head.appendChild(th); });
  $("#thead").replaceChildren(head);
  try {
    const {rows} = await CCC.api("/api/admin/" + current);
    // textContent only: all stored values are untrusted user input
    $("#tbody").replaceChildren(...rows.map(r => {
      const tr = document.createElement("tr");
      cols.forEach(c => {
        if (c === "actions") {
          const cell = document.createElement("td");
          [["approved", "Approve"], ["rejected", "Reject"]].forEach(([s, label]) => {
            const b = document.createElement("button"); b.className = "btn sm"; b.textContent = label;
            b.onclick = () => setStatus(r.id, s); cell.append(b, " ");
          });
          tr.appendChild(cell);
        } else {
          const isTime = ["created_at", "last_login", "ts"].includes(c);
          tr.appendChild(td(isTime ? fmt(r[c]) : r[c], c === "topic" ? "topic" : ""));
        }
      });
      return tr;
    }));
    if (!rows.length) { const tr = document.createElement("tr"); tr.appendChild(td("Nothing yet.")); $("#tbody").replaceChildren(tr); }
  } catch (x) { $("#msg").textContent = x.message; $("#msg").className = "msg err"; $("#msg").style.display = "block"; }
}

document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  current = b.dataset.t;
  document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("ghost", x !== b));
  load();
});
$("#logout").onclick = async () => { await CCC.api("/api/auth/logout", {}); location.href = "/"; };

CCC.init().then(c => {
  if (!c.user || c.user.role !== "admin") { location.href = "/login?next=/admin"; return; }
  $("#who").textContent = c.user.email;
  load();
});
