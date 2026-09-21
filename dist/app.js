// ============================================================ utilities
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DAY = 86400000, ROLLOVER = 4;
const pad = n => String(n).padStart(2, '0');
function dayStart(ts){ const d = new Date(ts); d.setHours(ROLLOVER, 0, 0, 0); if (d.getTime() > ts) d.setDate(d.getDate() - 1); return d.getTime(); }
function dayKey(ts){ const d = new Date(dayStart(ts)); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function daysBetween(a, b){ return Math.round((dayStart(b) - dayStart(a)) / DAY); }
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function fmtIvl(days){
  if (days < 1){ const m = Math.max(1, Math.round(days * 1440)); return m < 60 ? `${m}m` : `${Math.round(m/60)}h`; }
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days/30).toFixed(1).replace(/\.0$/,'')}mo`;
  return `${(days/365).toFixed(1).replace(/\.0$/,'')}y`;
}
function fmtDue(due, now){
  const d = daysBetween(now, due);
  if (due <= now) return 'now';
  if (d <= 0) return fmtIvl((due - now)/DAY);
  if (d === 1) return 'tomorrow';
  return `in ${fmtIvl(d)}`;
}
async function ask(msg){ const T = window.__TAURI__; if (T?.dialog?.confirm){ try { return await T.dialog.confirm(msg, { title: 'Ember', kind: 'warning' }); } catch {} } return confirm(msg); }
let toastT; function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }

// ============================================================ FSRS-6
// Free Spaced Repetition Scheduler, version 6. Formulas and default
// parameters from the open-spaced-repetition project.
const FSRS = (() => {
  const W = [0.2172,1.1771,3.2602,16.1507,7.0114,0.57,2.0966,0.0069,1.5261,0.112,1.0178,1.849,0.1133,0.3127,2.2934,0.2191,3.0004,0.7536,0.3332,0.1437,0.2];
  const DECAY = -W[20];
  const FACTOR = Math.pow(0.9, 1/DECAY) - 1;
  const retrievability = (elapsedDays, S) => Math.pow(1 + FACTOR * elapsedDays / S, DECAY);
  const interval = (S, r) => S / FACTOR * (Math.pow(r, 1/DECAY) - 1);
  const initS = g => clamp(W[g-1], 0.01, 36500);
  const initD = g => clamp(W[4] - Math.exp(W[5]*(g-1)) + 1, 1, 10);
  const nextD = (d, g) => { const dp = d + (-W[6]*(g-3)) * (10 - d)/9; return clamp(W[7]*initD(4) + (1-W[7])*dp, 1, 10); };
  const recallS = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11-d) * Math.pow(s, -W[9]) * (Math.exp(W[10]*(1-r)) - 1) * (g===2 ? W[15] : 1) * (g===4 ? W[16] : 1));
  const forgetS = (d, s, r) => Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s+1, W[13]) - 1) * Math.exp(W[14]*(1-r)), s);
  // Memory state after rating g, given the card's current state and the time since its last review.
  function next(card, g, now){
    if (!card.S) return { S: initS(g), D: initD(g) };
    const elapsed = card.lastReview ? daysBetween(card.lastReview, now) : 0;
    let S = card.S;
    if (elapsed >= 1){
      const r = retrievability(elapsed, card.S);
      S = g === 1 ? forgetS(card.D, card.S, r) : recallS(card.D, card.S, r, g);
    }
    return { S: clamp(S, 0.01, 36500), D: nextD(card.D, g) };
  }
  return { W, retrievability, interval, next };
})();

// Anki-style interval fuzz: widens with the interval so reviews spread across days.
function fuzz(ivl, maxI){
  if (ivl < 2.5) return clamp(Math.round(ivl), 1, maxI);
  const ranges = [[2.5,7,0.15],[7,20,0.1],[20,Infinity,0.05]];
  let delta = 1;
  for (const [s,e,f] of ranges) delta += f * Math.max(Math.min(ivl, e) - s, 0);
  const lo = clamp(Math.round(ivl - delta), 1, maxI), hi = clamp(Math.round(ivl + delta), 1, maxI);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

// Computes the four possible outcomes (1 Again, 2 Hard, 3 Good, 4 Easy) for a card.
function schedule(card, now, S){
  const steps = S.learningSteps, rsteps = S.relearningSteps, r = S.desiredRetention, maxI = S.maxInterval;
  const mem = g => FSRS.next(card, g, now);
  const raw = s => clamp(Math.round(FSRS.interval(s, r)), 1, maxI);
  const fz = i => S.fuzz ? fuzz(i, maxI) : i;
  const learn = (state, remaining, due, m) => ({ state, remaining, due, S: m.S, D: m.D, ivl: card.ivl || 0, label: fmtIvl((due - now)/DAY) });
  const review = (ivl, m, extra={}) => ({ state: 'review', remaining: 0, due: dayStart(now) + ivl*DAY, ivl, S: m.S, D: m.D, label: fmtIvl(ivl), ...extra });
  const out = {};
  if (card.state === 'new' || card.state === 'learning' || card.state === 'relearning'){
    const st = card.state === 'relearning' ? rsteps : steps;
    const remaining = card.state === 'new' ? st.length : clamp(card.remaining ?? st.length, 0, st.length);
    const idx = st.length ? clamp(st.length - remaining, 0, st.length - 1) : 0;
    const m1 = mem(1), m2 = mem(2), m3 = mem(3), m4 = mem(4);
    const gradIvl = card.state === 'relearning' && card.pendingIvl ? card.pendingIvl : null;
    // Again: back to the first step
    out[1] = st.length ? learn(card.state === 'relearning' ? 'relearning' : 'learning', st.length, now + st[0]*60000, m1)
                       : review(fz(raw(m1.S)), m1);
    // Hard: repeat the current step (first step: halfway to the next)
    if (st.length){
      let d = idx === 0 ? (st[1] != null ? (st[0]+st[1])/2 : Math.min(st[0]*1.5, st[0]+1440)) : st[idx];
      out[2] = learn(card.state === 'relearning' ? 'relearning' : 'learning', remaining || st.length, now + d*60000, m2);
    } else out[2] = review(fz(raw(m2.S)), m2);
    // Good: next step, or graduate
    let goodIvl = null;
    if (st[idx+1] != null) out[3] = learn(card.state === 'relearning' ? 'relearning' : 'learning', st.length - (idx+1), now + st[idx+1]*60000, m3);
    else { goodIvl = gradIvl ?? fz(raw(m3.S)); out[3] = review(goodIvl, m3); }
    // Easy: graduate now
    let easyIvl = fz(raw(m4.S)); if (goodIvl != null) easyIvl = Math.max(easyIvl, goodIvl + 1); if (gradIvl) easyIvl = Math.max(easyIvl, gradIvl + 1);
    out[4] = review(easyIvl, m4);
  } else {
    const m1 = mem(1), m2 = mem(2), m3 = mem(3), m4 = mem(4);
    const prev = card.ivl || 0;
    const passing = (m, floor) => { const rw = raw(m.S); const min = Math.max(floor, rw > prev ? prev + 1 : 1); return clamp(fz(Math.max(rw, min)), min, maxI); };
    const hard = passing(m2, 1), good = passing(m3, hard + 1), easy = passing(m4, good + 1);
    const lapseIvl = raw(m1.S);
    out[1] = rsteps.length
      ? { state: 'relearning', remaining: rsteps.length, due: now + rsteps[0]*60000, S: m1.S, D: m1.D, ivl: card.ivl || 0, pendingIvl: lapseIvl, lapse: true, label: fmtIvl(rsteps[0]/1440) }
      : review(lapseIvl, m1, { lapse: true });
    out[2] = review(hard, m2); out[3] = review(good, m3); out[4] = review(easy, m4);
  }
  return out;
}

// ============================================================ store (shared db, or this device only)
const DEFAULT_SETTINGS = { desiredRetention: 0.9, newPerDay: 20, reviewsPerDay: 200, learningSteps: [1,10], relearningSteps: [10], maxInterval: 36500, fuzz: true, leechThreshold: 8 };
const DECK_COLORS = ['#2A44C8','#1D915F','#CF7F05','#B23A8F','#0E8A9E','#D0424B','#6B4FBB','#4F7A28'];
const store = {
  mode: 'connecting', db: null, decks: new Map(), cards: new Map(), stats: new Map(), settings: { ...DEFAULT_SETTINGS },
  listeners: new Set(), ready: false,
  onChange(fn){ this.listeners.add(fn); },
  emit(){ for (const fn of this.listeners) fn(); },
  async init(){
    const T = window.__TAURI__;
    if (T?.fs && T?.path){ this.tauri = T; this.mode = 'desktop'; await this.initDesktop(); }
    else { this.mode = 'local'; this.initLocal(); }
    this.ready = true; this.emit();
  },
  async initDesktop(){
    const T = this.tauri;
    try {
      const dir = await T.path.appDataDir();
      this.dataDir = dir;
      this.dataFile = await T.path.join(dir, 'ember-data.json');
      if (!(await T.fs.exists(dir))) await T.fs.mkdir(dir, { recursive: true });
      if (await T.fs.exists(this.dataFile)) this.load(JSON.parse(await T.fs.readTextFile(this.dataFile)));
      else { this.seedDecks(); await this.flush(); }
    } catch (e){ console.warn('desktop storage', e); this.desktopBroken = true; toast('Could not open the data file. Cards will not be saved.'); }
  },
  initLocal(){
    try { const raw = localStorage.getItem('ember.v1'); if (raw) this.load(JSON.parse(raw)); } catch {}
    if (!this.decks.size && !this.cards.size){ this.seedDecks(); this.saveLocal(); }
  },
  seedDecks(){
    const now = Date.now();
    this.decks.set('d-start', { id: 'd-start', name: 'Getting started', color: DECK_COLORS[4], createdAt: now, order: 0 });
    this.decks.set('d-mine', { id: 'd-mine', name: 'My first deck', color: DECK_COLORS[0], createdAt: now + 1, order: 1 });
    STARTER_CARDS.forEach((n, i) => expandNote('d-start', n).forEach(c => { c.createdAt = now + 10 + i; this.cards.set(c.id, c); }));
  },
  load(j){
    for (const d of j.decks || []) if (d && d.id) this.decks.set(d.id, d);
    for (const c of j.cards || []) if (c && c.id) this.cards.set(c.id, c);
    for (const s of j.stats || []) if (s && s.id) this.stats.set(s.id, s);
    this.settings = { ...DEFAULT_SETTINGS, ...(j.settings || {}) };
  },
  snapshot(){ return JSON.stringify({ app: 'ember', version: 1, savedAt: new Date().toISOString(), decks: [...this.decks.values()], cards: [...this.cards.values()], stats: [...this.stats.values()], settings: this.settings }); },
  saveLocal(){ try { localStorage.setItem('ember.v1', this.snapshot()); } catch {} },
  save(){
    if (this.mode === 'desktop'){ clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flush(), 150); }
    else this.saveLocal();
  },
  flush(){
    if (this.mode !== 'desktop' || this.desktopBroken) return Promise.resolve();
    clearTimeout(this.saveT);
    const data = this.snapshot();
    this.flushing = (this.flushing || Promise.resolve()).then(async () => { try { await this.tauri.fs.writeTextFile(this.dataFile, data); } catch (e){ console.warn(e); toast('Could not save to the data file.'); } });
    return this.flushing;
  },
  async put(coll, obj){ this[coll].set(obj.id, obj); this.emit(); this.save(); },
  async remove(coll, id){ this[coll].delete(id); this.emit(); this.save(); },
  async saveSettings(s){ this.settings = { ...this.settings, ...s }; this.emit(); this.save(); }
};

// ============================================================ card helpers
const STARTER_CARDS = [
  { type: 'basic', front: 'What does the thin colored bar at the top of a card show?', back: 'Your estimated chance of recalling the card right now.', extra: 'It fades toward red as memory decays. Reviews are scheduled for when it would reach your target.' },
  { type: 'cloze', front: 'Ember schedules with {{c1::FSRS-6}}, the same algorithm Anki uses, aiming for {{c2::90%}} recall at review time by default.', back: '', extra: 'You can change the target in Settings.' },
  { type: 'basic', front: 'When should you press Hard instead of Good?', back: 'When you recalled the answer but it took real effort or you hesitated.', extra: 'Again = forgot. Good = recalled normally. Easy = instant and effortless.' },
  { type: 'basic', front: "What is a card's stability?", back: 'The number of days until your chance of recalling it falls to 90%.', extra: 'Shown under each card. It grows with every successful review.' },
  { type: 'basic', front: 'Why does a new card come back after 1 minute, then 10 minutes, before getting a multi-day interval?', back: 'Those are learning steps: quick repeats that build a first stable memory before the algorithm takes over.', extra: "Anki's defaults. Adjustable in Settings." },
  { type: 'basic', front: 'Which keys flip a card and grade it?', back: 'Space flips; 1, 2, 3, 4 grade Again, Hard, Good, Easy. E edits, U undoes.', extra: '' },
  { type: 'basic', front: 'Fastest way to turn lecture notes into cards?', back: 'Paste them into an AI assistant with the deck list from Add cards, ask for an Ember backup file, then Restore it.', extra: 'Or type cards one per line in Quick add.' },
  { type: 'vocab', front: 'la mémoire', back: 'memory (French)', extra: 'Vocabulary cards are made in both directions.' },
];
function newCard(deckId, type, front, back, extra='', more={}){
  return { id: uid('c'), deckId, type, front, back: back || '', extra: extra || '', createdAt: Date.now(), state: 'new', remaining: 0, due: 0, S: 0, D: 0, reps: 0, lapses: 0, lastReview: 0, ivl: 0, suspended: false, leech: false, history: [], ...more };
}
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
function clozeIndices(text){ const s = new Set(); for (const m of text.matchAll(CLOZE_RE)) s.add(+m[1]); return [...s].sort((a,b)=>a-b); }
function renderCloze(text, idx, reveal){
  return esc(text).replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (_, n, ans, hint) => {
    if (+n === idx) return reveal ? `<span class="cloze">${ans}</span>` : `<span class="blank">[${hint || '…'}]</span>`;
    return ans;
  });
}
function cardFrontHTML(c){ return c.type === 'cloze' ? renderCloze(c.front, c.clozeIndex || 1, false) : esc(c.front); }
function cardBackHTML(c){ return c.type === 'cloze' ? renderCloze(c.front, c.clozeIndex || 1, true) : esc(c.back); }
function plainFront(c){ return c.type === 'cloze' ? c.front.replace(CLOZE_RE, (_, n, a) => a) : c.front; }
// Turn a proposed note into one or more cards (cloze notes make one card per deletion; vocab makes a reversed pair).
function expandNote(deckId, n){
  const type = n.type || 'basic', front = (n.front || '').trim(), back = (n.back || '').trim(), extra = (n.extra || '').trim();
  if (!front) return [];
  if (type === 'cloze'){
    const idxs = clozeIndices(front); if (!idxs.length) return [newCard(deckId, 'basic', front, back, extra)];
    const noteId = uid('n'); return idxs.map(i => newCard(deckId, 'cloze', front, back, extra, { clozeIndex: i, noteId }));
  }
  if (type === 'vocab'){
    if (!back) return [newCard(deckId, 'basic', front, back, extra)];
    const pairId = uid('p');
    return [newCard(deckId, 'basic', front, back, extra, { pairId, dir: 'fwd' }), newCard(deckId, 'basic', back, front, extra, { pairId, dir: 'rev' })];
  }
  return [newCard(deckId, 'basic', front, back, extra)];
}

// ============================================================ queue
function todayStat(now){ const k = dayKey(now); return store.stats.get(k) || { id: k, reviews: 0, newCards: 0, again: 0, hard: 0, good: 0, easy: 0, timeMs: 0 }; }
function buildQueue(deckId, now){
  const S = store.settings, st = todayStat(now), end = dayStart(now) + DAY;
  const all = [...store.cards.values()].filter(c => !c.suspended && (!deckId || c.deckId === deckId) && store.decks.has(c.deckId));
  const learn = all.filter(c => (c.state === 'learning' || c.state === 'relearning') && c.due <= now).sort((a,b) => a.due - b.due);
  const learnAhead = all.filter(c => (c.state === 'learning' || c.state === 'relearning') && c.due > now && c.due <= now + 20*60000).sort((a,b) => a.due - b.due);
  const reviewCap = Math.max(0, S.reviewsPerDay - st.reviews), newCap = Math.max(0, S.newPerDay - st.newCards);
  const review = all.filter(c => c.state === 'review' && c.due < end).sort((a,b) => a.due - b.due).slice(0, reviewCap);
  const fresh = all.filter(c => c.state === 'new').sort((a,b) => (a.createdAt||0) - (b.createdAt||0) || a.id.localeCompare(b.id)).slice(0, newCap);
  // Shuffle reviews lightly and interleave new cards evenly among them.
  for (let i = review.length - 1; i > 0; i--){ const j = Math.floor(Math.random()*(i+1)); [review[i], review[j]] = [review[j], review[i]]; }
  const mixed = [];
  if (fresh.length && review.length){ const gap = Math.max(1, Math.round(review.length / fresh.length)); let f = 0;
    review.forEach((c, i) => { mixed.push(c); if ((i+1) % gap === 0 && f < fresh.length) mixed.push(fresh[f++]); });
    while (f < fresh.length) mixed.push(fresh[f++]); }
  else mixed.push(...review, ...fresh);
  return { learn, learnAhead, mixed, counts: { learn: learn.length, review: review.length, fresh: fresh.length } };
}
function nextCard(q, now){
  const dueLearn = q.learn.filter(c => c.due <= now).sort((a,b)=>a.due-b.due);
  if (dueLearn.length) return dueLearn[0];
  if (q.mixed.length) return q.mixed[0];
  if (q.learn.length) return q.learn[0];
  if (q.learnAhead.length) return q.learnAhead[0];
  return null;
}
function deckCounts(deckId, now){
  const q = buildQueue(deckId, now); return q.counts;
}

// ============================================================ app state & routing
const state = { view: 'today', deckFilter: null, review: null, browse: { q: '', deck: '', state: '' }, gen: { proposals: null, busy: false, ctl: null, status: '' }, addTab: 'quick', undo: null };

function go(view, opts={}){ state.view = view; Object.assign(state, opts); location.hash = view; render(); window.scrollTo({ top: 0 }); }
document.addEventListener('click', e => { const b = e.target.closest('[data-nav]'); if (b){ if (b.dataset.nav === 'today') state.deckFilter = null; go(b.dataset.nav); } });

function render(){
  const main = $('#main');
  $$('[data-nav]').forEach(b => b.setAttribute('aria-current', b.dataset.nav === state.view || (state.view === 'review' && b.dataset.nav === 'today') ? 'page' : 'false'));
  const ml = $('#modeLabel'); if (ml){ ml.innerHTML = store.mode === 'desktop' ? '<span class="dot"></span>Saved on this computer' : store.mode === 'local' ? '<span class="dot local"></span>This browser only' : '<span class="dot"></span>Connecting…'; }
  if (!store.ready){ main.innerHTML = '<div class="skeleton"></div>'; return; }
  const v = { today: viewToday, decks: viewDecks, add: viewAdd, browse: viewBrowse, stats: viewStats, settings: viewSettings, review: viewReview }[state.view] || viewToday;
  main.innerHTML = v();
  afterRender();
}
store.onChange(() => { if (state.view !== 'review' && state.view !== 'add') render(); else if (state.view === 'review' && !state.review) render(); });

function localBanner(){ return store.mode === 'local' ? '<div class="banner">Running in a web browser, so cards are kept only in this browser. The desktop app keeps them in a file you can back up.</div>' : store.desktopBroken ? '<div class="banner">The data file could not be opened. Changes will be lost when you quit.</div>' : ''; }
function deckOptions(sel){ return [...store.decks.values()].sort((a,b)=>(a.order??0)-(b.order??0) || a.name.localeCompare(b.name)).map(d => `<option value="${d.id}" ${d.id===sel?'selected':''}>${esc(d.name)}</option>`).join(''); }
function streak(now){
  let n = 0, k = dayStart(now);
  if (!(store.stats.get(dayKey(k))?.reviews > 0)) k -= DAY;
  while (store.stats.get(dayKey(k))?.reviews > 0){ n++; k -= DAY; }
  return n;
}

// ------------------------------------------------------------ Today
function viewToday(){
  const now = Date.now(), q = buildQueue(null, now), st = todayStat(now);
  const due = q.counts.learn + q.counts.review + q.counts.fresh, done = st.reviews;
  const pct = due + done ? done / (due + done) : 1;
  const decks = [...store.decks.values()].sort((a,b)=>(a.order??0)-(b.order??0) || a.name.localeCompare(b.name));
  const total = store.cards.size, s = streak(now);
  const d = new Date(now), dateLabel = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return `<div class="view">
    ${localBanner()}
    <div class="row" style="justify-content:space-between;align-items:flex-start"><div><div class="eyebrow">${esc(dateLabel)}</div><h1 class="title">${due ? 'Ready when you are.' : done ? 'All caught up.' : total ? 'Nothing due yet.' : 'Light the first ember.'}</h1></div><button class="btn ghost sm only-mobile" data-nav="settings" aria-label="Settings">⚙︎ Settings</button></div>
    <div class="card-panel hero">
      <div>
        <div class="big">${due}<small>${due === 1 ? 'card due' : 'cards due'}</small></div>
        <div class="counts"><span class="c-new"><b>${q.counts.fresh}</b> new</span><span class="c-learn"><b>${q.counts.learn}</b> learning</span><span class="c-due"><b>${q.counts.review}</b> to review</span>${s ? `<span class="streak">🔥 ${s}-day streak</span>` : ''}</div>
        <div class="row" style="margin-top:18px;gap:10px;flex-wrap:wrap">
          <button class="btn primary" id="startAll" ${due ? '' : 'disabled'}>Start reviewing</button>
          <button class="btn ghost" data-nav="add">Add cards</button>
        </div>
      </div>
      <div class="ring" aria-label="Progress today"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="prog" cx="60" cy="60" r="52" stroke-dasharray="${(pct*326.7).toFixed(1)} 326.7"/></svg><div class="lbl"><b>${done}</b>reviewed</div></div>
    </div>
    <div class="section-h"><h2>Decks</h2><button class="btn ghost sm" id="newDeck">+ New deck</button></div>
    <div class="card-panel deck-list">
      ${decks.length ? decks.map(dk => deckRow(dk, now)).join('') : `<div class="empty"><h3>No decks yet</h3>Create a deck, then add cards by pasting notes into the Generate tab.</div>`}
    </div>
  </div>`;
}
function deckRow(dk, now){
  const c = deckCounts(dk.id, now), total = [...store.cards.values()].filter(x => x.deckId === dk.id).length;
  return `<button class="deck-row" data-deck="${dk.id}">
    <span class="swatch" style="background:${dk.color || DECK_COLORS[0]}"></span>
    <span class="grow"><div class="name">${esc(dk.name)}</div><div class="meta">${total} ${total===1?'card':'cards'}</div></span>
    <span class="nums"><span class="c-new">${c.fresh}</span><span class="c-learn">${c.learn}</span><span class="c-due">${c.review}</span></span>
    <span class="more" data-deck-edit="${dk.id}" role="button" aria-label="Deck options" tabindex="0">···</span>
  </button>`;
}
function viewDecks(){ return viewToday(); }

// ------------------------------------------------------------ Review
function startReview(deckId){
  const now = Date.now(); const q = buildQueue(deckId, now); const c = nextCard(q, now);
  state.review = { deckId, current: c ? c.id : null, flipped: false, shownAt: now, answered: 0, outcomes: null };
  state.undo = null;
  go('review');
}
function viewReview(){
  const r = state.review; if (!r) return viewToday();
  const now = Date.now(), q = buildQueue(r.deckId, now);
  let card = r.current ? store.cards.get(r.current) : null;
  if (!card){ card = nextCard(q, now); r.current = card ? card.id : null; r.flipped = false; r.shownAt = now; }
  const deckName = r.deckId ? (store.decks.get(r.deckId)?.name || 'Deck') : 'All decks';
  if (!card){
    const st = todayStat(now);
    const wait = q.learn.concat(q.learnAhead).sort((a,b)=>a.due-b.due)[0];
    return `<div class="view">
      <div class="rv-top"><button class="btn ghost sm" data-nav="today">← Today</button><span class="chip">${esc(deckName)}</span></div>
      <div class="card-panel done"><div class="ember"></div><h2>${r.answered ? 'Session complete.' : 'Nothing due right now.'}</h2>
        <p class="sub" style="margin:0 auto">${r.answered ? `You answered ${r.answered} ${r.answered===1?'card':'cards'} just now, ${st.reviews} today.` : ''} ${wait ? `Next learning card comes back ${fmtDue(wait.due, now)}.` : 'The scheduler will bring cards back exactly when they start to fade.'}</p>
        <div class="row" style="justify-content:center;margin-top:20px;gap:10px;flex-wrap:wrap"><button class="btn primary" data-nav="today">Back to Today</button><button class="btn" data-nav="add">Add more cards</button></div>
      </div></div>`;
  }
  const S = store.settings, outcomes = r.outcomes && r.outcomes.id === card.id ? r.outcomes.o : (r.outcomes = { id: card.id, o: schedule(card, now, S) }).o;
  const deck = store.decks.get(card.deckId);
  const elapsed = card.lastReview ? Math.max(0, (now - card.lastReview)/DAY) : 0;
  const R = card.S ? FSRS.retrievability(elapsed, card.S) : null;
  const kind = card.state === 'new' ? 'New card' : card.state === 'review' ? 'Review' : card.state === 'relearning' ? 'Relearning' : 'Learning';
  const frontHTML = cardFrontHTML(card), longFront = plainFront(card).length > 140;
  const total = q.counts.learn + q.counts.review + q.counts.fresh;
  const cur = card.state === 'new' ? 'fresh' : card.state === 'review' ? 'review' : 'learn';
  return `<div class="view">
    <div class="rv-top">
      <button class="btn ghost sm" data-nav="today">← ${esc(deckName)}</button>
      <div class="nums" aria-label="Remaining"><span class="c-new ${cur==='fresh'?'on':''}">${q.counts.fresh}</span><span class="c-learn ${cur==='learn'?'on':''}">${q.counts.learn}</span><span class="c-due ${cur==='review'?'on':''}">${q.counts.review}</span></div>
    </div>
    <div class="card-panel flash" id="flash">
      <div class="arc"><i style="width:${R != null ? (R*100).toFixed(1) : 0}%"></i></div>
      <div class="kind"><span>${kind}${deck ? ` · ${esc(deck.name)}` : ''}</span><span class="r">${R != null ? `${Math.round(R*100)}% recall` : 'unseen'}</span></div>
      <div class="front ${longFront ? 'long' : ''}">${frontHTML}</div>
      ${r.flipped ? `<div class="back">${cardBackHTML(card) || '<span style="color:var(--ink-3)">(no answer text)</span>'}</div>${card.extra ? `<div class="extra">${esc(card.extra)}</div>` : ''}` : ''}
      <div class="spacer"></div>
      <div class="stats">
        <span>${card.S ? `stability ${fmtIvl(card.S)} · difficulty ${card.D.toFixed(1)} · ${card.reps} ${card.reps===1?'review':'reviews'}${card.lapses ? ` · ${card.lapses} ${card.lapses===1?'lapse':'lapses'}` : ''}` : 'first time seeing this card'}</span>
        ${card.S ? forgettingCurve(card, elapsed) : ''}
      </div>
    </div>
    <div class="answer-bar">
      ${r.flipped ? `<div class="rate">
        ${[1,2,3,4].map(g => `<button class="r${g}" data-rate="${g}"><span class="lbl">${['Again','Hard','Good','Easy'][g-1]}</span><span class="ivl">${outcomes[g].label}</span></button>`).join('')}
      </div>` : `<button class="btn primary show" id="flip">Show answer</button>`}
    </div>
    <div class="rv-foot">
      <span><span class="kbd">space</span> flip · <span class="kbd">1</span>–<span class="kbd">4</span> rate · <span class="kbd">E</span> edit · <span class="kbd">U</span> undo</span>
      <span class="row" style="gap:6px"><button class="btn ghost sm" id="editCur">Edit</button><button class="btn ghost sm" id="undoBtn" ${state.undo ? '' : 'disabled'}>Undo</button><span class="chip">${total} left</span></span>
    </div>
  </div>`;
}
function forgettingCurve(card, elapsed){
  const span = Math.max(card.S * 2.2, elapsed * 1.1, 1), w = 120, h = 30;
  const pts = []; for (let i = 0; i <= 40; i++){ const t = span * i/40; pts.push(`${(t/span*w).toFixed(1)},${(h - FSRS.retrievability(t, card.S)*h).toFixed(1)}`); }
  const x = (elapsed/span*w).toFixed(1), y = (h - FSRS.retrievability(elapsed, card.S)*h).toFixed(1);
  const x90 = (card.S/span*w).toFixed(1);
  return `<svg viewBox="-2 -4 124 38" aria-label="Forgetting curve"><line x1="${x90}" y1="0" x2="${x90}" y2="${h}" stroke="var(--line)" stroke-dasharray="2 2"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="3" fill="var(--accent)" stroke="var(--surface)" stroke-width="1.5"/></svg>`;
}
async function rate(g){
  const r = state.review; if (!r || !r.flipped) return;
  const card = store.cards.get(r.current); if (!card) return;
  const now = Date.now(), S = store.settings;
  const o = (r.outcomes && r.outcomes.id === card.id ? r.outcomes.o : schedule(card, now, S))[g];
  const prev = JSON.parse(JSON.stringify(card)), prevStat = JSON.parse(JSON.stringify(todayStat(now)));
  const wasNew = card.state === 'new';
  const upd = { ...card, state: o.state, remaining: o.remaining, due: o.due, S: o.S, D: o.D, ivl: o.ivl, reps: (card.reps||0) + 1, lastReview: now };
  if (o.pendingIvl != null) upd.pendingIvl = o.pendingIvl; else if (o.state === 'review') delete upd.pendingIvl;
  if (o.lapse){ upd.lapses = (card.lapses||0) + 1; if (upd.lapses >= S.leechThreshold && upd.lapses % Math.max(1, Math.floor(S.leechThreshold/2)) === 0) { upd.leech = true; toast('This card keeps lapsing. Consider rewording it.'); } }
  upd.history = [...(card.history||[]).slice(-29), { t: now, g, ivl: o.state === 'review' ? o.ivl : +((o.due - now)/DAY).toFixed(4) }];
  const st = todayStat(now); const ms = clamp(now - (r.shownAt || now), 0, 60000);
  const key = ['again','hard','good','easy'][g-1];
  const st2 = { ...st, reviews: st.reviews + 1, [key]: (st[key]||0) + 1, timeMs: (st.timeMs||0) + ms, newCards: st.newCards + (wasNew ? 1 : 0) };
  state.undo = { card: prev, stat: prevStat };
  r.answered++; r.current = null; r.flipped = false; r.outcomes = null; r.shownAt = Date.now();
  await Promise.all([store.put('cards', upd), store.put('stats', st2)]);
  render();
}
async function undo(){
  const u = state.undo; if (!u) return; state.undo = null;
  await Promise.all([store.put('cards', u.card), store.put('stats', u.stat)]);
  if (state.review){ state.review.current = u.card.id; state.review.flipped = false; state.review.outcomes = null; state.review.answered = Math.max(0, state.review.answered - 1); }
  toast('Undone'); render();
}
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || $('#dlg').open) return;
  if (state.view !== 'review' || !state.review) return;
  if (e.key === ' ' || e.key === 'Enter'){ e.preventDefault(); if (!state.review.flipped){ state.review.flipped = true; render(); } else rate(3); }
  else if (['1','2','3','4'].includes(e.key)){ if (state.review.flipped) rate(+e.key); }
  else if (e.key === 'e' || e.key === 'E'){ const c = store.cards.get(state.review.current); if (c) openCardDialog(c); }
  else if (e.key === 'u' || e.key === 'U'){ undo(); }
});

// ------------------------------------------------------------ Add cards
function viewAdd(){
  const g = state.gen, decks = [...store.decks.values()].sort((a,b)=>(a.order??0)-(b.order??0));
  const noDecks = !decks.length;
  return `<div class="view">
    ${localBanner()}
    <div><div class="eyebrow">Add cards</div><h1 class="title">From notes to cards in a minute.</h1></div>
    <div class="seg" role="tablist"><button role="tab" aria-pressed="${state.addTab==='quick'}" data-addtab="quick">Quick add</button><button role="tab" aria-pressed="${state.addTab==='claude'}" data-addtab="claude">✦ Ask an AI assistant</button></div>
    ${noDecks ? `<div class="card-panel empty"><h3>Make a deck first</h3><button class="btn primary" id="newDeck" style="margin-top:8px">+ New deck</button></div>` : state.addTab === 'claude' ? `
    <div class="card-panel" style="padding:22px">
      <h2 class="serif" style="font-weight:500;font-size:22px;margin-bottom:8px">Let an AI assistant write the cards</h2>
      <p class="sub">Paste a paper, lecture notes, or a word list into Claude, ChatGPT, or any assistant and ask for Ember cards. It hands back a backup file; restore it here and the cards land in the right deck.</p>
      <ol style="padding-left:20px;color:var(--ink-2);display:flex;flex-direction:column;gap:8px;margin:14px 0">
        <li>Tap <b>Copy deck list</b> and paste it into the assistant along with your source text. Say: <em>“Write Ember flashcards from this for my ${esc(decks[0].name)} deck and give me the backup file.”</em></li>
        <li>Save the <code class="mono">.json</code> file it gives you.</li>
        <li>Tap <b>Restore backup</b> and choose that file. Existing cards are untouched.</li>
      </ol>
      <div class="row" style="gap:10px;flex-wrap:wrap"><label class="btn primary" for="importFile2" style="cursor:pointer">Restore backup…<input type="file" id="importFile2" accept="application/json,.json" hidden></label><button class="btn" id="copyDeckIds">Copy deck list</button></div>
      <p class="hint" style="margin-top:12px">Quick add works too: paste the assistant's cards as <code>question | answer</code> lines.</p>
    </div>` : `
    <div class="card-panel" style="padding:20px">
      <div class="grid2" style="margin-bottom:14px">
        <div class="field"><label for="qaDeck">Deck</label><select class="input" id="qaDeck">${deckOptions(g.deck || decks[0].id)}</select></div>
        <div class="field"><label for="qaMode">Line format</label><select class="input" id="qaMode"><option value="qa" ${(g.qaMode||'qa')==='qa'?'selected':''}>question | answer</option><option value="vocab" ${g.qaMode==='vocab'?'selected':''}>term = meaning (makes both directions)</option></select></div>
      </div>
      <div class="field"><label for="qaText">One card per line</label><textarea class="input" id="qaText" rows="9" placeholder="What is the powerhouse of the cell? | The mitochondrion&#10;Water boils at {{c1::100 °C}} at sea level&#10;bonjour = hello">${esc(g.qaText || '')}</textarea></div>
      <p class="hint">Add a third part after another <code>|</code> for a hint or context. Wrap text in <code>{{c1::…}}</code> to make a fill-in-the-blank card.</p>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="qaAdd">Add cards</button></div>
    </div>`}
  </div>`;
}
function parseQuick(text, mode){
  const notes = [];
  for (const raw of text.split('\n')){ const line = raw.trim(); if (!line) continue;
    if (CLOZE_RE.test(line)){ CLOZE_RE.lastIndex = 0; const [f, ...rest] = line.split('|'); notes.push({ type: 'cloze', front: f.trim(), extra: rest.join('|').trim() }); continue; }
    CLOZE_RE.lastIndex = 0;
    if (mode === 'vocab' && line.includes('=') && !line.includes('|')){ const i = line.indexOf('='); notes.push({ type: 'vocab', front: line.slice(0,i).trim(), back: line.slice(i+1).trim() }); continue; }
    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 2) notes.push({ type: mode === 'vocab' ? 'vocab' : 'basic', front: parts[0], back: parts[1], extra: parts.slice(2).join(' | ') });
    else notes.push({ type: 'basic', front: parts[0], back: '' });
  }
  return notes;
}
async function addNotes(deckId, notes){
  const cards = notes.flatMap(n => expandNote(deckId, n));
  for (const c of cards) await store.put('cards', c);
  return cards.length;
}
// ------------------------------------------------------------ Browse
function viewBrowse(){
  const b = state.browse, q = b.q.trim().toLowerCase(), now = Date.now();
  let list = [...store.cards.values()];
  if (b.deck) list = list.filter(c => c.deckId === b.deck);
  if (b.state) list = list.filter(c => b.state === 'suspended' ? c.suspended : b.state === 'leech' ? c.leech : c.state === b.state);
  if (q) list = list.filter(c => (plainFront(c) + ' ' + c.back + ' ' + (c.extra||'')).toLowerCase().includes(q));
  list.sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
  const shown = list.slice(0, 300);
  return `<div class="view">
    <div><div class="eyebrow">Browse</div><h1 class="title">${store.cards.size} ${store.cards.size===1?'card':'cards'}</h1></div>
    <div class="row" style="flex-wrap:wrap;gap:10px">
      <input class="input grow" id="bq" placeholder="Search cards" value="${esc(b.q)}" style="min-width:180px">
      <select class="input" id="bdeck" style="width:auto"><option value="">All decks</option>${deckOptions(b.deck)}</select>
      <select class="input" id="bstate" style="width:auto"><option value="">Any state</option>${[['new','New'],['learning','Learning'],['review','Review'],['relearning','Relearning'],['suspended','Suspended'],['leech','Leeches']].map(([v,l]) => `<option value="${v}" ${b.state===v?'selected':''}>${l}</option>`).join('')}</select>
    </div>
    <div class="card-panel">
      ${shown.length ? shown.map(c => { const dk = store.decks.get(c.deckId); return `<button class="browse-row" data-card="${c.id}">
        <span class="grow"><div class="q">${cardFrontHTML(c)}</div><div class="a">${esc(c.type === 'cloze' ? (c.extra || '') : c.back)}</div></span>
        <span class="m"><span class="state-pill state-${c.suspended ? 'suspended' : c.state}">${c.suspended ? 'suspended' : c.state}</span><br>${c.state === 'new' ? esc(dk?.name || '') : `due ${fmtDue(c.due, now)}`}</span>
      </button>`; }).join('') : `<div class="empty"><h3>No cards match</h3>Try a different search or deck.</div>`}
      ${list.length > shown.length ? `<div class="empty" style="padding:14px">Showing the first ${shown.length} of ${list.length}. Narrow the search to see the rest.</div>` : ''}
    </div>
  </div>`;
}

// ------------------------------------------------------------ Stats
function viewStats(){
  const now = Date.now(), cards = [...store.cards.values()];
  const st = todayStat(now), s = streak(now);
  // Retention over the last 30 days: share of non-Again answers.
  let tot = 0, ok = 0, ms = 0; for (let i = 0; i < 30; i++){ const x = store.stats.get(dayKey(now - i*DAY)); if (x){ tot += x.reviews; ok += x.reviews - (x.again||0); ms += x.timeMs||0; } }
  const ret = tot ? Math.round(ok/tot*100) : null;
  const byState = { new: 0, learning: 0, review: 0 }; for (const c of cards) byState[c.state === 'relearning' ? 'learning' : c.state] = (byState[c.state === 'relearning' ? 'learning' : c.state]||0) + 1;
  // Heatmap: 20 weeks ending this week.
  const weeks = 20, cells = []; const today = dayStart(now); const dow = (new Date(today).getDay() + 6) % 7; // Monday=0
  const start = today - (weeks*7 - 1 - (6 - dow)) * DAY; let max = 1;
  for (let i = 0; i < weeks*7; i++){ const t = start + i*DAY; const v = t > today ? -1 : (store.stats.get(dayKey(t))?.reviews || 0); if (v > max) max = v; cells.push({ t, v }); }
  const lvl = v => v <= 0 ? 0 : Math.max(1, Math.ceil(v / max * 4));
  // Forecast: review cards due over the next 30 days.
  const fc = new Array(30).fill(0); for (const c of cards){ if (c.state === 'review' && !c.suspended){ const d = clamp(daysBetween(now, c.due), 0, 29); fc[d]++; } }
  const fmax = Math.max(1, ...fc);
  const W = 600, H = 120, bw = W/30;
  const bars = fc.map((v, i) => `<rect class="bar" x="${(i*bw+1).toFixed(1)}" y="${(H - v/fmax*H).toFixed(1)}" width="${(bw-2).toFixed(1)}" height="${(v/fmax*H).toFixed(1)}" rx="3"><title>${new Date(dayStart(now)+i*DAY).toLocaleDateString(undefined,{month:'short',day:'numeric'})}: ${v} due</title></rect>`).join('');
  const total = cards.length || 1;
  return `<div class="view">
    <div><div class="eyebrow">Stats</div><h1 class="title">${tot ? `${ret}% remembered over 30 days.` : 'Your memory, measured.'}</h1><p class="sub">The scheduler aims for ${Math.round(store.settings.desiredRetention*100)}% recall at review time. Landing near that number means the intervals fit you.</p></div>
    <div class="tiles">
      <div class="card-panel tile"><span class="v">${st.reviews}</span><span class="l">reviewed today</span></div>
      <div class="card-panel tile"><span class="v">${s}</span><span class="l">day streak</span></div>
      <div class="card-panel tile"><span class="v">${ret == null ? '–' : ret + '%'}</span><span class="l">30-day recall</span></div>
      <div class="card-panel tile"><span class="v">${tot ? (ms/tot/1000).toFixed(1) + 's' : '–'}</span><span class="l">per card</span></div>
    </div>
    <div class="card-panel" style="padding:18px 20px">
      <div class="section-h" style="margin-bottom:12px"><h2>Reviews, last 20 weeks</h2><span class="hint mono">${cells.reduce((a,c)=>a+Math.max(0,c.v),0)} total</span></div>
      <div class="heat">${cells.map(c => `<i data-l="${lvl(c.v)}" title="${new Date(c.t).toLocaleDateString()}: ${c.v < 0 ? '' : c.v + ' reviews'}"></i>`).join('')}</div>
    </div>
    <div class="card-panel" style="padding:18px 20px">
      <div class="section-h" style="margin-bottom:12px"><h2>Due in the next 30 days</h2><span class="hint mono">${fc.reduce((a,b)=>a+b,0)} reviews</span></div>
      <svg class="chart" viewBox="0 -4 ${W} ${H+22}" preserveAspectRatio="none"><line class="grid" x1="0" y1="0" x2="${W}" y2="0"/><line class="grid" x1="0" y1="${H/2}" x2="${W}" y2="${H/2}"/>${bars}<text x="2" y="${H+16}">today</text><text x="${W/2}" y="${H+16}" text-anchor="middle">+15d</text><text x="${W-2}" y="${H+16}" text-anchor="end">+30d</text><text x="${W-2}" y="10" text-anchor="end">${fmax}</text></svg>
    </div>
    <div class="card-panel" style="padding:18px 20px">
      <div class="section-h" style="margin-bottom:12px"><h2>Card states</h2><span class="hint mono">${cards.length} cards</span></div>
      <div class="stack"><i style="width:${byState.new/total*100}%;background:var(--easy)"></i><i style="width:${byState.learning/total*100}%;background:var(--again)"></i><i style="width:${byState.review/total*100}%;background:var(--good)"></i></div>
      <div class="legend" style="margin-top:10px"><span><i style="background:var(--easy)"></i>new ${byState.new}</span><span><i style="background:var(--again)"></i>learning ${byState.learning}</span><span><i style="background:var(--good)"></i>review ${byState.review}</span></div>
    </div>
  </div>`;
}

// ------------------------------------------------------------ Settings
function viewSettings(){
  const S = store.settings;
  return `<div class="view">
    <div><div class="eyebrow">Settings</div><h1 class="title">Tune the scheduler.</h1><p class="sub">Defaults match Anki's. Raising desired recall means more frequent reviews; lowering it means fewer reviews and more forgetting.</p></div>
    <div class="card-panel">
      <div class="setting"><div><div>Desired recall at review time</div><div class="d">Anki default 90%. Sensible range 80–95%.</div></div><div class="row"><input type="range" id="sRet" min="70" max="97" value="${Math.round(S.desiredRetention*100)}"><span class="mono" id="sRetV" style="width:4ch;text-align:right">${Math.round(S.desiredRetention*100)}%</span></div></div>
      <div class="setting"><div><div>New cards per day</div><div class="d">Each new card adds roughly 5–8 reviews over the following weeks.</div></div><input type="number" id="sNew" min="0" max="999" value="${S.newPerDay}"></div>
      <div class="setting"><div><div>Maximum reviews per day</div></div><input type="number" id="sRev" min="0" max="9999" value="${S.reviewsPerDay}"></div>
      <div class="setting"><div><div>Learning steps (minutes)</div><div class="d">Short repeats before a new card graduates.</div></div><input type="text" id="sSteps" value="${S.learningSteps.join(' ')}"></div>
      <div class="setting"><div><div>Relearning steps (minutes)</div><div class="d">After you press Again on a review card.</div></div><input type="text" id="sRSteps" value="${S.relearningSteps.join(' ')}"></div>
      <div class="setting"><div><div>Maximum interval (days)</div></div><input type="number" id="sMax" min="1" max="36500" value="${S.maxInterval}"></div>
      <div class="setting"><div><div>Spread reviews across days</div><div class="d">Adds small random variation to intervals so due cards don't clump.</div></div><input type="checkbox" id="sFuzz" ${S.fuzz ? 'checked' : ''}></div>
    </div>
    <div class="row"><button class="btn primary" id="saveSettings">Save settings</button></div>
    <div class="section-h"><h2>Your data</h2></div>
    <div class="card-panel">
      <div class="setting"><div><div>Back up everything</div><div class="d">A JSON file with every deck, card, and review count. Keep a copy somewhere safe.</div></div><button class="btn sm" id="exportBtn">Save backup…</button></div>
      <div class="setting"><div><div>Restore from a backup</div><div class="d">Adds or updates the cards in the file. Nothing is deleted.</div></div><label class="btn sm" for="importFile" style="cursor:pointer">Restore backup…<input type="file" id="importFile" accept="application/json,.json" hidden></label></div>
      <div class="setting"><div><div>Where this is stored</div><div class="d mono" style="overflow-wrap:anywhere">${store.mode === 'desktop' ? esc(store.dataFile || '') : 'This browser only.'}</div></div><span class="chip ${store.mode==='desktop'?'accent':''}">${store.mode === 'desktop' ? 'on disk' : 'browser'}</span></div>
    </div>
    <p class="hint">Scheduling uses FSRS-6, the same algorithm as Anki 25+, with its published default parameters. Day rollover is 4 am, like Anki.</p>
  </div>`;
}
function parseSteps(s){ return s.split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n > 0); }

// ------------------------------------------------------------ dialogs
function openDialog(html){ const d = $('#dlg'); d.innerHTML = `<div class="dlg">${html}</div>`; if (!d.open) d.showModal(); }
function closeDialog(){ const d = $('#dlg'); if (d.open) d.close(); d.innerHTML = ''; }
function openCardDialog(c){
  const dk = store.decks.get(c.deckId);
  openDialog(`<h3>Edit card</h3>
    <div class="field"><label for="eDeck">Deck</label><select class="input" id="eDeck">${deckOptions(c.deckId)}</select></div>
    <div class="field"><label for="eFront">${c.type === 'cloze' ? 'Text with {{c1::blanks}}' : 'Front'}</label><textarea class="input" id="eFront" rows="3">${esc(c.front)}</textarea></div>
    ${c.type === 'cloze' ? '' : `<div class="field"><label for="eBack">Back</label><textarea class="input" id="eBack" rows="3">${esc(c.back)}</textarea></div>`}
    <div class="field"><label for="eExtra">Extra</label><input class="input" id="eExtra" value="${esc(c.extra||'')}"></div>
    <div class="hint mono">${c.state} · ${c.reps||0} reviews · ${c.lapses||0} lapses${c.S ? ` · stability ${fmtIvl(c.S)}` : ''}${c.pairId ? ' · part of a vocabulary pair' : ''}${c.noteId ? ' · one of several blanks from one note' : ''}</div>
    <div class="dlg-actions">
      <span class="row" style="gap:6px;flex-wrap:wrap"><button class="btn ghost sm" id="eSusp">${c.suspended ? 'Unsuspend' : 'Suspend'}</button><button class="btn ghost sm" id="eReset">Reset progress</button><button class="btn danger sm" id="eDel">Delete</button></span>
      <span class="row" style="gap:6px"><button class="btn sm" id="eCancel">Cancel</button><button class="btn primary sm" id="eSave">Save</button></span>
    </div>`);
  $('#eCancel').onclick = closeDialog;
  $('#eSave').onclick = async () => { const upd = { ...c, deckId: $('#eDeck').value, front: $('#eFront').value.trim(), extra: $('#eExtra').value.trim() }; if (c.type !== 'cloze') upd.back = $('#eBack').value.trim(); await store.put('cards', upd); closeDialog(); toast('Saved'); if (state.review){ state.review.outcomes = null; } render(); };
  $('#eSusp').onclick = async () => { await store.put('cards', { ...c, suspended: !c.suspended }); closeDialog(); toast(c.suspended ? 'Unsuspended' : 'Suspended'); if (state.review && state.review.current === c.id){ state.review.current = null; state.review.flipped = false; } render(); };
  $('#eReset').onclick = async () => { if (!(await ask('Reset this card to new? Its review history is kept.'))) return; await store.put('cards', { ...c, state: 'new', remaining: 0, due: 0, S: 0, D: 0, ivl: 0, lastReview: 0, leech: false }); closeDialog(); toast('Reset to new'); if (state.review){ state.review.outcomes = null; } render(); };
  $('#eDel').onclick = async () => { if (!(await ask('Delete this card permanently?'))) return; await store.remove('cards', c.id); closeDialog(); toast('Deleted'); if (state.review && state.review.current === c.id){ state.review.current = null; state.review.flipped = false; } render(); };
}
function openDeckDialog(dk){
  const isNew = !dk; const d = dk || { id: uid('d'), name: '', color: DECK_COLORS[store.decks.size % DECK_COLORS.length], createdAt: Date.now(), order: store.decks.size };
  const n = isNew ? 0 : [...store.cards.values()].filter(c => c.deckId === d.id).length;
  openDialog(`<h3>${isNew ? 'New deck' : 'Deck'}</h3>
    <div class="field"><label for="dName">Name</label><input class="input" id="dName" value="${esc(d.name)}" placeholder="e.g. Biology 101" autofocus></div>
    <div class="field"><label>Color</label><div class="row" style="gap:8px;flex-wrap:wrap" id="dColors">${DECK_COLORS.map(cl => `<button data-color="${cl}" aria-pressed="${cl===d.color}" style="width:28px;height:28px;border-radius:8px;background:${cl};outline:${cl===d.color ? '3px solid var(--ink)' : 'none'};outline-offset:2px" aria-label="${cl}"></button>`).join('')}</div></div>
    <div class="dlg-actions">
      <span>${isNew ? '' : `<button class="btn danger sm" id="dDel">Delete deck${n ? ` and ${n} cards` : ''}</button>`}</span>
      <span class="row" style="gap:6px"><button class="btn sm" id="dCancel">Cancel</button><button class="btn primary sm" id="dSave">${isNew ? 'Create' : 'Save'}</button></span>
    </div>`);
  let color = d.color;
  $('#dColors').onclick = e => { const b = e.target.closest('[data-color]'); if (!b) return; color = b.dataset.color; $$('#dColors button').forEach(x => { x.style.outline = x.dataset.color === color ? '3px solid var(--ink)' : 'none'; x.setAttribute('aria-pressed', x.dataset.color === color); }); };
  $('#dCancel').onclick = closeDialog;
  $('#dName').onkeydown = e => { if (e.key === 'Enter') $('#dSave').click(); };
  $('#dSave').onclick = async () => { const name = $('#dName').value.trim(); if (!name){ $('#dName').focus(); return; } await store.put('decks', { ...d, name, color }); closeDialog(); toast(isNew ? 'Deck created' : 'Saved'); render(); };
  const del = $('#dDel'); if (del) del.onclick = async () => { if (!(await ask(`Delete "${d.name}"${n ? ` and its ${n} cards` : ''}? This cannot be undone.`))) return; for (const c of [...store.cards.values()]) if (c.deckId === d.id) await store.remove('cards', c.id); await store.remove('decks', d.id); closeDialog(); toast('Deck deleted'); state.deckFilter = null; render(); };
  setTimeout(() => $('#dName')?.focus(), 30);
}
$('#dlg').addEventListener('click', e => { if (e.target === e.currentTarget) closeDialog(); });

// ------------------------------------------------------------ wiring
async function importBackup(f){
  try { const j = JSON.parse(await f.text()); let n = 0;
    for (const d of j.decks || []) if (d.id && d.name) await store.put('decks', d);
    for (const c of j.cards || []) if (c.id && c.deckId){ if (!store.decks.has(c.deckId)){ toast(`Skipped a card for unknown deck "${c.deckId}"`); continue; } await store.put('cards', c); n++; }
    for (const s of j.stats || []) if (s.id) await store.put('stats', s);
    if (j.settings) await store.saveSettings(j.settings);
    toast(`Restored ${n} ${n===1?'card':'cards'}`); render();
  } catch { toast('That file is not an Ember backup.'); }
}
function afterRender(){
  const m = $('#main');
  const on = (sel, ev, fn) => { const el = $(sel, m); if (el) el.addEventListener(ev, fn); };
  on('#startAll', 'click', () => startReview(null));
  on('#newDeck', 'click', () => openDeckDialog(null));
  $$('[data-deck-edit]', m).forEach(el => { const h = e => { e.stopPropagation(); e.preventDefault(); openDeckDialog(store.decks.get(el.dataset.deckEdit)); }; el.addEventListener('click', h); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') h(e); }); });
  $$('.deck-row', m).forEach(el => el.addEventListener('click', e => { if (e.target.closest('[data-deck-edit]')) return; const id = el.dataset.deck; const c = deckCounts(id, Date.now()); if (c.learn + c.review + c.fresh) startReview(id); else { toast('Nothing due in this deck. Add cards or wait for the next review.'); } }));
  // review
  on('#flip', 'click', () => { state.review.flipped = true; render(); });
  $$('[data-rate]', m).forEach(b => b.addEventListener('click', () => rate(+b.dataset.rate)));
  on('#editCur', 'click', () => { const c = store.cards.get(state.review?.current); if (c) openCardDialog(c); });
  on('#undoBtn', 'click', undo);
  // add
  $$('[data-addtab]', m).forEach(b => b.addEventListener('click', () => { state.addTab = b.dataset.addtab; render(); }));
  on('#qaText', 'input', e => { state.gen.qaText = e.target.value; });
  on('#qaDeck', 'change', e => { state.gen.deck = e.target.value; });
  on('#qaMode', 'change', e => { state.gen.qaMode = e.target.value; });
  on('#qaAdd', 'click', async () => { const notes = parseQuick($('#qaText').value, $('#qaMode').value); if (!notes.length){ toast('Type at least one line.'); return; } const n = await addNotes($('#qaDeck').value, notes); state.gen.qaText = ''; toast(`Added ${n} ${n===1?'card':'cards'}`); render(); });
  // browse
  on('#bq', 'input', e => { state.browse.q = e.target.value; const pos = e.target.selectionStart; render(); const el = $('#bq'); el.focus(); el.setSelectionRange(pos, pos); });
  on('#bdeck', 'change', e => { state.browse.deck = e.target.value; render(); });
  on('#bstate', 'change', e => { state.browse.state = e.target.value; render(); });
  $$('[data-card]', m).forEach(b => b.addEventListener('click', () => openCardDialog(store.cards.get(b.dataset.card))));
  // settings
  on('#sRet', 'input', e => { $('#sRetV').textContent = e.target.value + '%'; });
  on('#saveSettings', 'click', async () => {
    const s = { desiredRetention: clamp(+$('#sRet').value/100, 0.7, 0.97), newPerDay: clamp(+$('#sNew').value||0, 0, 999), reviewsPerDay: clamp(+$('#sRev').value||0, 0, 9999), learningSteps: parseSteps($('#sSteps').value), relearningSteps: parseSteps($('#sRSteps').value), maxInterval: clamp(+$('#sMax').value||36500, 1, 36500), fuzz: $('#sFuzz').checked };
    await store.saveSettings(s); toast('Settings saved'); render();
  });
  on('#exportBtn', 'click', async () => {
    const data = store.snapshot(), filename = `ember-backup-${dayKey(Date.now())}.json`, T = store.tauri;
    if (T?.dialog){ try { const p = await T.dialog.save({ defaultPath: filename, filters: [{ name: 'Ember backup', extensions: ['json'] }] }); if (p){ await T.fs.writeTextFile(p, data); toast('Backup saved'); } } catch (e){ console.warn(e); toast('Could not save the backup.'); } }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
  });
  const imp = async e => { const f = e.target.files[0]; if (!f) return; await importBackup(f); e.target.value = ''; };
  on('#importFile', 'change', imp); on('#importFile2', 'change', imp);
  on('#copyDeckIds', 'click', async () => { const txt = [...store.decks.values()].map(d => `${d.name} → deckId "${d.id}"`).join('\n'); try { await navigator.clipboard.writeText(`My Ember decks:\n${txt}\n\nPlease give me an Ember backup .json file: {"app":"ember","version":1,"cards":[...]} where each card has id, deckId, type ("basic" or "cloze"), front, back, extra, createdAt, state "new", remaining 0, due 0, S 0, D 0, reps 0, lapses 0, lastReview 0, ivl 0, suspended false, leech false, history [].`); toast('Deck list copied. Paste it into your assistant.'); } catch { toast('Could not copy.'); } });
}

// ------------------------------------------------------------ boot
(function boot(){
  const h = location.hash.replace('#', ''); if (['today','decks','add','browse','stats','settings'].includes(h)) state.view = h;
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) store.flush(); });
  render();
  store.init().then(() => { render(); });
  // Re-render Today periodically so learning cards surface as they come due.
  setInterval(() => { if (state.view === 'today' && store.ready) render(); }, 60000);
})();
