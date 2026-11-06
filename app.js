// Aquecimento de hoje — controle diário de aquecimento de contas.
// Tempo calculado por timestamps: { ms: tempo acumulado, start: início da rodada atual (ou null) }.
import { CONFIG } from './config.js';

const GOAL = 30 * 60 * 1000;               // meta por conta: 30 min
const ACCOUNTS = [
  { key: 'ig', label: 'Instagram' },
  { key: 'tt', label: 'TikTok' },
];
// Apps iniciais — troque pelos seus (também dá para renomear tocando no nome).
const DEFAULT_APPS = ['App 1', 'App 2', 'App 3', 'App 4'];
const HISTORY_DAYS = 30;

const ICONS = {
  ig: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="igg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f9a825"/><stop offset=".5" stop-color="#e8338a"/><stop offset="1" stop-color="#6a3cf0"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#igg)"/><circle cx="12" cy="12" r="4.3" fill="none" stroke="#fff" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.3" fill="#fff"/></svg>',
  tt: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="#111"/><path d="M14.6 5.5c.4 1.7 1.6 2.9 3.4 3.1v2.4c-1.3 0-2.4-.4-3.4-1.1v4.9a4.3 4.3 0 1 1-4.3-4.3h.5v2.5h-.5a1.8 1.8 0 1 0 1.8 1.8V5.5z" fill="#fff"/><path d="M14.6 5.5c.4 1.7 1.6 2.9 3.4 3.1" fill="none" stroke="#25f4ee" stroke-width=".8" opacity=".9"/></svg>',
};

/* ================= Utilidades ================= */
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDay(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); }
function endOfDay(k) { return parseDay(addDays(k, 1)).getTime(); }
function daysBetween(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); }
function shortDate(k) { return parseDay(k).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }); }
function longDate(k) { return parseDay(k).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); }

function fmtMin(totalMin) {
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h${pad(m)}`;
}
function fmtClock(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/* ================= Modelo ================= */
const emptyAcc = () => ({ ms: 0, start: null, marked: false, u: 0 });
const newDay = (day) => ({ day, accounts: {}, apps: [] });

/** Tempo aquecido de uma conta (limitado a 30 min). `until` limita o relógio (fim do dia, no histórico). */
function elapsed(acc, until = Date.now()) {
  if (!acc) return 0;
  const run = acc.start ? Math.max(0, until - acc.start) : 0;
  return Math.min(GOAL, (acc.ms || 0) + run);
}
const isDone = (acc, until) => elapsed(acc, until) >= GOAL;

function getAcc(row, appId, key) { return row.accounts?.[appId]?.[key] || null; }
function ensureAcc(appId, key) {
  const a = (S.today.accounts[appId] ||= {});
  return (a[key] ||= emptyAcc());
}
function forEachAcc(row, fn) {
  for (const appId of Object.keys(row.accounts || {})) {
    for (const key of Object.keys(row.accounts[appId] || {})) fn(row.accounts[appId][key], appId, key);
  }
}
function hasActivity(row) {
  let any = false;
  forEachAcc(row, (a) => { if ((a.ms || 0) > 0 || a.start || a.marked) any = true; });
  return any;
}
/** Linha de um dia que já passou: timers que ficaram rodando param à meia-noite. */
function normalizePast(row) {
  const r = { day: row.day, apps: row.apps || [], accounts: clone(row.accounts || {}) };
  const end = endOfDay(r.day);
  forEachAcc(r, (a) => { if (a.start) { a.ms = elapsed(a, end); a.start = null; } });
  return r;
}

/* ================= Estado ================= */
const MODE = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY ? 'cloud' : 'local';
let sb = null;            // cliente Supabase
let channel = null;       // canal de tempo real
const S = {
  user: null,
  profile: { apps: [], first_day: null, updated_at: 0 },
  today: newDay(dayKey()),
  history: {},            // day -> { day, apps, accounts }
};
let profileDirty = false;
const pendingDays = new Set();
let syncState = '';

const cacheKey = () => `aquecimento:v1:${S.user?.id || 'local'}`;

function saveCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({
      profile: S.profile, today: S.today, history: S.history,
      profileDirty, pendingDays: [...pendingDays],
    }));
  } catch { /* armazenamento indisponível */ }
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
    if (!c) return false;
    S.profile = c.profile || S.profile;
    S.today = c.today || S.today;
    S.history = c.history || {};
    profileDirty = !!c.profileDirty;
    (c.pendingDays || []).forEach((d) => pendingDays.add(d));
    return true;
  } catch { return false; }
}
function defaultProfile() {
  return {
    apps: DEFAULT_APPS.map((name) => ({ id: newId(), name })),
    first_day: dayKey(),
    updated_at: Date.now(),
  };
}

/* ================= Sincronização ================= */
function setSync(state) {
  syncState = state;
  const el = $('#sync');
  const text = {
    ok: 'Sincronizado ✓',
    saving: 'Sincronizando…',
    offline: 'Sem internet · salvo no aparelho',
    error: 'Erro ao sincronizar · tentando de novo',
    local: 'Salvo neste aparelho',
    '': '',
  }[state];
  el.textContent = text;
  el.className = `sync ${state}`;
}

function touchProfile() {
  S.profile.updated_at = Date.now();
  profileDirty = true;
  pendingDays.add(S.today.day); // retrato dos apps do dia acompanha o perfil
  scheduleFlush();
}
function touchProfileFirstDay(day) {
  S.profile.first_day = day;
  S.profile.updated_at = Date.now();
  profileDirty = true;
}
function touchToday() {
  pendingDays.add(S.today.day);
  scheduleFlush();
}

let flushTimer = null, flushing = false, flushAgain = false, retryTimer = null;
function scheduleFlush(delay = 350) {
  saveCache();
  if (MODE === 'local') { setSync('local'); return; }
  if (syncState !== 'offline') setSync('saving');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

function rowFor(day) {
  if (day === S.today.day) return { day, apps: S.profile.apps.map(({ id, name }) => ({ id, name })), accounts: S.today.accounts };
  const h = S.history[day];
  return h ? { day, apps: h.apps, accounts: h.accounts } : null;
}

async function flush() {
  if (MODE !== 'cloud' || !S.user) return;
  if (flushing) { flushAgain = true; return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  flushing = true;
  const days = [...pendingDays];
  const doProfile = profileDirty;
  pendingDays.clear();
  profileDirty = false;
  try {
    setSync('saving');
    if (doProfile) {
      const { error } = await sb.from('profiles').upsert({
        user_id: S.user.id,
        apps: S.profile.apps,
        first_day: S.profile.first_day,
        updated_at: new Date(S.profile.updated_at).toISOString(),
      });
      if (error) throw error;
    }
    const rows = days.map(rowFor).filter(Boolean).map((r) => ({
      user_id: S.user.id, day: r.day, apps: r.apps, accounts: r.accounts, updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      const { error } = await sb.from('days').upsert(rows);
      if (error) throw error;
    }
    saveCache();
    if (!pendingDays.size && !profileDirty) setSync('ok');
  } catch (err) {
    console.warn('Falha ao sincronizar', err);
    days.forEach((d) => pendingDays.add(d));
    if (doProfile) profileDirty = true;
    saveCache();
    setSync(navigator.onLine ? 'error' : 'offline');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flush, 5000);
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; flush(); }
  }
}

/** Junta contas vindas de outro aparelho: vale a alteração mais recente de cada conta. */
function mergeAccounts(target, remote) {
  let changed = false;
  for (const appId of Object.keys(remote || {})) {
    for (const key of Object.keys(remote[appId] || {})) {
      const r = remote[appId][key];
      const l = target.accounts[appId]?.[key];
      if (!l || (r.u || 0) > (l.u || 0)) {
        (target.accounts[appId] ||= {})[key] = r;
        changed = true;
      }
    }
  }
  return changed;
}

/** Garante que só um timer roda por vez (mantém o mais recente). */
function enforceSingleRunning() {
  const running = [];
  forEachAcc(S.today, (a) => { if (a.start) running.push(a); });
  if (running.length < 2) return false;
  running.sort((x, y) => (y.u || 0) - (x.u || 0));
  const now = Date.now();
  running.slice(1).forEach((a) => { a.ms = elapsed(a, now); a.start = null; a.u = now; });
  return true;
}

function applyRemoteProfile(p) {
  const remoteAt = Date.parse(p.updated_at) || 0;
  if (profileDirty && remoteAt <= S.profile.updated_at) return false;
  if (remoteAt <= S.profile.updated_at && S.profile.apps.length) return false;
  S.profile = { apps: p.apps || [], first_day: p.first_day || S.profile.first_day, updated_at: remoteAt };
  return true;
}

function applyRemoteDay(row) {
  if (row.day === S.today.day) {
    const changed = mergeAccounts(S.today, row.accounts);
    if (changed && enforceSingleRunning()) touchToday();
    return changed;
  }
  if (row.day > S.today.day) return false;
  const past = normalizePast(row);
  if (S.history[row.day]) mergeAccounts(S.history[row.day], past.accounts);
  else S.history[row.day] = past;
  return true;
}

async function loadCloud() {
  if (!navigator.onLine) { setSync('offline'); return; }
  setSync('saving');
  try {
    const { data: p, error: e1 } = await sb.from('profiles').select('*').eq('user_id', S.user.id).maybeSingle();
    if (e1) throw e1;
    if (p) applyRemoteProfile(p);
    else if (!S.profile.apps.length) { S.profile = defaultProfile(); profileDirty = true; }
    else profileDirty = true;

    const since = addDays(dayKey(), -(HISTORY_DAYS - 1));
    const { data: rows, error: e2 } = await sb.from('days').select('*')
      .eq('user_id', S.user.id).gte('day', since).order('day', { ascending: false });
    if (e2) throw e2;
    (rows || []).forEach(applyRemoteDay);

    // "Dia 1" = primeiro dia de uso
    const { data: first } = await sb.from('days').select('day').eq('user_id', S.user.id)
      .order('day', { ascending: true }).limit(1);
    const firstDay = first?.[0]?.day;
    if (firstDay && (!S.profile.first_day || firstDay < S.profile.first_day)) {
      S.profile.first_day = firstDay; profileDirty = true;
    }
    if (!S.profile.first_day) { S.profile.first_day = dayKey(); profileDirty = true; }

    pruneHistory();
    saveCache();
    render();
    if (profileDirty || pendingDays.size) await flush(); else setSync('ok');
  } catch (err) {
    console.warn('Falha ao carregar', err);
    setSync(navigator.onLine ? 'error' : 'offline');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(loadCloud, 8000);
  }
}

function subscribeRealtime() {
  if (channel) sb.removeChannel(channel);
  const uid = S.user.id;
  channel = sb.channel(`sync-${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'days', filter: `user_id=eq.${uid}` }, (msg) => {
      if (msg.new?.day && applyRemoteDay(msg.new)) { saveCache(); render(); }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `user_id=eq.${uid}` }, (msg) => {
      if (msg.new && applyRemoteProfile(msg.new)) { saveCache(); render(); }
    })
    .subscribe();
}

function pruneHistory() {
  const since = addDays(dayKey(), -(HISTORY_DAYS - 1));
  for (const d of Object.keys(S.history)) if (d < since) delete S.history[d];
}

/* ================= Virada do dia ================= */
function rollover() {
  const old = S.today;
  const end = endOfDay(old.day);
  const now = Date.now();
  forEachAcc(old, (a) => { if (a.start) { a.ms = elapsed(a, end); a.start = null; a.u = now; } });
  if (hasActivity(old)) {
    S.history[old.day] = { day: old.day, apps: S.profile.apps.map(({ id, name }) => ({ id, name })), accounts: old.accounts };
    pendingDays.add(old.day);
    if (!S.profile.first_day || old.day < S.profile.first_day) touchProfileFirstDay(old.day);
  }
  pendingDays.delete(S.today.day);
  S.today = newDay(dayKey());
  pruneHistory();
  scheduleFlush(0);
  render();
  if (MODE === 'cloud' && S.user) loadCloud();
}

/* ================= Ações ================= */
function pauseAcc(a, now = Date.now()) { a.ms = elapsed(a, now); a.start = null; a.u = now; }

const actions = {
  start(appId, key) {
    unlockAudio();
    const now = Date.now();
    forEachAcc(S.today, (o) => { if (o.start) pauseAcc(o, now); }); // só um timer por vez
    const a = ensureAcc(appId, key);
    if (elapsed(a, now) >= GOAL) return;
    a.start = now; a.u = now;
  },
  pause(appId, key) { pauseAcc(ensureAcc(appId, key)); },
  reset(appId, key) {
    const a = ensureAcc(appId, key);
    Object.assign(a, { ms: 0, start: null, marked: false, u: Date.now() });
  },
  full(appId, key) {
    const a = ensureAcc(appId, key);
    Object.assign(a, { ms: GOAL, start: null, u: Date.now() });
  },
  addMinutes(appId, key) {
    const input = document.getElementById(`min-${appId}-${key}`);
    const n = Math.floor(Number(String(input?.value || '').replace(',', '.')));
    if (!n || n <= 0) { input?.focus(); return false; }
    const a = ensureAcc(appId, key);
    const now = Date.now();
    const running = !!a.start;
    a.ms = Math.min(GOAL, elapsed(a, now) + n * 60000);
    a.start = running && a.ms < GOAL ? now : null;
    a.u = now;
    input.value = '';
  },
  mark(appId, key) {
    const a = ensureAcc(appId, key);
    a.marked = !a.marked; a.u = Date.now();
  },
};

/* ================= Som, vibração e tela acesa ================= */
let actx = null;
function unlockAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { /* sem áudio */ }
}
function alarm() {
  try { navigator.vibrate?.([400, 150, 400, 150, 700]); } catch { /* */ }
  if (!actx) return;
  const t0 = actx.currentTime + 0.05;
  [[0, 880], [0.32, 880], [0.64, 1320], [1.2, 880], [1.52, 880], [1.84, 1320]].forEach(([dt, f]) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.28);
    o.connect(g).connect(actx.destination);
    o.start(t0 + dt); o.stop(t0 + dt + 0.3);
  });
}

let wakeLock = null, wakeBusy = false;
async function updateWakeLock(want) {
  if (!('wakeLock' in navigator) || wakeBusy) return;
  wakeBusy = true;
  try {
    if (want && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release(); wakeLock = null;
    }
  } catch { /* o navegador recusou */ }
  wakeBusy = false;
}

/* ================= Interface ================= */
let editingApp = null;       // app com o nome em edição
let confirmRemove = null;    // app aguardando o segundo toque para remover
let confirmTimer = null;
let rendering = false;

function setHTML(el, html) { if (el._html !== html) { el.innerHTML = html; el._html = html; } }

function accView(appId, key, now) {
  const a = getAcc(S.today, appId, key);
  const e = elapsed(a, now);
  const done = e >= GOAL;
  const running = !!a?.start && !done;
  const state = done ? 'done' : running ? 'running' : e > 0 ? 'paused' : 'idle';
  return { a, e, done, running, state };
}

function accHTML(app, acc, now) {
  const v = accView(app.id, acc.key, now);
  const id = `${app.id}|${acc.key}`;
  const stateLabel = { idle: 'Não iniciado', running: 'Rodando', paused: 'Pausado', done: 'Completa' }[v.state];
  let buttons = '';
  if (v.state === 'idle') buttons = `<button class="btn primary grow2" data-act="start" data-id="${id}">▶ Iniciar</button>`;
  else if (v.state === 'running') buttons = `<button class="btn pink grow2" data-act="pause" data-id="${id}">❚❚ Pausar</button><button class="btn outline" data-act="reset" data-id="${id}">Zerar</button>`;
  else if (v.state === 'paused') buttons = `<button class="btn primary grow2" data-act="start" data-id="${id}">▶ Continuar</button><button class="btn outline" data-act="reset" data-id="${id}">Zerar</button>`;
  else {
    const marked = !!v.a?.marked;
    buttons = `<button class="btn ${marked ? 'done' : 'primary'} grow2" data-act="mark" data-id="${id}" aria-pressed="${marked}">${marked ? '✔ Feito' : '☐ Marcar como feito'}</button><button class="btn outline" data-act="reset" data-id="${id}">Zerar</button>`;
  }
  const quick = v.done ? '' : `
    <div class="quick">
      <button class="btn small" data-act="full" data-id="${id}">✓ Já aqueci os 30 min</button>
      <div class="add-min">
        <input id="min-${app.id}-${acc.key}" type="number" inputmode="numeric" min="1" max="30" step="1" placeholder="min" aria-label="Minutos já aquecidos no ${acc.label}" data-enter="addMinutes" data-id="${id}">
        <button class="btn small" data-act="addMinutes" data-id="${id}">+ Adicionar minutos</button>
      </div>
    </div>`;
  return `
    <div class="acc ${v.state}" data-acc="${id}">
      <div class="acc-top">
        <span class="acc-name">${ICONS[acc.key]}${acc.label}</span>
        <span class="acc-state" data-state>${stateLabel}</span>
      </div>
      <div class="timer" data-timer>${v.done ? 'Feita ✓' : fmtClock(GOAL - v.e)}</div>
      <div class="bar thin" role="progressbar" aria-label="Progresso ${acc.label}" aria-valuemin="0" aria-valuemax="30" aria-valuenow="${Math.floor(v.e / 60000)}"><i data-bar style="width:${(v.e / GOAL) * 100}%"></i></div>
      <div class="row">${buttons}</div>
      ${quick}
    </div>`;
}

function appDoneCount(row, appId, until) {
  return ACCOUNTS.filter((acc) => isDone(getAcc(row, appId, acc.key), until)).length;
}

function renderApps(now = Date.now()) {
  const el = $('#apps');
  // preserva o que está sendo digitado
  const keep = {};
  el.querySelectorAll('input').forEach((i) => { keep[i.id] = i.value; });
  const focusedId = document.activeElement?.id;

  const html = S.profile.apps.map((app) => {
    const n = appDoneCount(S.today, app.id, now);
    const complete = n === ACCOUNTS.length;
    const nameHTML = editingApp === app.id
      ? `<input class="app-name-input" id="name-${app.id}" type="text" value="${esc(app.name)}" maxlength="40" aria-label="Nome do app" data-name="${app.id}">`
      : `<button class="app-name" data-act="rename" data-app="${app.id}" title="Tocar para renomear">${esc(app.name)}<span class="pen">✎</span></button>`;
    const confirming = confirmRemove === app.id;
    return `
      <article class="card app ${complete ? 'complete' : ''}">
        <div class="app-head">
          ${nameHTML}
          <span class="pill ${complete ? 'ok' : ''}" data-pill="${app.id}">${complete ? 'App completo' : `${n} de ${ACCOUNTS.length} contas`}</span>
        </div>
        <div class="accounts">${ACCOUNTS.map((acc) => accHTML(app, acc, now)).join('')}</div>
        <div class="app-foot">
          <button class="btn small ${confirming ? 'remove confirm' : 'ghost remove'}" data-act="remove" data-app="${app.id}">${confirming ? 'Toque de novo para remover' : 'Remover app'}</button>
        </div>
      </article>`;
  }).join('') || '<p class="card empty">Nenhum app ainda. Adicione o primeiro abaixo.</p>';

  rendering = true;
  setHTML(el, html);
  el.querySelectorAll('input').forEach((i) => { if (i.id in keep && !i.dataset.name) i.value = keep[i.id]; });
  if (editingApp) {
    const inp = document.getElementById(`name-${editingApp}`);
    if (inp && focusedId !== inp.id) { inp.focus(); inp.select(); }
    else if (inp && keep[inp.id] !== undefined) inp.value = keep[inp.id];
  } else if (focusedId) {
    document.getElementById(focusedId)?.focus();
  }
  rendering = false;
}

function totals(now = Date.now()) {
  let done = 0, ms = 0;
  const total = S.profile.apps.length * ACCOUNTS.length;
  for (const app of S.profile.apps) {
    for (const acc of ACCOUNTS) {
      const e = elapsed(getAcc(S.today, app.id, acc.key), now);
      ms += e;
      if (e >= GOAL) done++;
    }
  }
  return { done, total, ms };
}

function renderSummary(now = Date.now()) {
  const { done, total, ms } = totals(now);
  const totalMin = total * 30;
  const doneMin = Math.floor(ms / 60000);
  const left = totalMin - doneMin;
  const pct = total ? (ms / (total * GOAL)) * 100 : 0;
  const allDone = total > 0 && done === total;
  const sumEl = $('#summary');
  sumEl.classList.toggle('all-done', allDone);
  setHTML(sumEl, `
    <div class="sum-line">
      <span class="sum-big">${done}</span><span class="sum-of">de ${total} contas</span>
      <span class="sum-label">aquecidas hoje</span>
    </div>
    <div class="bar" role="progressbar" aria-label="Progresso total" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><i style="width:${pct}%;${allDone ? 'background:var(--green)' : ''}"></i></div>
    <p class="sum-time">${total
      ? `<b>${fmtMin(doneMin)}</b> de ${fmtMin(totalMin)} aquecidos · ${left > 0 ? `faltam <b>${fmtMin(left)}</b>` : '<b>tudo aquecido! 🎉</b>'}`
      : 'Adicione um app para começar.'}</p>`);
}

function historyCard(row, live, now) {
  const until = live ? now : endOfDay(row.day);
  const first = S.profile.first_day && S.profile.first_day <= row.day ? S.profile.first_day : row.day;
  const n = daysBetween(first, row.day) + 1;
  const apps = row.apps || [];
  let appsDone = 0;
  const items = apps.map((app) => {
    const parts = ACCOUNTS.map((acc) => {
      const e = elapsed(getAcc(row, app.id, acc.key), until);
      const miss = Math.ceil((GOAL - e) / 60000);
      return e >= GOAL ? `${acc.label} completo` : `${acc.label} ${live ? 'faltam' : 'faltou'} ${miss} min`;
    });
    const ok = appDoneCount(row, app.id, until) === ACCOUNTS.length;
    if (ok) appsDone++;
    return `<li><span class="hname">${esc(app.name)}</span>${ok
      ? '<span class="hstat ok">✔ Feito</span>'
      : `<span class="hstat no">Incompleto</span><span class="hdetail">${parts.join(' · ')}</span>`}</li>`;
  }).join('');
  const allOk = apps.length > 0 && appsDone === apps.length;
  const tag = live ? '<span class="tag live">Em andamento</span>' : allOk ? '<span class="tag ok">Completo</span>' : '';
  return `
    <article class="card hcard ${live ? 'live' : allOk ? 'done' : ''}">
      <div class="hcard-head"><h3>Dia ${n} · ${shortDate(row.day)}</h3>${tag}</div>
      <p class="hsum">${appsDone} de ${apps.length} apps feitos</p>
      <ul class="hlist">${items || '<li class="empty">Nenhum app</li>'}</ul>
    </article>`;
}

function renderHistory(now = Date.now()) {
  const since = addDays(S.today.day, -(HISTORY_DAYS - 1));
  const todayRow = rowFor(S.today.day);
  const past = Object.values(S.history)
    .filter((r) => r.day < S.today.day && r.day >= since && hasActivity(r))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  setHTML($('#history'), [historyCard(todayRow, true, now), ...past.map((r) => historyCard(r, false, now))].join(''));
}

function renderFoot() {
  const who = MODE === 'cloud' && S.user
    ? `<span>Conectado como <b>${esc(S.user.email || '')}</b></span><button class="btn ghost small" data-act="logout">Sair</button>`
    : '<span>Modo local: configure o Supabase em <code>config.js</code> para sincronizar entre aparelhos.</span>';
  setHTML($('#foot'), who);
}

function render() {
  const now = Date.now();
  $('#todayDate').textContent = longDate(S.today.day);
  renderApps(now);
  renderSummary(now);
  renderHistory(now);
  renderFoot();
}

/** Atualização leve a cada meio segundo (só números e barras). */
function tick() {
  if ($('#main').hidden) return;
  if (dayKey() !== S.today.day) { rollover(); return; }
  const now = Date.now();
  let finished = false;
  forEachAcc(S.today, (a) => {
    if (a.start && elapsed(a, now) >= GOAL) {
      a.ms = GOAL; a.start = null; a.u = now; finished = true;
    }
  });
  if (finished) { alarm(); touchToday(); render(); }

  let anyRunning = false;
  document.querySelectorAll('[data-acc]').forEach((el) => {
    const [appId, key] = el.dataset.acc.split('|');
    const v = accView(appId, key, now);
    if (v.running) anyRunning = true;
    const t = el.querySelector('[data-timer]');
    const txt = v.done ? 'Feita ✓' : fmtClock(GOAL - v.e);
    if (t.textContent !== txt) t.textContent = txt;
    el.querySelector('[data-bar]').style.width = `${(v.e / GOAL) * 100}%`;
  });
  renderSummary(now);
  renderHistory(now);
  updateWakeLock(anyRunning);
  document.title = anyRunning ? `⏱ ${runningClock(now)} · Aquecimento de hoje` : 'Aquecimento de hoje';
}
function runningClock(now) {
  let txt = '';
  forEachAcc(S.today, (a) => { if (a.start) txt = fmtClock(GOAL - elapsed(a, now)); });
  return txt;
}

/* ================= Eventos ================= */
function commitRename(appId, cancel = false) {
  if (rendering || editingApp !== appId) return;
  const inp = document.getElementById(`name-${appId}`);
  const app = S.profile.apps.find((a) => a.id === appId);
  editingApp = null;
  if (app && inp && !cancel) {
    const name = inp.value.trim();
    if (name && name !== app.name) { app.name = name; touchProfile(); }
  }
  render();
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  unlockAudio();

  if (act === 'rename') { editingApp = btn.dataset.app; renderApps(); return; }
  if (act === 'remove') {
    const id = btn.dataset.app;
    if (confirmRemove === id) {
      clearTimeout(confirmTimer); confirmRemove = null;
      S.profile.apps = S.profile.apps.filter((a) => a.id !== id);
      delete S.today.accounts[id];
      touchProfile(); render();
    } else {
      confirmRemove = id; renderApps();
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmRemove = null; renderApps(); }, 4000);
    }
    return;
  }
  if (act === 'logout') { logout(); return; }

  const [appId, key] = (btn.dataset.id || '').split('|');
  if (!actions[act] || !appId) return;
  if (actions[act](appId, key) === false) return;
  touchToday();
  render();
  tick();
});

document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (t.dataset?.name) {
    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(t.dataset.name); }
    if (ev.key === 'Escape') { ev.preventDefault(); commitRename(t.dataset.name, true); }
  } else if (t.dataset?.enter && ev.key === 'Enter') {
    ev.preventDefault();
    const [appId, key] = t.dataset.id.split('|');
    if (actions.addMinutes(appId, key) !== false) { touchToday(); render(); }
  }
});
document.addEventListener('focusout', (ev) => {
  if (ev.target.dataset?.name) commitRename(ev.target.dataset.name);
});

$('#addApp').addEventListener('click', () => {
  const app = { id: newId(), name: `App ${S.profile.apps.length + 1}` };
  S.profile.apps.push(app);
  editingApp = app.id;
  touchProfile();
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    tick();
    if (MODE === 'cloud' && S.user) loadCloud();
  }
});
window.addEventListener('online', () => { if (MODE === 'cloud' && S.user) loadCloud(); });
window.addEventListener('offline', () => { if (MODE === 'cloud') setSync('offline'); });

/* ================= Login ================= */
let loginEmail = '';
function showLogin() {
  $('#main').hidden = true;
  $('#login').hidden = false;
  setSync('');
}
$('#emailForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || ev.target.querySelector('button');
  loginEmail = $('#email').value.trim();
  $('#loginError').textContent = '';
  btn.disabled = true; btn.textContent = 'Enviando…';
  const { error } = await sb.auth.signInWithOtp({
    email: loginEmail,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  btn.disabled = false; btn.textContent = 'Enviar link de acesso';
  if (error) { $('#loginError').textContent = traduzErro(error); return; }
  $('#emailForm').hidden = true;
  $('#codeForm').hidden = false;
  $('#sentMsg').innerHTML = `Enviamos um link para <b>${esc(loginEmail)}</b>. Abra o e-mail neste aparelho e toque no link.`;
});
$('#codeForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const token = $('#code').value.replace(/\s/g, '');
  if (!token) return;
  $('#loginError').textContent = '';
  const { error } = await sb.auth.verifyOtp({ email: loginEmail, token, type: 'email' });
  if (error) $('#loginError').textContent = traduzErro(error);
});
$('#backToEmail').addEventListener('click', () => {
  $('#emailForm').hidden = false; $('#codeForm').hidden = true; $('#loginError').textContent = '';
});
function traduzErro(e) {
  const m = String(e?.message || e);
  if (/rate limit|seconds/i.test(m)) return 'Muitas tentativas. Espere um minuto e tente de novo.';
  if (/expired|invalid/i.test(m)) return 'Código inválido ou expirado. Peça um novo link.';
  return `Não deu certo: ${m}`;
}
async function logout() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  await sb.auth.signOut();
}

/* ================= Início ================= */
function startApp() {
  S.profile = { apps: [], first_day: null, updated_at: 0 };
  S.today = newDay(dayKey());
  S.history = {};
  profileDirty = false; pendingDays.clear();
  const had = loadCache();
  if (!had || !S.profile.apps.length) {
    if (MODE === 'local') { S.profile = defaultProfile(); profileDirty = true; }
  }
  pruneHistory();
  $('#login').hidden = true;
  $('#main').hidden = false;
  render();
  if (S.today.day !== dayKey()) rollover();   // app reaberto em outro dia
  if (MODE === 'local') { saveCache(); setSync('local'); }
  else { loadCloud(); subscribeRealtime(); }
}

async function init() {
  setInterval(tick, 500);
  if (MODE === 'local') { startApp(); return; }

  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  let currentUid = null;
  sb.auth.onAuthStateChange((_event, session) => {
    const uid = session?.user?.id || null;
    if (uid === currentUid) { if (session) S.user = session.user; return; }
    currentUid = uid;
    S.user = session?.user || null;
    if (S.user) {
      // limpa o link mágico da barra de endereço
      if (location.hash.includes('access_token') || location.search.includes('code=')) {
        history.replaceState(null, '', location.pathname);
      }
      setTimeout(startApp, 0);
    } else {
      showLogin();
    }
  });
}

init();
