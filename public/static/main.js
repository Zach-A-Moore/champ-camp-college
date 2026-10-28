const events=[
  {d:"Oct 22",t:"TBD Business Talk",s:"Speaker TBD",type:"Virtual"},
  {d:"Oct 29",t:"TBD Business Talk",s:"Speaker TBD",type:"Virtual"},
  {d:"Nov 05",t:"Live at Columbia",s:"Speaker TBD",type:"In person"},
  {d:"Nov 12",t:"TBD Business Talk",s:"Speaker TBD",type:"Virtual"},
];
const speakers=["Speaker One","Speaker Two","Speaker Three","Speaker Four"];
const $=s=>document.querySelector(s);

$("#eventList").innerHTML=events.map((e,i)=>{
  const [m,day]=e.d.split(" ");
  return `<div class="event"><div class="date">${m}<b>${day}</b></div>
  <div class="info"><span class="tag ${e.type=="Virtual"?"":"in"}">${e.type}</span>
  <h3>${e.t}</h3><div class="muted">${e.s} &bull; 7:00 PM</div></div>
  <a class="btn dark ghost" href="#register" data-session="${i}">Register</a></div>`}).join("");
document.querySelectorAll("[data-session]").forEach(a=>a.addEventListener("click",()=>{$("#sessionSel").value=a.dataset.session}));

$("#sessionSel").innerHTML="<option value=''>All weekly sessions</option>"+events.map((e,i)=>`<option value="${i}">${e.d} — ${e.t} (${e.type})</option>`).join("");

$("#speakerGrid").innerHTML=speakers.map(n=>`<div class="card"><div class="photo">${n.split(" ")[1][0]}</div>
  <h3>${n}</h3><div class="muted">Title, Company</div><p class="muted" style="margin-top:6px">Short bio and talk topic go here.</p></div>`).join("");

const regCap=CCC.captcha("#regCaptcha");
$("#regForm").onsubmit=async e=>{e.preventDefault();
  const f=e.target,ok=$("#regOk"),er=$("#regErr");ok.style.display=er.style.display="none";
  try{await CCC.api("/api/registrations",{name:f.name.value,email:f.email.value,school:f.school.value,
    session:$("#sessionSel").value,captcha:regCap.token()});ok.style.display="block";f.reset();regCap.reset()}
  catch(x){er.textContent=x.message;er.style.display="block";regCap.reset()}};
CCC.init().then(c=>{if(c.user)$("#navLogin").textContent=c.user.role=="admin"?"Admin":"Account",
  c.user&&c.user.role=="admin"&&($("#navLogin").href="admin.html")});

document.querySelectorAll("#amounts button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll("#amounts button").forEach(x=>x.classList.remove("on"));b.classList.add("on")});
$("#donateBtn").onclick=()=>{const o=$("#donOk");o.style.display="block";
  o.textContent="Demo: would go to payment for "+$("#amounts .on").textContent+" (Stripe/PayPal later)."};

// decorative placeholder QR (not scannable)
(()=>{let h="",n=21,seed=7;const r=()=>(seed=(seed*9301+49297)%233280)/233280;
 const f=(x,y)=>(x<7&&y<7)||(x>13&&y<7)||(x<7&&y>13);
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){
  let on;
  if(f(x,y)){const a=x%14,b=y%14,ring=Math.max(Math.abs(a-3),Math.abs(b-3));on=ring!==2}
  else on=r()>.5;
  if(on)h+=`<rect x="${x}" y="${y}" width="1" height="1"/>`}
 $("#qr").innerHTML=`<svg viewBox="0 0 21 21" width="100%" height="100%" fill="#111">${h}</svg>`})();
