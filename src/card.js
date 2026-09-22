/*
 * ha-bracket-card — a reusable double-elimination bracket for Home Assistant.
 *
 * Frontend-only custom Lovelace card. All state lives in a single `input_text`
 * (or `text`) helper as a compact JSON string; the full match graph is
 * regenerated deterministically from the player list, so what we persist stays
 * small. Tap a name to advance them. One button starts a fresh bracket.
 *
 * Config:
 *   type: custom:bracket-card
 *   entity: input_text.game_night_bracket   # required, a text helper you own
 *   title: Game Night                         # optional
 *   reset_bracket: true                       # optional, grand-final reset game
 */

import {
  generateBracket, setWinner, champion, slotLabel, resolve, isBye,
} from './bracket.js';

const CARD_VERSION = '1.1.0';

/* ---------- compact persistence ---------- */
// Persisted form: {"v":2,"p":[names],"w":"codes","x":0|1}
// `w` is one char per match in canonical order: '0' undecided, '1' p1, '2' p2.

function encodeState(players, resetBracket, decisions) {
  // Rebuild to obtain canonical order, then emit codes for user decisions only.
  const s = rebuild(players, resetBracket, decisions);
  let w = '';
  for (const id of s.order) {
    const d = decisions[id];
    w += d === 'p1' ? '1' : d === 'p2' ? '2' : '0';
  }
  return JSON.stringify({ v: 2, p: players, w, x: resetBracket ? 1 : 0 });
}

function decodeState(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'unknown' || trimmed === 'unavailable') return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch (e) { return null; }
  if (!obj || !Array.isArray(obj.p) || obj.p.length < 2) return null;
  const resetBracket = obj.x !== 0;
  // Map winners string back to a decisions object using a fresh graph's order.
  const fresh = generateBracket(obj.p, { resetBracket });
  const decisions = {};
  const w = typeof obj.w === 'string' ? obj.w : '';
  fresh.order.forEach((id, i) => {
    const c = w[i];
    if (c === '1') decisions[id] = 'p1';
    else if (c === '2') decisions[id] = 'p2';
  });
  return { players: obj.p, resetBracket, decisions };
}

/* ---------- rebuild from decisions ---------- */
// Regenerate the graph and replay user decisions in canonical (topological)
// order. Byes auto-resolve; invalid decisions (slot no longer a real player)
// are dropped. Returns a fully resolved state.
function rebuild(players, resetBracket, decisions) {
  const s = generateBracket(players, { resetBracket });
  for (const id of s.order) {
    const d = decisions[id];
    if (d !== 'p1' && d !== 'p2') continue;
    const m = s.matches[id];
    if (!m || m.winner) continue;              // already auto-decided (bye) -> skip
    if (!isRealPlayer(m.p1) || !isRealPlayer(m.p2)) continue;
    setWinner(s, id, d);
  }
  resolve(s);
  return s;
}

function isRealPlayer(ref) { return ref && ref.type === 'player'; }

// Fisher-Yates, in place.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// All matches reachable downstream of `matchId` via winner/loser routing,
// plus the grand-final reset game. Used to clear stale results on a re-pick.
function descendants(state, matchId) {
  const out = new Set();
  const stack = [matchId];
  while (stack.length) {
    const cur = state.matches[stack.pop()];
    if (!cur) continue;
    for (const link of [cur.winnerTo, cur.loserTo]) {
      if (link && link.match && !out.has(link.match)) {
        out.add(link.match);
        stack.push(link.match);
      }
    }
  }
  if (matchId === 'GF-1' && state.matches['GF-2']) out.add('GF-2');
  out.delete(matchId);
  return out;
}

/* ---------- the card ---------- */
class BracketCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._lastRaw = undefined;
    this._draft = '';       // setup textarea contents
    this._confirmReset = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error('bracket-card: you must set an "entity" (an input_text or text helper).');
    }
    if (!/^(input_text|text)\./.test(config.entity)) {
      throw new Error('bracket-card: "entity" must be an input_text or text helper.');
    }
    this._config = { reset_bracket: true, ...config };
    this._lastRaw = undefined;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    const st = hass.states[this._config.entity];
    const raw = st ? st.state : undefined;
    if (first || raw !== this._lastRaw) {
      this._lastRaw = raw;
      this._render();
    }
  }

  getCardSize() { return 8; }

  /* --- persistence helper --- */
  // `input_text` and `text` entities are written with different services;
  // the domain of the configured entity decides which.
  _setValue(value) {
    const domain = this._config.entity.split('.')[0];
    this._hass.callService(domain, 'set_value', {
      entity_id: this._config.entity,
      value,
    });
  }

  _save(players, resetBracket, decisions) {
    const value = encodeState(players, resetBracket, decisions);
    this._lastRaw = value; // optimistic; avoids a flash before HA echoes back
    this._setValue(value);
    this._render(); // optimistic; HA will echo the same value and be a no-op
  }

  _clear() {
    this._confirmReset = false;
    this._lastRaw = '';
    this._setValue('');
    this._render();
  }

  /* --- actions --- */
  _createFromDraft() {
    const names = this._draft.split('\n').map((n) => n.trim()).filter(Boolean);
    if (names.length < 2) { this._flash('Enter at least two players (one per line).'); return; }
    if (names.length > 64) { this._flash('That is a lot of players — cap is 64.'); return; }
    const resetBracket = this._config.reset_bracket !== false;
    // Entry order is seeding order, and a typed list is rarely random — so
    // shuffle once here. The shuffled order is what gets stored, so the
    // bracket is stable from then on.
    shuffle(names);
    const value = encodeState(names, resetBracket, {});
    if (value.length > 255 && /^input_text\./.test(this._config.entity)) {
      this._flash('Too much data for a 255-char input_text. Use shorter names, fewer players, or a "text" helper with a higher max.');
      return;
    }
    this._save(names, resetBracket, {});
  }

  _pick(matchId, side) {
    const decoded = decodeState(this._lastRaw);
    if (!decoded) return;
    const { players, resetBracket } = decoded;
    const decisions = { ...decoded.decisions };
    const s = rebuild(players, resetBracket, decisions);
    const m = s.matches[matchId];
    if (!m || !isRealPlayer(m[side])) return;

    // Re-pick: if this match was already decided differently, clear downstream.
    if (decisions[matchId] && decisions[matchId] !== side) {
      for (const d of descendants(s, matchId)) delete decisions[d];
    }
    decisions[matchId] = side;
    this._save(players, resetBracket, decisions);
  }

  _flash(msg) {
    this._msg = msg;
    this._render();
    setTimeout(() => { this._msg = null; this._render(); }, 4000);
  }

  /* --- rendering --- */
  _render() {
    if (!this.shadowRoot) return;
    if (!this._config) { this.shadowRoot.innerHTML = ''; return; }
    const title = this._config.title || 'Tournament Bracket';
    const decoded = this._hass ? decodeState(this._lastRaw) : null;

    const style = STYLE;
    let body;
    if (!this._hass) {
      body = `<div class="pad muted">Loading…</div>`;
    } else if (!this._hass.states[this._config.entity]) {
      body = `<div class="pad err">Helper <code>${esc(this._config.entity)}</code> not found. Create the input_text helper first.</div>`;
    } else if (!decoded) {
      body = this._setupView();
    } else {
      body = this._bracketView(decoded);
    }

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="hdr">
          <div class="title">${esc(title)}</div>
          ${decoded ? `<button class="ghost" id="new">New bracket</button>` : ``}
        </div>
        ${this._msg ? `<div class="flash">${esc(this._msg)}</div>` : ``}
        ${this._confirmReset ? `
          <div class="confirm">
            <span>Clear this bracket and start over?</span>
            <button class="danger" id="do-reset">Yes, clear</button>
            <button class="ghost" id="cancel-reset">Cancel</button>
          </div>` : ``}
        ${body}
        <div class="foot">bracket-card v${CARD_VERSION}</div>
      </ha-card>
      <style>${style}</style>
    `;

    this._wire(decoded);

    // Connector lines are measured from laid-out positions, so they can only
    // be drawn once the browser has done layout.
    // Measuring forces layout, so the lines can be drawn right away; the
    // next-frame pass catches late font metrics, and the observer handles
    // resizes (e.g. the sidebar opening).
    this._drawLines();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this._drawLines());
    this._observeResize();
  }

  // Every render replaces the DOM, so re-point the observer at the new element.
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    if (this._ro) this._ro.disconnect();
    const wrap = this.shadowRoot.querySelector('.bracket');
    if (!wrap) return;
    this._ro = this._ro || new ResizeObserver(() => this._drawLines());
    this._ro.observe(wrap);
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  _setupView() {
    return `
      <div class="pad">
        <p class="muted">Enter players, one per line. A double-elimination bracket is built automatically (odd counts get byes).</p>
        <textarea id="draft" rows="8" placeholder="Alice&#10;Bob&#10;Charlie&#10;Dana">${esc(this._draft)}</textarea>
        <div class="row">
          <button class="primary" id="create">Create bracket</button>
        </div>
      </div>`;
  }

  _bracketView(decoded) {
    const { players, resetBracket, decisions } = decoded;
    const s = rebuild(players, resetBracket, decisions);
    this._state = s; // _drawLines reads winnerTo routing from here
    const champ = champion(s);

    const groups = { W: {}, L: {} };
    let gf1 = null, gf2 = null;
    for (const id of s.order) {
      const m = s.matches[id];
      if (m.bracket === 'GF') { if (m.id === 'GF-1') gf1 = m; else gf2 = m; continue; }
      (groups[m.bracket][m.round] ||= []).push(m);
    }

    const champBanner = champ
      ? `<div class="champ">🏆 Champion: <strong>${esc(champ.name)}</strong></div>`
      : ``;

    // Every column stretches to the section's height and spreads its matches
    // evenly, so a match in round r+1 sits centred between the two that feed
    // it. Hidden (bye-vs-bye) matches keep their slot so that stays true.
    const section = (label, roundsObj, cls) => {
      const rounds = Object.keys(roundsObj).map(Number).sort((a, b) => a - b);
      if (!rounds.length) return '';
      const cols = rounds.map((r) => `
        <div class="col">
          <div class="col-h">${roundName(cls, r, rounds.length)}</div>
          <div class="col-body">${roundsObj[r].map((m) => this._matchHtml(m)).join('')}</div>
        </div>`).join('');
      return `<div class="section ${cls}"><div class="sec-h ${cls}">${label}</div><div class="cols">${cols}</div></div>`;
    };

    // The reset game only exists once the losers-bracket entrant has won GF-1.
    const showGf2 = gf2 && (isRealPlayer(gf2.p1) || isRealPlayer(gf2.p2));
    const gfCol = `
      <div class="gf-col">
        <div class="sec-h gf">Grand Final</div>
        <div class="gf-body">
          ${gf1 ? this._matchHtml(gf1) : ''}
          ${showGf2 ? this._matchHtml(gf2, 'Reset game') : ''}
        </div>
      </div>`;

    return `
      ${champBanner}
      <div class="scroll">
        <div class="bracket">
          <svg class="lines" aria-hidden="true"></svg>
          <div class="left">
            ${section('Winners Bracket', groups.W, 'wb')}
            ${section('Losers Bracket', groups.L, 'lb')}
          </div>
          ${gfCol}
        </div>
      </div>`;
  }

  _matchHtml(m, tag = '') {
    // A match with a bye on both sides is scaffolding, not a game: it exists
    // so the tree stays a power of two. Keep its slot (for centring) but
    // don't show it.
    const hidden = m.winner === 'bye' || (isBye(m.p1) && isBye(m.p2));
    const row = (side) => {
      const ref = m[side];
      const label = slotLabel(ref) || '&nbsp;';
      const real = isRealPlayer(ref);
      const isWinner = m.winner === side;
      const isLoser = m.winner && m.winner !== side && m.winner !== 'bye';
      const cls = ['p', real ? 'real' : 'empty', isWinner ? 'win' : '', isLoser ? 'lose' : '']
        .join(' ').trim();
      const clickable = real && !isWinner && isRealPlayer(m.p1) && isRealPlayer(m.p2);
      return `<div class="${cls}" data-match="${m.id}" data-side="${side}" data-click="${clickable ? 1 : 0}">
                <span class="nm">${label}</span>${isWinner ? '<span class="chk">✓</span>' : ''}
              </div>`;
    };
    return `<div class="match${hidden ? ' hidden' : ''}" data-id="${m.id}">
      ${tag ? `<div class="mtag">${esc(tag)}</div>` : ''}
      ${row('p1')}
      <div class="vs"></div>
      ${row('p2')}
    </div>`;
  }

  /*
   * Draw the connectors as one SVG path over the bracket, measured from where
   * the matches actually landed. Measuring (rather than a pure-CSS bracket)
   * is what lets the lines survive hidden bye matches and the losers
   * bracket's uneven wiring, and lets both finals converge on the grand
   * final off to the right.
   */
  _drawLines() {
    const root = this.shadowRoot;
    const wrap = root && root.querySelector('.bracket');
    const svg = root && root.querySelector('svg.lines');
    const st = this._state;
    if (!wrap || !svg || !st) return;

    const els = new Map();
    wrap.querySelectorAll('.match[data-id]').forEach((el) => els.set(el.dataset.id, el));
    const visible = (id) => {
      const el = els.get(id);
      return el && !el.classList.contains('hidden') ? el : null;
    };

    const origin = wrap.getBoundingClientRect();
    const segs = [];
    const link = (fromId, toId) => {
      const a = visible(fromId), b = visible(toId);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - origin.left, y1 = ra.top + ra.height / 2 - origin.top;
      const x2 = rb.left - origin.left, y2 = rb.top + rb.height / 2 - origin.top;
      if (x2 <= x1) return; // never draw backwards (e.g. a WB loser dropping down)
      const xm = x1 + (x2 - x1) / 2;
      segs.push(`M${x1},${y1}H${xm}V${y2}H${x2}`);
    };

    for (const id of st.order) {
      const m = st.matches[id];
      if (m.winnerTo) link(id, m.winnerTo.match);
    }
    // GF-1 -> GF-2 has no routing entry (it's created on demand), so add it.
    if (visible('GF-2')) link('GF-1', 'GF-2');

    svg.setAttribute('width', wrap.scrollWidth);
    svg.setAttribute('height', wrap.scrollHeight);
    svg.innerHTML = `<path d="${segs.join(' ')}" fill="none" stroke="var(--divider-color, #9e9e9e)" stroke-width="2" stroke-linejoin="round"/>`;
  }

  _wire(decoded) {
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    const newBtn = $('#new');
    if (newBtn) newBtn.onclick = () => { this._confirmReset = true; this._render(); };
    const doReset = $('#do-reset');
    if (doReset) doReset.onclick = () => this._clear();
    const cancel = $('#cancel-reset');
    if (cancel) cancel.onclick = () => { this._confirmReset = false; this._render(); };

    const draft = $('#draft');
    if (draft) draft.oninput = (e) => { this._draft = e.target.value; };
    const create = $('#create');
    if (create) create.onclick = () => this._createFromDraft();

    this.shadowRoot.querySelectorAll('[data-click="1"]').forEach((el) => {
      el.onclick = () => this._pick(el.getAttribute('data-match'), el.getAttribute('data-side'));
    });
  }
}

function roundName(cls, r, total) {
  if (cls === 'wb') {
    if (r === total) return 'WB Final';
    if (r === total - 1) return 'WB Semis';
    return 'WB R' + r;
  }
  if (cls === 'lb') {
    if (r === total) return 'LB Final';
    return 'LB R' + r;
  }
  return 'R' + r;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const STYLE = `
  :host { display:block; }
  ha-card { padding: 0 0 4px; overflow: hidden; }
  .hdr { display:flex; align-items:center; justify-content:space-between;
         padding: 14px 16px 6px; }
  .title { font-size: 1.25rem; font-weight: 600; color: var(--primary-text-color); }
  .pad { padding: 8px 16px 16px; }
  .muted { color: var(--secondary-text-color); }
  .err { color: var(--error-color, #db4437); }
  .foot { text-align:right; font-size: 10px; color: var(--disabled-text-color, #9e9e9e);
          padding: 2px 12px 2px; opacity:.7; }
  textarea { width:100%; box-sizing:border-box; font: inherit; padding:10px;
             border:1px solid var(--divider-color, #e0e0e0); border-radius:8px;
             background: var(--card-background-color); color: var(--primary-text-color);
             resize: vertical; }
  .row { margin-top:10px; display:flex; gap:8px; }
  button { font: inherit; cursor:pointer; border-radius: 999px; border: none;
           padding: 8px 16px; }
  .primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .ghost { background: transparent; color: var(--primary-color);
           border: 1px solid var(--divider-color, #e0e0e0); padding: 6px 12px; }
  .danger { background: var(--error-color, #db4437); color: #fff; }
  .flash { margin: 4px 16px; padding: 8px 12px; border-radius: 8px;
           background: var(--warning-color, #ffa600); color:#222; font-size:.9rem; }
  .confirm { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
             margin: 4px 16px 8px; padding:8px 12px; border-radius:8px;
             background: var(--secondary-background-color); }
  .champ { margin: 4px 16px 8px; padding: 10px 14px; border-radius: 10px;
           background: linear-gradient(90deg, var(--primary-color), transparent);
           color: var(--text-primary-color, #fff); font-size: 1.05rem; }
  .champ strong { font-weight: 700; }
  .scroll { overflow-x: auto; padding: 4px 12px 12px; }
  /* Layout: winners + losers stacked on the left, grand final centred on the
     right. Columns stretch to full height and space their matches evenly so
     each later round sits centred between the matches feeding it. */
  .bracket { position: relative; display: flex; align-items: stretch; gap: 28px;
             min-width: min-content; }
  .bracket .lines { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 0; }
  .left { display: flex; flex-direction: column; gap: 14px; }
  .section { display: flex; flex-direction: column; flex: 1; }
  .sec-h { font-size:.72rem; letter-spacing:.08em; text-transform:uppercase;
           font-weight:700; margin: 6px 4px 2px; color: var(--secondary-text-color); }
  .sec-h.wb { color: var(--primary-color); }
  .sec-h.lb { color: var(--accent-color, #ff9800); }
  .sec-h.gf { color: var(--success-color, #43a047); }
  .cols { display:flex; gap: 28px; align-items:stretch; flex: 1; }
  .col { display:flex; flex-direction:column; min-width: 132px; }
  .col-h { font-size:.7rem; color: var(--disabled-text-color, #9e9e9e);
           text-align:center; min-height: 1em; font-weight:600; margin-bottom: 4px; }
  .col-body { flex:1; display:flex; flex-direction:column; justify-content:space-around;
              gap: 12px; }
  .gf-col { display:flex; flex-direction:column; min-width: 132px; }
  .gf-body { flex:1; display:flex; flex-direction:column; justify-content:center; gap: 12px; }
  .match.hidden { visibility: hidden; }
  .match { position: relative; z-index: 1; border:1px solid var(--divider-color, #e0e0e0);
           border-radius: 8px; overflow: hidden; background: var(--card-background-color); }
  .mtag { font-size:.6rem; text-transform:uppercase; letter-spacing:.06em;
          text-align:center; padding:2px; color: var(--secondary-text-color);
          background: var(--secondary-background-color); }
  .p { display:flex; align-items:center; justify-content:space-between;
       padding: 8px 10px; font-size:.92rem; gap:6px;
       color: var(--primary-text-color); user-select:none; }
  .p .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .p.empty .nm { color: var(--disabled-text-color, #9e9e9e); font-style:italic; }
  .p[data-click="1"] { cursor:pointer; }
  .p[data-click="1"]:hover { background: var(--secondary-background-color); }
  .p.win { background: color-mix(in srgb, var(--primary-color) 16%, transparent);
           font-weight:700; }
  .p.win .chk { color: var(--primary-color); font-weight:700; }
  .p.lose .nm { color: var(--disabled-text-color, #9e9e9e); text-decoration: line-through; }
  .vs { height:1px; background: var(--divider-color, #e0e0e0); margin: 0 8px; }
`;

if (!customElements.get('bracket-card')) {
  customElements.define('bracket-card', BracketCard);
}

// Register in the card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'bracket-card',
  name: 'Bracket Card',
  description: 'Reusable double-elimination tournament bracket for game night.',
});

console.info(
  `%c BRACKET-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#3f51b5;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
  'color:#3f51b5;background:#eee;border-radius:0 3px 3px 0;padding:2px 4px'
);
