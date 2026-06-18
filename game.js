/* =========================================================================
   SCHEDULE ZERO — a Schedule 1–style management sim (inspired by TVGS)
   Pure vanilla JS. No build step, no dependencies. State persists to
   localStorage. The whole game runs as a day-by-day loop: produce product
   in the lab, sell it on the market or via your crew, manage police heat,
   and reinvest into upgrades to grow the operation.
   ========================================================================= */

"use strict";

const SAVE_KEY = "schedule_zero_save_v1";

/* ---------------------------------------------------------------------------
   Static data
   --------------------------------------------------------------------------- */

// Product strains unlocked by reputation. Better strains = higher base value
// and quality ceiling, but cost more supplies per batch.
const STRAINS = [
  { id: "swill",   name: "Backyard Swill", base: 18,  quality: 0.5, supply: 1, repReq: 0  },
  { id: "green",   name: "Green Crack",    base: 32,  quality: 0.7, supply: 2, repReq: 15 },
  { id: "haze",    name: "Sour Haze",      base: 55,  quality: 0.85,supply: 3, repReq: 50 },
  { id: "diesel",  name: "Sour Diesel",    base: 90,  quality: 0.95,supply: 4, repReq: 120 },
  { id: "kush",    name: "OG Kush Reserve",base: 150, quality: 1.1, supply: 6, repReq: 260 },
];

// Customer archetypes. Pulled into the daily market based on reputation.
const CUSTOMER_TYPES = [
  { name: "Nervous Student",  repReq: 0,   min: 1,  max: 3,  pay: 1.0,  heat: 1 },
  { name: "Regular Joe",      repReq: 10,  min: 2,  max: 5,  pay: 1.05, heat: 1 },
  { name: "Frat House",       repReq: 30,  min: 4,  max: 9,  pay: 1.1,  heat: 2 },
  { name: "Club Promoter",    repReq: 70,  min: 8,  max: 16, pay: 1.25, heat: 3 },
  { name: "Biker Contact",    repReq: 140, min: 14, max: 28, pay: 1.4,  heat: 5 },
  { name: "The Connect",      repReq: 280, min: 30, max: 60, pay: 1.7,  heat: 8 },
];

// Crew you can hire. Dealers move product; lawyers shed heat.
const CREW_TYPES = [
  { id: "dealer1", role: "dealer", name: "Benji",  hire: 250,  wage: 40,  capacity: 6,  cut: 0.20, repReq: 5  },
  { id: "dealer2", role: "dealer", name: "Tasha",  hire: 600,  wage: 90,  capacity: 12, cut: 0.18, repReq: 40 },
  { id: "dealer3", role: "dealer", name: "Marco",  hire: 1500, wage: 200, capacity: 24, cut: 0.16, repReq: 110 },
  { id: "lawyer1", role: "lawyer", name: "Saul-ish",hire: 1200, wage: 150, repReq: 60, heatCut: 6 },
  { id: "cleaner", role: "cleaner",name: "The Mop", hire: 2000, wage: 220, repReq: 130, heatCut: 12 },
];

// One-time permanent upgrades.
const UPGRADES = [
  { id: "station2", name: "Second Grow Station", cost: 400,  desc: "Run two batches at once.", effect: s => s.stations = Math.max(s.stations,2) },
  { id: "station3", name: "Third Grow Station",  cost: 1400, desc: "Run three batches at once.", req: s=>s.upgrades.station2, effect: s => s.stations = Math.max(s.stations,3) },
  { id: "station4", name: "Warehouse Floor",     cost: 4000, desc: "A fourth station for the empire.", req: s=>s.upgrades.station3, effect: s => s.stations = Math.max(s.stations,4) },
  { id: "lights",   name: "LED Grow Lights",     cost: 700,  desc: "Batches mature 1 day faster.", effect: s => s.growSpeed += 1 },
  { id: "nutrients",name: "Premium Nutrients",   cost: 900,  desc: "+15% product quality.", effect: s => s.qualityBonus += 0.15 },
  { id: "yield",    name: "Hydroponics Rig",     cost: 1100, desc: "+40% units harvested per batch.", effect: s => s.yieldBonus += 0.40 },
  { id: "storage",  name: "Stash House",         cost: 600,  desc: "+50 inventory capacity.", effect: s => s.invCap += 50 },
  { id: "storage2", name: "Buried Bunker",       cost: 2200, desc: "+150 inventory capacity.", req:s=>s.upgrades.storage, effect: s => s.invCap += 150 },
  { id: "scanner",  name: "Police Scanner",      cost: 1300, desc: "Halves the chance of a bust.", effect: s => s.bustResist += 0.5 },
  { id: "launder",  name: "Laundromat Front",    cost: 3000, desc: "Heat decays 50% faster each day.", effect: s => s.heatDecayBonus += 0.5 },
];

// Flavor strings for the daily street-price wobble & events.
const RANDOM_EVENTS = [
  { id:"drought",  chance:0.10, run:(s)=>{ s.priceMod = 1.4; log("Supply drought! Street prices spike +40% today.","warn"); } },
  { id:"glut",     chance:0.10, run:(s)=>{ s.priceMod = 0.7; log("Market flooded. Prices down 30% today.","warn"); } },
  { id:"festival", chance:0.08, run:(s)=>{ s.demandMod = 1.8; log("Music festival in town — demand surging!","good"); } },
  { id:"crackdown",chance:0.08, run:(s)=>{ s.heat = clamp(s.heat+15,0,100); log("Citywide crackdown. Heat +15.","bad"); } },
  { id:"tip",      chance:0.06, run:(s)=>{ s.cash += 150; log("A grateful customer left a $150 tip.","good"); } },
  { id:"theft",    chance:0.06, run:(s)=>{ const lost=Math.min(s.inventory, Math.ceil(s.inventory*0.15)); s.inventory-=lost; if(lost>0) log(`Stash robbed! Lost ${lost} units.`,"bad"); } },
];

/* ---------------------------------------------------------------------------
   Game state
   --------------------------------------------------------------------------- */

let S = null; // the single live state object

function defaultState() {
  return {
    day: 1,
    cash: 200,
    rep: 0,
    heat: 0,
    inventory: 0,
    invCap: 50,
    supplies: 3,

    stations: 1,
    batches: [],          // { strainId, progress, total, yieldUnits }
    growSpeed: 0,         // days shaved off maturation
    qualityBonus: 0,
    yieldBonus: 0,
    bustResist: 0,        // 0..1 reduction
    heatDecayBonus: 0,

    crew: [],             // hired crew ids
    crewUnpaid: 0,        // consecutive unpaid days

    upgrades: {},         // id -> true

    // per-day transient modifiers (reset each advance)
    priceMod: 1,
    demandMod: 1,

    customers: [],        // today's market

    // lifetime stats
    totalEarned: 0,
    totalSold: 0,
    daysSurvived: 0,
    busts: 0,
  };
}

/* ---------------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const money = (n) => "$" + Math.round(n).toLocaleString();

function strainById(id) { return STRAINS.find(s => s.id === id); }
function crewById(id)   { return CREW_TYPES.find(c => c.id === id); }

// Reputation tier unlocks the best strain currently available.
function bestStrain() {
  let best = STRAINS[0];
  for (const st of STRAINS) if (S.rep >= st.repReq) best = st;
  return best;
}

// Quality-adjusted street price for one unit of a given strain.
function unitPrice(strain) {
  const q = strain.quality + S.qualityBonus;
  return strain.base * q * S.priceMod;
}

/* ---------------------------------------------------------------------------
   Logging / toast / modal
   --------------------------------------------------------------------------- */

let logBuffer = [];
function log(msg, kind = "") {
  const day = S ? S.day : 0;
  logBuffer.unshift({ day, msg, kind });
  if (logBuffer.length > 60) logBuffer.pop();
  renderLog();
}
function renderLog() {
  const el = $("#log");
  if (!el) return;
  el.innerHTML = logBuffer
    .map(l => `<div class="line ${l.kind}"><span class="day">[Day ${l.day}]</span> ${l.msg}</div>`)
    .join("");
}

let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast hidden"; }, 1800);
}

function showModal(title, body, actions) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = body;
  const wrap = $("#modalActions");
  wrap.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn " + (a.cls || "");
    b.textContent = a.label;
    b.onclick = () => { hideModal(); a.fn && a.fn(); };
    wrap.appendChild(b);
  }
  $("#modal").classList.remove("hidden");
}
function hideModal() { $("#modal").classList.add("hidden"); }

/* ---------------------------------------------------------------------------
   Production (Lab)
   --------------------------------------------------------------------------- */

function supplyCost() {
  // supplies get a bit pricier as the operation scales
  return 25 + Math.floor(S.rep / 20) * 5;
}

function buySupplies() {
  const cost = supplyCost();
  if (S.cash < cost) return toast("Not enough cash.", "bad");
  S.cash -= cost;
  S.supplies += 5;
  toast("+5 supplies", "good");
  render();
}

function maturationDays(strain) {
  // bigger strains take longer; lights speed it up; min 2 days
  const base = 3 + STRAINS.indexOf(strain);
  return Math.max(2, base - S.growSpeed);
}

function startBatch(stationIndex) {
  if (S.batches.some(b => b.station === stationIndex)) return;
  const strain = bestStrain();
  if (S.supplies < strain.supply) return toast("Not enough supplies.", "bad");

  S.supplies -= strain.supply;
  const total = maturationDays(strain);
  const baseYield = 8 + STRAINS.indexOf(strain) * 4;
  const yieldUnits = Math.round(baseYield * (1 + S.yieldBonus));
  S.batches.push({ station: stationIndex, strainId: strain.id, progress: 0, total, yieldUnits });
  log(`Started a ${strain.name} batch (matures in ${total} days, ~${yieldUnits} units).`);
  render();
}

function harvestBatch(stationIndex) {
  const idx = S.batches.findIndex(b => b.station === stationIndex && b.progress >= b.total);
  if (idx === -1) return;
  const b = S.batches[idx];
  const space = S.invCap - S.inventory;
  const got = Math.min(b.yieldUnits, space);
  S.inventory += got;
  const wasted = b.yieldUnits - got;
  S.batches.splice(idx, 1);
  const strain = strainById(b.strainId);
  log(`Harvested ${got} units of ${strain.name}.${wasted > 0 ? ` (${wasted} lost — no storage!)` : ""}`,
      wasted > 0 ? "warn" : "good");
  render();
}

/* ---------------------------------------------------------------------------
   Market
   --------------------------------------------------------------------------- */

function rollCustomers() {
  S.customers = [];
  const available = CUSTOMER_TYPES.filter(c => S.rep >= c.repReq);
  const count = clamp(2 + Math.floor(S.rep / 25), 2, 6);
  for (let i = 0; i < count; i++) {
    const type = available[rand(0, available.length - 1)];
    const want = Math.round(rand(type.min, type.max) * S.demandMod);
    S.customers.push({
      id: "c" + i + "_" + Date.now() + Math.random(),
      name: type.name,
      want,
      payMult: type.pay,
      heat: type.heat,
      served: false,
    });
  }
}

function sellTo(custId) {
  const c = S.customers.find(x => x.id === custId);
  if (!c || c.served) return;
  if (S.inventory <= 0) return toast("No inventory to sell.", "bad");

  const strain = bestStrain();
  const qty = Math.min(c.want, S.inventory);
  const price = unitPrice(strain) * c.payMult;
  const revenue = Math.round(price * qty);

  S.inventory -= qty;
  S.cash += revenue;
  S.totalEarned += revenue;
  S.totalSold += qty;
  S.rep += Math.max(1, Math.round(qty / 2));
  S.heat = clamp(S.heat + c.heat, 0, 100);
  c.served = true;

  log(`Sold ${qty} units to ${c.name} for ${money(revenue)}.`, "good");
  toast(`+${money(revenue)}`, "good");
  render();
}

/* ---------------------------------------------------------------------------
   Crew
   --------------------------------------------------------------------------- */

function hireCrew(id) {
  if (S.crew.includes(id)) return;
  const c = crewById(id);
  if (S.rep < c.repReq) return toast("Reputation too low.", "bad");
  if (S.cash < c.hire) return toast("Can't afford the signing fee.", "bad");
  S.cash -= c.hire;
  S.crew.push(id);
  log(`Hired ${c.name} (${c.role}).`, "good");
  render();
}

function fireCrew(id) {
  S.crew = S.crew.filter(x => x !== id);
  const c = crewById(id);
  log(`${c.name} is off the payroll.`, "warn");
  render();
}

function runCrewDay() {
  let wages = 0;
  let dealerSold = 0, dealerRevenue = 0, dealerHeat = 0, heatRemoved = 0;

  for (const id of S.crew) {
    const c = crewById(id);
    wages += c.wage;
    if (c.role === "dealer" && S.inventory > 0) {
      const strain = bestStrain();
      const qty = Math.min(c.capacity, S.inventory);
      const gross = unitPrice(strain) * qty;
      const net = gross * (1 - c.cut);
      S.inventory -= qty;
      S.cash += net;
      S.totalEarned += net;
      S.totalSold += qty;
      dealerSold += qty;
      dealerRevenue += net;
      dealerHeat += Math.ceil(qty / 8);
      S.rep += Math.max(1, Math.round(qty / 4));
    } else if (c.role === "lawyer" || c.role === "cleaner") {
      heatRemoved += c.heatCut;
    }
  }

  // pay wages (if you can)
  if (wages > 0) {
    if (S.cash >= wages) {
      S.cash -= wages;
      S.crewUnpaid = 0;
    } else {
      S.crewUnpaid += 1;
      log(`Couldn't make payroll (${money(wages)})! Crew is unhappy (${S.crewUnpaid}/2).`, "bad");
      if (S.crewUnpaid >= 2 && S.crew.length) {
        const quit = S.crew.pop();
        S.crewUnpaid = 0;
        log(`${crewById(quit).name} walked out over unpaid wages.`, "bad");
      }
    }
  }

  if (dealerSold > 0) {
    S.heat = clamp(S.heat + dealerHeat, 0, 100);
    log(`Crew moved ${dealerSold} units for ${money(dealerRevenue)} (after cut).`, "good");
  }
  if (heatRemoved > 0) {
    S.heat = clamp(S.heat - heatRemoved, 0, 100);
    log(`Legal/cleanup crew shed ${heatRemoved} heat.`);
  }
}

/* ---------------------------------------------------------------------------
   Upgrades
   --------------------------------------------------------------------------- */

function buyUpgrade(id) {
  const u = UPGRADES.find(x => x.id === id);
  if (S.upgrades[id]) return;
  if (u.req && !u.req(S)) return toast("Requires a prerequisite upgrade.", "bad");
  if (S.cash < u.cost) return toast("Not enough cash.", "bad");
  S.cash -= u.cost;
  S.upgrades[id] = true;
  u.effect(S);
  log(`Purchased upgrade: ${u.name}.`, "good");
  render();
}

/* ---------------------------------------------------------------------------
   Day loop
   --------------------------------------------------------------------------- */

function advanceDay() {
  // reset transient mods
  S.priceMod = 1;
  S.demandMod = 1;

  // age batches
  for (const b of S.batches) {
    if (b.progress < b.total) b.progress += 1;
  }

  // crew does its thing
  runCrewDay();

  // random event (at most one a day)
  for (const ev of RANDOM_EVENTS) {
    if (Math.random() < ev.chance) { ev.run(S); break; }
  }

  // heat decay
  const decay = 3 * (1 + S.heatDecayBonus);
  S.heat = clamp(S.heat - decay, 0, 100);

  // bust check — risk scales with heat
  checkBust();

  if (!S) return; // game ended in a bust

  // new market each morning
  S.day += 1;
  S.daysSurvived += 1;
  rollCustomers();

  // small street-price wobble baked into priceMod for the new day’s display
  S.priceMod = 0.9 + Math.random() * 0.3;

  log(`A new day begins. Street price ~${money(unitPrice(bestStrain()))}/unit.`);
  autoSave();
  render();
}

function checkBust() {
  const risk = (S.heat / 100) * 0.5 * (1 - S.bustResist); // up to 50% at max heat
  if (S.heat > 25 && Math.random() < risk) {
    S.busts += 1;
    const seizedCash = Math.round(S.cash * 0.4);
    const seizedInv = Math.round(S.inventory * 0.6);
    S.cash -= seizedCash;
    S.inventory -= seizedInv;
    S.heat = clamp(S.heat - 40, 0, 100);
    S.rep = Math.max(0, S.rep - 20);

    if (S.cash <= 0 && S.inventory <= 0 && S.busts >= 3) {
      return gameOver();
    }
    log(`🚨 RAIDED! Lost ${money(seizedCash)} and ${seizedInv} units. Heat reduced.`, "bad");
    showModal("🚨 Police Raid!",
      `The cops kicked in the door.<br><br>Seized: <b>${money(seizedCash)}</b> and <b>${seizedInv} units</b>.<br>You lay low — heat drops, but so does your reputation.`,
      [{ label: "Rough day.", cls: "btn-danger" }]);
  }
}

function gameOver() {
  showModal("⛓️ Game Over",
    `Three raids and nothing left to your name. The empire is finished.<br><br>` +
    `You survived <b>${S.daysSurvived} days</b> and earned <b>${money(S.totalEarned)}</b> in your career.`,
    [{ label: "Start Over", cls: "btn-primary", fn: () => { localStorage.removeItem(SAVE_KEY); location.reload(); } }]);
  S = null;
  localStorage.removeItem(SAVE_KEY);
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */

function render() {
  if (!S) return;
  // top bar
  $("#cash").textContent = Math.round(S.cash).toLocaleString();
  $("#rep").textContent = Math.round(S.rep);
  $("#day").textContent = S.day;
  $("#heatFill").style.width = S.heat + "%";

  // lab
  $("#invCount").textContent = S.inventory;
  $("#invCap").textContent = S.invCap;
  $("#supplies").textContent = S.supplies;
  $("#supplyCost").textContent = money(supplyCost());
  renderStations();

  // market
  $("#streetPrice").textContent = Math.round(unitPrice(bestStrain()));
  renderCustomers();

  // crew + shop + stats
  renderCrew();
  renderShop();
  renderStats();
}

function renderStations() {
  const grid = $("#stationGrid");
  grid.innerHTML = "";
  for (let i = 0; i < S.stations; i++) {
    const batch = S.batches.find(b => b.station === i);
    const div = document.createElement("div");
    div.className = "station";
    if (!batch) {
      const strain = bestStrain();
      div.innerHTML = `
        <h3>Station ${i + 1} <span class="pill">empty</span></h3>
        <p class="muted">Next batch: <span class="strain">${strain.name}</span></p>
        <div class="row"><span>Cost</span><span>${strain.supply} supplies</span></div>
        <div class="row"><span>Matures in</span><span>${maturationDays(strain)} days</span></div>
        <button class="btn btn-primary btn-sm" data-start="${i}" ${S.supplies < strain.supply ? "disabled" : ""}>Plant Batch</button>`;
    } else {
      const strain = strainById(batch.strainId);
      const done = batch.progress >= batch.total;
      const pct = Math.min(100, Math.round((batch.progress / batch.total) * 100));
      div.innerHTML = `
        <h3>Station ${i + 1} <span class="pill ${done ? "good" : ""}">${done ? "ready" : "growing"}</span></h3>
        <p class="muted"><span class="strain">${strain.name}</span></p>
        <div class="progress"><div style="width:${pct}%"></div></div>
        <div class="row"><span>Day ${batch.progress}/${batch.total}</span><span>~${batch.yieldUnits} units</span></div>
        ${done
          ? `<button class="btn btn-primary btn-sm" data-harvest="${i}">Harvest 🌾</button>`
          : `<button class="btn btn-sm" disabled>Maturing…</button>`}`;
    }
    grid.appendChild(div);
  }
  grid.querySelectorAll("[data-start]").forEach(b => b.onclick = () => startBatch(+b.dataset.start));
  grid.querySelectorAll("[data-harvest]").forEach(b => b.onclick = () => harvestBatch(+b.dataset.harvest));
}

function renderCustomers() {
  const list = $("#customerList");
  list.innerHTML = "";
  if (!S.customers.length) {
    list.innerHTML = `<p class="muted">No customers right now. End the day to attract new buyers.</p>`;
    return;
  }
  const strain = bestStrain();
  for (const c of S.customers) {
    const each = Math.round(unitPrice(strain) * c.payMult);
    const qty = Math.min(c.want, S.inventory);
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <h3>${c.name} ${c.served ? '<span class="pill good">sold</span>' : ""}</h3>
      <div class="sub">Wants <b>${c.want}</b> units · pays <b>${money(each)}</b>/unit</div>
      <div class="tags">
        <span class="pill gold">+${money(each * c.want)} max</span>
        <span class="pill ${c.heat >= 3 ? "bad" : ""}">🔥 ${c.heat} heat</span>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" data-sell="${c.id}" ${c.served || S.inventory <= 0 ? "disabled" : ""}>
          Sell ${qty} for ${money(each * qty)}
        </button>
      </div>`;
    list.appendChild(div);
  }
  list.querySelectorAll("[data-sell]").forEach(b => b.onclick = () => sellTo(b.dataset.sell));
}

function renderCrew() {
  const list = $("#crewList");
  list.innerHTML = "";
  for (const c of CREW_TYPES) {
    const hired = S.crew.includes(c.id);
    const locked = S.rep < c.repReq;
    const div = document.createElement("div");
    div.className = "card";
    const roleTag = c.role === "dealer"
      ? `<span class="pill">moves ${c.capacity}/day · ${Math.round(c.cut*100)}% cut</span>`
      : `<span class="pill good">−${c.heatCut} heat/day</span>`;
    div.innerHTML = `
      <h3>${c.name} <span class="pill">${c.role}</span></h3>
      <div class="sub">Wage ${money(c.wage)}/day · Hire ${money(c.hire)}</div>
      <div class="tags">${roleTag}</div>
      ${locked ? `<div class="locked-note">🔒 Needs ${c.repReq} reputation</div>` : ""}
      <div class="actions">
        ${hired
          ? `<button class="btn btn-danger btn-sm" data-fire="${c.id}">Let go</button>`
          : `<button class="btn btn-primary btn-sm" data-hire="${c.id}" ${locked || S.cash < c.hire ? "disabled" : ""}>Hire</button>`}
      </div>`;
    list.appendChild(div);
  }
  list.querySelectorAll("[data-hire]").forEach(b => b.onclick = () => hireCrew(b.dataset.hire));
  list.querySelectorAll("[data-fire]").forEach(b => b.onclick = () => fireCrew(b.dataset.fire));
}

function renderShop() {
  const list = $("#shopList");
  list.innerHTML = "";
  for (const u of UPGRADES) {
    const owned = !!S.upgrades[u.id];
    const reqOk = !u.req || u.req(S);
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <h3>${u.name} ${owned ? '<span class="pill good">owned</span>' : `<span class="pill gold">${money(u.cost)}</span>`}</h3>
      <div class="sub">${u.desc}</div>
      ${!reqOk ? `<div class="locked-note">🔒 Requires a prerequisite</div>` : ""}
      <div class="actions">
        ${owned
          ? `<button class="btn btn-sm" disabled>Installed</button>`
          : `<button class="btn btn-primary btn-sm" data-buy="${u.id}" ${!reqOk || S.cash < u.cost ? "disabled" : ""}>Buy</button>`}
      </div>`;
    list.appendChild(div);
  }
  list.querySelectorAll("[data-buy]").forEach(b => b.onclick = () => buyUpgrade(b.dataset.buy));
}

function renderStats() {
  const body = $("#statsBody");
  const box = (label, val) => `<div class="stat-box"><div class="big">${val}</div><div class="label">${label}</div></div>`;
  body.innerHTML =
    box("Career Earnings", money(S.totalEarned)) +
    box("Units Sold", S.totalSold.toLocaleString()) +
    box("Days Survived", S.daysSurvived) +
    box("Times Raided", S.busts) +
    box("Reputation", Math.round(S.rep)) +
    box("Crew Size", S.crew.length) +
    box("Current Strain", bestStrain().name) +
    box("Inventory", `${S.inventory}/${S.invCap}`);
}

/* ---------------------------------------------------------------------------
   Save / load / lifecycle
   --------------------------------------------------------------------------- */

function autoSave() {
  if (!S) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {}
}
function saveGame() { autoSave(); toast("Game saved.", "good"); }

function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    S = Object.assign(defaultState(), JSON.parse(raw));
    return true;
  } catch (e) { return false; }
}

function startNewGame() {
  S = defaultState();
  logBuffer = [];
  log("Welcome to the game. You've got $200 and a dream. Plant your first batch.");
  rollCustomers();
  autoSave();
  enterApp();
}

function enterApp() {
  $("#boot").classList.add("hidden");
  $("#app").classList.remove("hidden");
  render();
  renderLog();
}

function quitToMenu() {
  autoSave();
  $("#app").classList.add("hidden");
  $("#boot").classList.remove("hidden");
  refreshBootHint();
}

function refreshBootHint() {
  const has = !!localStorage.getItem(SAVE_KEY);
  $("#continueBtn").style.display = has ? "inline-block" : "none";
  $("#bootHint").textContent = has ? "Saved game found." : "No save yet — start a new game.";
}

/* ---------------------------------------------------------------------------
   Wiring
   --------------------------------------------------------------------------- */

function initTabs() {
  $$(".tab").forEach(tab => {
    tab.onclick = () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      $("#tab-" + tab.dataset.tab).classList.add("active");
    };
  });
}

function init() {
  refreshBootHint();
  initTabs();

  $("#newGameBtn").onclick = () => {
    if (localStorage.getItem(SAVE_KEY)) {
      showModal("Start fresh?", "This will erase your existing save. Continue?", [
        { label: "Cancel" },
        { label: "New Game", cls: "btn-danger", fn: startNewGame },
      ]);
    } else startNewGame();
  };
  $("#continueBtn").onclick = () => { if (loadGame()) enterApp(); };

  $("#advanceBtn").onclick = advanceDay;
  $("#saveBtn").onclick = saveGame;
  $("#menuBtn").onclick = quitToMenu;

  // keyboard: space/enter ends the day
  document.addEventListener("keydown", (e) => {
    if ($("#app").classList.contains("hidden")) return;
    if (!$("#modal").classList.contains("hidden")) return;
    if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); advanceDay(); }
  });

  window.addEventListener("beforeunload", autoSave);
}

document.addEventListener("DOMContentLoaded", init);
