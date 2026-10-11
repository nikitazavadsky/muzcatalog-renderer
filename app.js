/* Календарь конкурсов muzcatalog — рендерер.
 *
 * Получает файл базы (SQLite из collect/db_build.py) или JSON того же вида,
 * читает его прямо в браузере и рисует календарь сроков подачи заявок и дат
 * проведения. Данные никуда не отправляются: файл читается в память вкладки,
 * разобранное кладётся в localStorage этого браузера.
 *
 * Сеть нужна только за sql.js (CDN) и шрифтами.
 */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MONTHS = "январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь".split(" ");
const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const STORE = "muzcatalog.data.v1";
const THEME = "muzcatalog.theme";
const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/";
const HOT_DAYS = 14;              // «горит»: срок заявок ближе двух недель

let DATA = null;
const state = {
  place: null, own: false, deadlineOnly: false,
  months: 6, startISO: null, day: null, view: "calendar",
};

/* ----------------------------------------------------------------- даты ---- */

const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmt = s => { const d = parseISO(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fmtShort = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const todayISO = () => isoOf(new Date());
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function daysLeft(iso) {
  return Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
}

function humanDays(n) {
  if (n === 0) return "сегодня";
  if (n < 0) return `${Math.abs(n)} дн. назад`;
  const tail = (n % 10 === 1 && n % 100 !== 11) ? "день"
    : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) ? "дня" : "дней";
  return `через ${n} ${tail}`;
}

function shortName(name) {
  let s = String(name || "").replace(/["«»]/g, "");
  s = s.replace(/Учреждение образования|ГУО|УО/g, "").trim().replace(/^[-—\s]+/, "");
  s = s.replace(/государственн(ый|ая|ое)\s/gi, "");
  return s.length > 46 ? s.slice(0, 45) + "…" : s;
}

function tel(phone) {
  const digits = String(phone || "").replace(/[^+\d]/g, "");
  return digits.slice(0, 13);
}

function firstOf(value) {
  return String(value || "").split(/[;,(]/)[0].trim();
}

/* ------------------------------------------------------------ чтение базы -- */

async function loadSql() {
  if (window.__sql) return window.__sql;
  if (typeof initSqlJs !== "function") {
    throw new Error("не загрузился sql.js — нет доступа к CDN");
  }
  window.__sql = await initSqlJs({ locateFile: f => SQL_CDN + f });
  return window.__sql;
}

function rowsOf(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

async function fromDbFile(file) {
  const SQL = await loadSql();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  const places = rowsOf(db, "select * from places");
  const contests = rowsOf(db, "select * from contests");
  db.close();
  if (!places.length && !contests.length) throw new Error("в базе нет таблиц places и contests");
  return build(places, contests, { name: file.name, size: file.size });
}

async function fromJsonFile(file) {
  const raw = JSON.parse(await file.text());
  return build(raw.places || [], raw.contests || [], { name: file.name, size: file.size });
}

function build(places, contests, meta) {
  const byKp = {};
  for (const p of places) {
    const kp = Number(p.kp_id ?? p.kp);
    byKp[kp] = {
      kp, name: p.name || "", short: shortName(p.name), city: p.city || "",
      address: p.address || "", phone: p.phone || "", email: p.email || "",
      website: p.website || "", host: p.host || "", crawl: p.crawl || "",
      page: p.competitions_page || p.page || "",
    };
  }

  const events = [], seen = new Set(), all = [];
  for (const c of contests) {
    const kp = Number(c.kp_id ?? c.kp);
    const item = {
      kp, name: c.name || "", level: c.level || "", own: !!Number(c.own),
      annual: !!Number(c.annual), nonMusic: !!Number(c.non_music),
      years: c.years || "", deadlineText: c.deadline_text || "", eventText: c.event_text || "",
      nominations: c.nominations || "", prizes: c.prizes || "", contacts: c.contacts || "",
      link: c.link || "", docs: Number(c.docs_count || 0), lastSeen: c.last_seen || "",
    };
    if (!item.nonMusic) all.push(item);

    for (const [field, kind] of [["deadline_date", "deadline"], ["event_date", "event"]]) {
      const d = c[field];
      if (!d) continue;
      // У БГАМ две карточки (академия и филиал) на один сайт — событие одно.
      const key = `${d}|${kind}|${item.name.toLowerCase().slice(0, 50)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(Object.assign({ id: events.length, date: d, kind,
        other: kind === "deadline" ? c.event_date : c.deadline_date }, item));
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  events.forEach((e, i) => { e.id = i; });

  return {
    places: Object.values(byKp).sort((a, b) => a.short.localeCompare(b.short)),
    byKp, events, contests: all,
    meta: Object.assign({}, meta, {
      loaded: new Date().toISOString().slice(0, 16).replace("T", " "),
    }),
  };
}

/* -------------------------------------------------------------- хранилище -- */

function remember(data) {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      places: data.places, byKp: data.byKp, events: data.events,
      contests: data.contests, meta: data.meta,
    }));
  } catch (e) { /* приватный режим или не влезло — не страшно */ }
}

function recall() {
  try { const raw = localStorage.getItem(STORE); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}

/* ------------------------------------------------------------- окно дат ---- */

function windowRange() {
  const dates = DATA.events.map(e => e.date).sort();
  if (!dates.length) return { start: todayISO().slice(0, 7), months: 1 };
  if (state.months === 0) {
    const first = dates[0].slice(0, 7), last = dates[dates.length - 1].slice(0, 7);
    const [y1, m1] = first.split("-").map(Number), [y2, m2] = last.split("-").map(Number);
    return { start: first, months: Math.min((y2 - y1) * 12 + (m2 - m1) + 1, 60) };
  }
  return { start: state.startISO || todayISO().slice(0, 7), months: state.months };
}

function inWindow(iso) {
  const { start, months } = windowRange();
  const [y, m] = start.split("-").map(Number);
  const d = parseISO(iso);
  return d >= new Date(y, m - 1, 1) && d <= new Date(y, m - 1 + months, 0);
}

function visible() {
  return DATA.events.filter(e =>
    (!state.place || e.kp === state.place) &&
    (!state.own || e.own) &&
    (!state.deadlineOnly || e.kind === "deadline") &&
    inWindow(e.date));
}

/* ----------------------------------------------------------------- вид ----- */

function drawPlaces() {
  const q = ($("#q").value || "").toLowerCase();
  const counts = {};
  for (const e of DATA.events) if (inWindow(e.date)) counts[e.kp] = (counts[e.kp] || 0) + 1;
  const list = DATA.places
    .filter(p => !q || `${p.name} ${p.city}`.toLowerCase().includes(q))
    .sort((a, b) => (counts[b.kp] || 0) - (counts[a.kp] || 0) || a.short.localeCompare(b.short));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  $("#places").innerHTML =
    `<button type="button" class="place ${state.place ? "" : "on"}" data-kp="">
       <span>Все заведения</span><span class="n">${total}</span></button>` +
    list.map(p => `<button type="button" class="place ${state.place === p.kp ? "on" : ""}" data-kp="${p.kp}">
       <span>${esc(p.short)}</span><span class="n">${counts[p.kp] || 0}</span></button>`).join("");

  $$("#places .place").forEach(el => el.onclick = () => {
    const kp = el.dataset.kp;
    state.place = kp ? Number(kp) : null;
    state.view = kp ? "place" : "calendar";
    state.day = null;
    draw();
  });
}

function drawMonths() {
  const { start, months } = windowRange();
  const byDay = {};
  for (const e of visible()) (byDay[e.date] = byDay[e.date] || []).push(e);
  const today = todayISO();
  let [y, m] = start.split("-").map(Number);
  let html = "";

  for (let i = 0; i < months; i++) {
    html += `<section class="month"><header><h3>${MONTHS[m - 1]}</h3><span class="y">${y}</span></header>` +
      `<div class="cal">` + WEEKDAYS.map(w => `<div class="wd">${w}</div>`).join("");
    const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const total = new Date(y, m, 0).getDate();
    for (let k = 0; k < firstDow; k++) html += `<div></div>`;
    for (let day = 1; day <= total; day++) {
      const ds = `${y}-${pad(m)}-${pad(day)}`;
      const list = byDay[ds] || [];
      const kinds = [...new Set(list.map(e => e.kind))].sort();
      const cls = ["day", kinds.length ? "has" : "", ds === today ? "today" : "",
                   state.day === ds ? "sel" : ""].filter(Boolean).join(" ");
      const marks = `<span class="marks">` +
        kinds.map(k => `<i class="${k === "deadline" ? "d" : "e"}"></i>`).join("") + `</span>`;
      html += kinds.length
        ? `<button type="button" class="${cls}" data-day="${ds}" aria-label="${fmt(ds)}, событий: ${list.length}"><span class="num">${day}</span>${marks}</button>`
        : `<div class="${cls}"><span class="num">${day}</span>${marks}</div>`;
    }
    html += `</div></section>`;
    if (++m > 12) { m = 1; y++; }
  }
  $("#months").innerHTML = html;
  $$("#months .day[data-day]").forEach(el => el.onclick = () => {
    state.day = state.day === el.dataset.day ? null : el.dataset.day;
    draw();
  });
}

function eventItem(e) {
  const p = DATA.byKp[e.kp] || {};
  const left = daysLeft(e.date);
  const hot = e.kind === "deadline" && left >= 0 && left <= HOT_DAYS ? " hot" : "";
  return `<button type="button" class="item ${e.kind}${hot}" data-id="${e.id}">
    <span class="date"><b>${fmtShort(e.date)}</b><small>${humanDays(left)}</small></span>
    <span class="body">
      <span class="kind">${e.kind === "deadline" ? "Заявки до" : "Проведение"}</span>
      <span class="name">${esc(e.name)}</span>
      <span class="meta">${esc(p.short || "")}${p.city ? " · " + esc(p.city) : ""}</span>
    </span>
    ${e.own ? '<span class="own-badge">свой</span>' : ""}
  </button>`;
}

function drawList() {
  let ev = visible(), title;
  if (state.day) {
    ev = ev.filter(e => e.date === state.day);
    title = `События ${fmt(state.day)}`;
  } else {
    const ahead = ev.filter(e => e.date >= todayISO());
    ev = (ahead.length ? ahead : ev.slice(-30)).slice(0, 80);
    title = ahead.length ? "Ближайшее" : "В выбранном периоде";
  }
  $("#list").innerHTML =
    `<div class="list-head"><h2>${title}</h2>` +
    (state.day ? '<button type="button" class="back" id="allday">← ко всем ближайшим</button>' : "") +
    `</div>` +
    (ev.length ? ev.map(eventItem).join("")
               : '<p class="empty">Ничего нет — смените период или снимите фильтры</p>');

  $$("#list .item").forEach(el => el.onclick = () =>
    showEvent(DATA.events.find(e => e.id === Number(el.dataset.id))));
  if ($("#allday")) $("#allday").onclick = () => { state.day = null; draw(); };
}

const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";

function callButtons(p) {
  return (p.phone ? `<a class="btn primary" href="tel:${esc(tel(p.phone))}">${esc(firstOf(p.phone))}</a>` : "") +
         (p.email ? `<a class="btn ghost" href="mailto:${esc(firstOf(p.email))}">${esc(firstOf(p.email))}</a>` : "");
}

function showEvent(e) {
  if (!e) return;
  const p = DATA.byKp[e.kp] || {};
  const left = daysLeft(e.date);
  const hot = e.kind === "deadline" && left >= 0 && left <= HOT_DAYS;
  $("#detail").innerHTML = `
    <div class="list-head"><span class="cap">Событие</span>
      ${e.own ? '<span class="own-badge" style="margin-left:auto">свой конкурс</span>' : ""}</div>
    <h2 class="title">${esc(e.name)}</h2>
    <p class="note">${esc([e.level, e.years].filter(Boolean).join(" · "))}</p>
    ${hot ? `<div class="urgent">
      <div class="cap">Заявки до</div>
      <div class="big"><b>${fmt(e.date)}</b><span>${humanDays(left)}</span></div>
    </div>` : ""}
    <dl class="kv">
      ${hot ? "" : row(e.kind === "deadline" ? "Заявки до" : "Проведение", `${fmt(e.date)} · ${humanDays(left)}`)}
      ${row(e.kind === "deadline" ? "Проведение" : "Заявки до", e.other ? fmt(e.other) : "")}
      ${row("Номинации", esc(e.nominations))}
      ${row("Награды", esc(e.prizes))}
      ${row("Документов", e.docs || "")}
      ${row("Источник", e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">страница конкурса</a>` : "")}
    </dl>
    <div class="calls">
      <span class="cap">Кому звонить</span>
      <button type="button" class="back place-link" data-kp="${e.kp}">${esc(p.name || "")}</button>
      ${e.contacts ? `<p class="sub" style="margin:0 0 4px">${esc(e.contacts)}</p>` : ""}
      ${callButtons(p)}
    </div>`;
  const back = $("#detail .place-link");
  if (back) back.onclick = () => {
    state.place = Number(back.dataset.kp); state.view = "place"; state.day = null; draw();
  };
}

function drawPlacePage() {
  const p = DATA.byKp[state.place];
  if (!p) return;
  const ev = DATA.events.filter(e => e.kp === p.kp);
  const all = DATA.contests.filter(c => c.kp === p.kp);
  const own = all.filter(c => c.own);
  const docs = all.reduce((s, c) => s + (c.docs || 0), 0);

  $("#detail").innerHTML = `
    <button type="button" class="back" id="toall">← все заведения</button>
    <h2 class="title">${esc(p.short)}</h2>
    <p class="note">${esc([p.city, p.address].filter(Boolean).join(" · "))}</p>
    <div class="stats">
      <div><b>${all.length}</b><small>конкурсов</small></div>
      <div class="own-stat"><b>${own.length}</b><small>своих</small></div>
      <div><b>${docs}</b><small>документов</small></div>
    </div>
    <div class="calls" style="border:0;padding:0;margin-bottom:14px">${callButtons(p)}</div>
    <dl class="kv">
      ${row("Полное название", esc(p.name))}
      ${row("Сайт", p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.host)}</a>` : "")}
      ${row("Раздел конкурсов", p.page ? `<a href="${esc(p.page)}" target="_blank" rel="noopener">страница</a>` : "")}
      ${row("Как собираем", esc(p.crawl))}
      ${row("Событий с датами", ev.length)}
    </dl>
    <div class="list-head" style="margin-top:14px"><h2>Конкурсы заведения</h2></div>
    ${all.length ? all.slice(0, 100).map(c => `<div class="item flat ${c.own ? "event" : ""}">
        <span class="body">
          <span class="name">${esc(c.name)}</span>
          <span class="meta">${esc([c.years, c.deadlineText && "заявки: " + c.deadlineText,
            c.eventText && "проведение: " + c.eventText].filter(Boolean).join(" · "))}</span>
        </span>
        ${c.own ? '<span class="own-badge">свой</span>' : ""}
      </div>`).join("") : '<p class="empty">Конкурсов пока не нашлось</p>'}`;
  $("#toall").onclick = () => { state.place = null; state.view = "calendar"; state.day = null; draw(); };
}

function draw() {
  const { start, months } = windowRange();
  drawPlaces();
  drawMonths();
  drawList();

  if (state.view === "place" && state.place) drawPlacePage();
  else if (!$("#detail").innerHTML.trim()) {
    $("#detail").innerHTML =
      '<div class="list-head"><span class="cap">Подробности</span></div>' +
      '<p class="empty">Выберите событие в списке или день в календаре.</p>';
  }

  const place = state.place ? DATA.byKp[state.place] : null;
  $("#title").textContent = place ? place.short : "Календарь конкурсов";
  $("#count").textContent = `${DATA.places.length} заведений · ${DATA.events.length} событий`;
  $("#legend").innerHTML =
    `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)} + ${months} мес. · ` +
    `показано ${visible().length} · ` +
    `<span class="key d"><i></i>срок заявок</span> <span class="key e"><i></i>проведение</span>`;
  $("#chip-own").classList.toggle("on-own", state.own);
  $("#chip-own").setAttribute("aria-pressed", String(state.own));
  $("#chip-dl").classList.toggle("on-deadline", state.deadlineOnly);
  $("#chip-dl").setAttribute("aria-pressed", String(state.deadlineOnly));
  $$("#period button").forEach(b => b.classList.toggle("on", Number(b.dataset.months) === state.months));
  $("#dbinfo").textContent = `${DATA.meta.name} · загружено ${DATA.meta.loaded}`;
}

/* ---------------------------------------------------------------- запуск --- */

function shiftStart(delta) {
  const { start } = windowRange();
  let [y, m] = start.split("-").map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  state.startISO = `${y}-${pad(m)}`;
}

function start(data) {
  DATA = data;
  state.startISO = state.startISO || todayISO().slice(0, 7);
  $("#import").hidden = true;
  $("#app").hidden = false;
  draw();
}

function setStatus(text, isError) {
  const el = $("#status");
  el.hidden = !text;
  el.innerHTML = text ? (isError ? esc(text) : `${esc(text)}<span class="bar"><i></i></span>`) : "";
  el.classList.toggle("err", !!isError);
}

async function openFile(file) {
  if (!file) return;
  setStatus(`Читаю ${file.name}…`, false);
  try {
    const data = /\.json$/i.test(file.name) ? await fromJsonFile(file) : await fromDbFile(file);
    remember(data);
    setStatus("", false);
    start(data);
  } catch (err) {
    console.error(err);
    setStatus("Не получилось прочитать файл: " + err.message, true);
  }
}

/* Каталог на сайте не лежит: его открывает сам пользователь. Исключение —
   явный адрес в ?db=…, когда базу раздают откуда-то ещё. */
async function autoload() {
  const url = new URLSearchParams(location.search).get("db");
  if (!url) return false;
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) return false;
    const blob = await res.blob();
    const name = url.split("/").pop();
    setStatus(`Открываю ${name}…`, false);
    await openFile(new File([blob], name));
    return true;
  } catch (e) {
    return false;                      // файла нет — остаётся экран импорта
  }
}

/* тема: системная по умолчанию, выбор запоминается */
function applyTheme(mode) {
  if (mode) document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
}
try { applyTheme(localStorage.getItem(THEME)); } catch (e) { /* нет доступа к хранилищу */ }
$("#theme").onclick = () => {
  const now = document.documentElement.getAttribute("data-theme");
  const next = now === "dark" ? "light" : now === "light" ? null : "dark";
  applyTheme(next);
  try { next ? localStorage.setItem(THEME, next) : localStorage.removeItem(THEME); }
  catch (e) { /* нет доступа к хранилищу */ }
};

/* экран импорта */
$("#file").onchange = e => openFile(e.target.files[0]);
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add("over");
}));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove("over");
}));
drop.addEventListener("drop", e => openFile(e.dataTransfer.files[0]));

const saved = recall();
if (saved && saved.events) {
  $("#recall").hidden = false;
  $("#recall-info").textContent = `${saved.meta.name} · ${saved.events.length} событий · ${saved.meta.loaded}`;
  $("#reopen").onclick = () => start(saved);
}

/* рабочий экран */
$("#q").oninput = drawPlaces;
$("#chip-own").onclick = () => { state.own = !state.own; draw(); };
$("#chip-dl").onclick = () => { state.deadlineOnly = !state.deadlineOnly; draw(); };
$$("#period button").forEach(b => b.onclick = () => {
  state.months = Number(b.dataset.months);
  state.startISO = todayISO().slice(0, 7);
  draw();
});
$("#prev").onclick = () => { shiftStart(-(state.months || 12)); draw(); };
$("#next").onclick = () => { shiftStart(state.months || 12); draw(); };
$("#today").onclick = () => { state.startISO = todayISO().slice(0, 7); state.day = null; draw(); };
$("#switch-db").onclick = () => {
  $("#app").hidden = true;
  $("#import").hidden = false;
  setStatus("", false);
};

autoload();
