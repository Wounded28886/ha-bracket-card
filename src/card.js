/*
 * ha-bracket-card — a reusable game-night tournament card for Home Assistant.
 *
 * Frontend-only custom Lovelace card. All state lives in a single `input_text`
 * (or `text`) helper as a compact JSON string; the full tournament is
 * regenerated deterministically from the player list plus the decisions, so
 * what we persist stays small. Tap a name to advance them. One button starts
 * a fresh tournament.
 *
 * Formats: double elimination, single elimination, round robin, Swiss,
 * king of the hill and free-for-all (points race).
 *
 * Config:
 *   type: custom:bracket-card
 *   entity: input_text.game_night_bracket   # required, a text helper you own
 *   title: Game Night                         # optional
 *   reset_bracket: true                       # optional, grand-final reset game (double elim)
 *   default_game: Mario Kart                  # optional, pre-fills the Game box
 *   default_mode: double                      # optional, pre-selects the format
 *   ffa_points: [10, 7, 5, 3, 2, 1]           # optional, free-for-all points per place
 *   tracking: true                            # optional, record results in InfluxDB
 *
 * Tracking goes through two Home Assistant rest_commands (see README), because
 * a browser card can't talk to InfluxDB directly. `tracking: true` uses the
 * default service names; pass an object to override them:
 *   tracking:
 *     write_service: rest_command.game_night_write
 *     query_service: rest_command.game_night_query
 *     measurement: result
 *
 * A companion `custom:bracket-history-card` reads the same data back and shows
 * the current champion, past winners and a leaderboard.
 */

import {
  generateBracket, setWinner, champion, slotLabel, resolve, isBye, eliminationOrder,
} from './bracket.js';
import {
  roundRobin, swiss, kingOfTheHill, freeForAll, encodeFfaRound, standingsSummary,
  kothChallengerCode, KOTH_MAX_PLAYERS, kothSnapshot, kothRebase,
} from './formats.js';
import {
  belts, leaderboard, seasons, headToHead, rivalries, onThisDay, byFormat,
  biggestWins, ELO_START,
} from './stats.js';

const CARD_VERSION = '1.7.3';

/* ---------- formats ---------- */
// Mode is stored as a single character in the helper.
const MODES = {
  d: { label: 'Double elimination', tag: 'double_elimination', bracket: true,
       help: 'Lose twice and you are out. A losers bracket gives everyone a second chance.' },
  s: { label: 'Single elimination', tag: 'single_elimination', bracket: true,
       help: 'Lose once and you are out. Quickest format.' },
  r: { label: 'Round robin', tag: 'round_robin',
       help: 'Everyone plays everyone once. Most wins takes it; ties go to a decider.' },
  w: { label: 'Swiss system', tag: 'swiss',
       help: 'A fixed number of rounds; each round you play someone on the same record. Nobody is knocked out.' },
  k: { label: 'King of the hill', tag: 'king_of_the_hill',
       help: 'Nobody starts as king — the first game crowns one, then the winner stays on. Each game keeps one ongoing title you can carry on later.' },
  f: { label: 'Free-for-all', tag: 'free_for_all',
       help: 'Everyone plays at once (a race, a hand). Enter each round\u2019s finishing order; points decide it.' },
};
const MODE_ALIASES = {
  double: 'd', double_elimination: 'd', single: 's', single_elimination: 's',
  round_robin: 'r', roundrobin: 'r', rr: 'r', swiss: 'w', king_of_the_hill: 'k', koth: 'k',
  free_for_all: 'f', ffa: 'f', points: 'f',
};
function modeChar(v) {
  const s = String(v || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (MODES[s]) return s;
  return MODE_ALIASES[s] || 'd';
}

/* ---------- compact persistence ---------- */
// Persisted form:
//   {"v":2,"p":[names],"w":"codes","x":0|1,"m":"d","g":"game","c":epoch,"r":1,"d":"codes","f":1,"k":3}
// `w` holds the decisions: one char per match ('0' undecided, '1' p1, '2' p2)
// for bracket / round robin / Swiss and king of the hill, or the finishing
// orders for free-for-all. `m` mode (default double elim), `d` decider
// decisions for a tied round robin / Swiss, `f` finished (koth / ffa),
// `k` Swiss round count, `g` game, `c` created (epoch s), `r` recorded,
// `b` king-of-the-hill carry-over from an earlier session (see kothSnapshot),
// `t` this king-of-the-hill game is a one-off that doesn't touch the lineage.
// All but p/w are optional so brackets stored by older versions still decode.

function bracketOpts(d) {
  return { single: d.mode === 's', resetBracket: d.mode === 'd' && d.resetBracket };
}

function codesToDecisions(players, opts, w) {
  const decisions = {};
  const order = generateBracket(players, opts).order;
  order.forEach((id, i) => {
    const c = typeof w === 'string' ? w[i] : undefined;
    if (c === '1') decisions[id] = 'p1';
    else if (c === '2') decisions[id] = 'p2';
  });
  return decisions;
}

function decisionsToCodes(players, opts, decisions) {
  const s = rebuild(players, opts, decisions);
  let w = '';
  for (const id of s.order) {
    const d = decisions[id];
    w += d === 'p1' ? '1' : d === 'p2' ? '2' : '0';
  }
  return w;
}

function encodeState(d) {
  const out = { v: 2, p: d.players };
  out.w = MODES[d.mode].bracket ? decisionsToCodes(d.players, bracketOpts(d), d.decisions) : (d.w || '');
  out.x = d.resetBracket ? 1 : 0;
  if (d.mode !== 'd') out.m = d.mode;
  if (d.decider) out.d = d.decider;
  if (d.finished) out.f = 1;
  if (d.swissRounds) out.k = d.swissRounds;
  if (d.base) out.b = d.base;
  if (d.temp) out.t = 1;
  if (d.game) out.g = d.game;
  if (d.created) out.c = d.created;
  if (d.recorded) out.r = 1;
  return JSON.stringify(out);
}

function decodeState(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'unknown' || trimmed === 'unavailable') return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch (e) { return null; }
  if (!obj || !Array.isArray(obj.p) || obj.p.length < 2) return null;
  const d = {
    players: obj.p,
    mode: MODES[obj.m] ? obj.m : 'd',
    w: typeof obj.w === 'string' ? obj.w : '',
    resetBracket: obj.x !== 0,
    decider: typeof obj.d === 'string' ? obj.d : '',
    finished: obj.f === 1,
    swissRounds: Number.isInteger(obj.k) && obj.k > 0 ? obj.k : 0,
    base: obj.b && typeof obj.b === 'object' ? obj.b : null,
    temp: obj.t === 1,
    game: typeof obj.g === 'string' ? obj.g : '',
    created: Number.isFinite(obj.c) ? obj.c : 0,
    recorded: obj.r === 1,
  };
  d.decisions = MODES[d.mode].bracket ? codesToDecisions(d.players, bracketOpts(d), d.w) : {};
  return d;
}

/* ---------- rebuild from decisions ---------- */
// Regenerate the graph and replay user decisions in canonical (topological)
// order. Byes auto-resolve; invalid decisions (slot no longer a real player)
// are dropped. Returns a fully resolved state.
function rebuild(players, opts, decisions) {
  const s = generateBracket(players, opts);
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

/*
 * Turn a decoded state into what the views render. Every mode yields
 * { kind, champion, complete } plus its own data; a tied round robin / Swiss
 * also carries a single-elimination decider bracket among the tied players.
 */
function compute(d, config) {
  const mode = d.mode;
  if (MODES[mode].bracket) {
    const state = rebuild(d.players, bracketOpts(d), d.decisions);
    const c = champion(state);
    return { kind: 'bracket', state, champion: c, complete: !!c, standings: null };
  }
  let res;
  if (mode === 'r') res = roundRobin(d.players, d.w);
  else if (mode === 'w') res = swiss(d.players, d.w, { rounds: d.swissRounds || undefined });
  else if (mode === 'k') res = kingOfTheHill(d.players, d.w, d.finished, d.base);
  else res = freeForAll(d.players, d.w, d.finished, { points: config && config.ffa_points });
  if ((mode === 'r' || mode === 'w') && res.complete && res.tie) {
    const opts = { single: true, resetBracket: false };
    const decisions = codesToDecisions(res.tie, opts, d.decider);
    res.decider = rebuild(res.tie, opts, decisions);
    const c = champion(res.decider);
    if (c) res.champion = c;
  }
  return res;
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

// Apply a pick to a bracket's decisions object (main bracket or decider).
function pickInBracket(players, opts, decisions, matchId, side) {
  const s = rebuild(players, opts, decisions);
  const m = s.matches[matchId];
  if (!m || !isRealPlayer(m[side])) return false;
  // Re-pick: if this match was already decided differently, clear downstream.
  if (decisions[matchId] && decisions[matchId] !== side) {
    for (const x of descendants(s, matchId)) delete decisions[x];
  }
  decisions[matchId] = side;
  return true;
}

/*
 * Who finished where, best first — the one thing a season table can't be
 * built without. A bracket ranks by how long you lasted; every other format
 * already ends with a standings table. A tie broken by a decider puts the
 * champion first regardless, because that is who actually won.
 */
function finishingOrder(res) {
  const order = res.kind === 'bracket'
    ? eliminationOrder(res.state)
    : (res.standings || []).map((s) => s.name);
  const champ = res.champion && res.champion.name;
  if (!champ || order[0] === champ) return order;
  return [champ, ...order.filter((name) => name !== champ)];
}

/* ---------- result tracking (InfluxDB via rest_command) ---------- */
const TRACKING_DEFAULTS = {
  write_service: 'rest_command.game_night_write',
  query_service: 'rest_command.game_night_query',
  measurement: 'result',
};

function trackingConfig(config) {
  const t = config && config.tracking;
  if (!t) return null;
  const cfg = { ...TRACKING_DEFAULTS, ...(typeof t === 'object' ? t : {}) };
  if (!/^[A-Za-z0-9_]+$/.test(cfg.measurement)) {
    throw new Error('bracket-card: tracking.measurement may only contain letters, digits and _');
  }
  return cfg;
}

// InfluxDB line-protocol escaping.
const lpTag = (v) => String(v).replace(/[,= \\]/g, (c) => '\\' + c);
const lpStr = (v) => '"' + String(v).replace(/[\\"]/g, (c) => '\\' + c) + '"';

function resultLine(measurement, { game, mode, winner, runnerUp, players, created, standings, topWins, snapshot, sessions, games, temp, placings }) {
  const tags = `game=${lpTag(game || 'Untitled')},mode=${lpTag(MODES[mode].tag)}`;
  const fields = [
    `winner=${lpStr(winner)}`,
    `runner_up=${lpStr(runnerUp || '')}`,
    `players=${lpStr(players.join(', '))}`,
    `player_count=${players.length}i`,
  ];
  if (standings) fields.push(`standings=${lpStr(standings)}`);
  // The full finishing order, so a season table can award points by placing.
  if (placings && placings.length) fields.push(`placings=${lpStr(placings.join(', '))}`);
  if (Number.isInteger(topWins)) fields.push(`top_wins=${topWins}i`);
  // King of the hill lineages carry enough to be picked up again later.
  // A one-off game is flagged and carries no snapshot, so it is never
  // mistaken for the game's ongoing lineage.
  if (temp) fields.push('temp=true');
  if (snapshot) {
    fields.push(`state=${lpStr(JSON.stringify({ p: players, b: snapshot }))}`);
    fields.push(`sessions=${sessions}i`, `games=${games}i`, `last_played=${Math.floor(Date.now() / 1000)}i`);
  }
  // Timestamp = bracket creation (seconds), so re-recording a corrected result
  // overwrites the same point instead of adding a second one.
  return `${measurement},${tags} ${fields.join(',')} ${created}`;
}

// Call a "domain.service" and return its response (needs return_response).
async function callWithResponse(hass, service, data) {
  const [domain, name] = String(service).split('.');
  const res = await hass.callWS({
    type: 'call_service', domain, service: name, service_data: data, return_response: true,
  });
  const r = res && res.response ? res.response : res;
  if (r && typeof r.status === 'number' && r.status >= 400) {
    const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content || '');
    throw new Error(`HTTP ${r.status} ${body.slice(0, 120)}`);
  }
  return r;
}

// Parse an InfluxQL /query response into [{time, game, winner, ...}].
function parseInfluxRows(content) {
  const body = typeof content === 'string' ? JSON.parse(content) : content;
  if (body && body.error) throw new Error(body.error);
  const rows = [];
  for (const result of (body && body.results) || []) {
    if (result.error) throw new Error(result.error);
    for (const series of result.series || []) {
      for (const v of series.values || []) {
        const row = {};
        series.columns.forEach((c, i) => { row[c] = v[i]; });
        rows.push(row);
      }
    }
  }
  return rows;
}

function fmtDate(epochSec) {
  const d = new Date(epochSec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const modeLabelFromTag = (tag) => {
  for (const m of Object.values(MODES)) if (m.tag === tag) return m.label;
  return tag ? String(tag).replace(/_/g, ' ') : '';
};

const pct = (rate) => `${Math.round((rate || 0) * 100)}%`;

// Five dots, newest last: a run of form you can read without counting.
const formDots = (form) => (form || []).map((won) =>
  `<span class="dot${won ? ' won' : ''}" title="${won ? 'won' : 'played'}"></span>`).join('')
  || '<span class="muted tiny">—</span>';

const streakLine = (p) => (p.streak.kind === 'wins'
  ? `${p.streak.count} win${p.streak.count === 1 ? '' : 's'} in a row`
  : p.streak.count
    ? `${p.streak.count} event${p.streak.count === 1 ? '' : 's'} since a win`
    : 'no results yet')
  + (p.longestStreak > 1 ? ` · best run ${p.longestStreak}` : '');

// Only the noteworthy ends of the scale earn a badge in the table.
const streakBadge = (p) => {
  if (p.streak.kind === 'wins' && p.streak.count >= 2) {
    return ` <span class="badge hot" title="${p.streak.count} wins in a row">🔥${p.streak.count}</span>`;
  }
  if (p.streak.kind === 'drought' && p.streak.count >= 4) {
    return ` <span class="badge cold" title="${p.streak.count} events since a win">${p.streak.count} dry</span>`;
  }
  return '';
};

function ordinal(n) {
  const r = n % 100;
  if (r >= 11 && r <= 13) return n + 'th';
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
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
    this._game = '';        // setup game-name input
    this._mode = 'd';       // setup format select
    this._swissRounds = ''; // setup rounds input (Swiss), '' = automatic
    this._ffaOrder = [];    // free-for-all: finishing order being entered
    this._kothChallenger = null; // king of the hill: hand-picked next challenger
    this._pending = null;   // setup prompt: continue a lineage / confirm the roster
    this._confirmReset = false;
    this._confirmFinish = false;
    this._track = { busy: false, error: null };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error('bracket-card: you must set an "entity" (an input_text or text helper).');
    }
    if (!/^(input_text|text)\./.test(config.entity)) {
      throw new Error('bracket-card: "entity" must be an input_text or text helper.');
    }
    this._config = { reset_bracket: true, ...config };
    this._tracking = trackingConfig(this._config); // validates, throws on bad config
    if (!this._game && config.default_game) this._game = String(config.default_game);
    if (config.default_mode) this._mode = modeChar(config.default_mode);
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

  _save(decoded) {
    const value = encodeState(decoded);
    if (value.length > 255 && /^input_text\./.test(this._config.entity)) {
      this._flash('Too much data for a 255-char input_text. Use shorter names, fewer players, or a "text" helper with a higher max.');
      return false;
    }
    this._lastRaw = value; // optimistic; avoids a flash before HA echoes back
    this._setValue(value);
    this._render(); // optimistic; HA will echo the same value and be a no-op
    return true;
  }

  _clear() {
    this._confirmReset = false;
    this._ffaOrder = [];
    this._pending = null;
    this._kothSessions = undefined;   // re-read the lineages on the way back to setup
    this._lastRaw = '';
    this._setValue('');
    this._render();
  }

  /* --- actions --- */
  async _createFromDraft() {
    const names = this._draft.split('\n').map((n) => n.trim()).filter(Boolean);
    if (names.length < 2) { this._flash('Enter at least two players (one per line).'); return; }
    if (names.length > 64) { this._flash('That is a lot of players — cap is 64.'); return; }
    if (this._mode === 'f' && names.length > 36) { this._flash('Free-for-all supports up to 36 players.'); return; }
    if (this._mode === 'k' && names.length > KOTH_MAX_PLAYERS) { this._flash(`King of the hill supports up to ${KOTH_MAX_PLAYERS} players.`); return; }
    // Entry order is seeding order, and a typed list is rarely random — so
    // shuffle once here. The shuffled order is what gets stored, so the
    // draw is stable from then on.
    const game = this._game.trim();
    // King of the hill: each game keeps one ongoing lineage. If its reigning
    // champion is in tonight's list, offer to carry it on; otherwise this is
    // a one-off that leaves the title where it is.
    if (this._mode === 'k' && this._tracking) {
      if (this._kothSessions === undefined || this._kothSessions === 'loading') await this._loadKothSessions();
      const lineage = this._lineageFor(game);
      if (lineage) {
        const playing = names.some((n) => n.toLowerCase() === String(lineage.king).toLowerCase());
        if (playing) {
          this._pending = { kind: 'continue', names, lineage };
          this._render();
          return;
        }
        shuffle(names);
        this._startKoth(names, { game, temp: true });
        return;
      }
    }
    shuffle(names);
    const swissRounds = this._mode === 'w' ? Math.max(0, parseInt(this._swissRounds, 10) || 0) : 0;
    this._ffaOrder = [];
    if (this._mode === 'k') { this._startKoth(names, { game }); return; }
    this._track = { busy: false, error: null };
    this._kothChallenger = null;
    this._save({
      players: names, mode: this._mode, w: '', decisions: {},
      resetBracket: this._config.reset_bracket !== false,
      decider: '', finished: false, swissRounds, base: null, temp: false,
      game, created: Math.floor(Date.now() / 1000), recorded: false,
    });
  }

  // Step 2 of the continue flow: confirm who is playing tonight. Returning
  // players keep the lineage's spelling; the champion can't be dropped.
  _openRoster() {
    const p = this._pending;
    if (!p || p.kind !== 'continue') return;
    const order = [...p.lineage.players];
    const selected = new Set();
    for (const name of p.names) {
      const known = order.find((n) => n.toLowerCase() === name.toLowerCase());
      if (known) selected.add(known);
      else { order.push(name); selected.add(name); }
    }
    selected.add(p.lineage.king);
    this._pending = { kind: 'roster', lineage: p.lineage, order, selected };
    this._render();
  }

  _toggleRoster(name) {
    const p = this._pending;
    if (!p || p.kind !== 'roster') return;
    if (name === p.lineage.king) return;   // the champion is what's being continued
    if (p.selected.has(name)) p.selected.delete(name); else p.selected.add(name);
    this._render();
  }

  _addRosterName() {
    const p = this._pending;
    const input = this.shadowRoot.querySelector('#roster-add');
    if (!p || p.kind !== 'roster' || !input) return;
    const name = input.value.trim();
    if (!name) return;
    const known = p.order.find((n) => n.toLowerCase() === name.toLowerCase());
    if (known) p.selected.add(known);
    else { p.order.push(name); p.selected.add(name); }
    input.value = '';
    this._render();
  }

  // Tap handler for every format. matchId is a bracket match id, "dec:<id>"
  // for the tie decider, "koth" for the current king-of-the-hill game, or a
  // round robin / Swiss match id.
  _pick(matchId, side) {
    const d = decodeState(this._lastRaw);
    if (!d || d.finished) return;

    if (MODES[d.mode].bracket) {
      const decisions = { ...d.decisions };
      if (!pickInBracket(d.players, bracketOpts(d), decisions, matchId, side)) return;
      d.decisions = decisions;
    } else if (matchId.startsWith('dec:')) {
      const res = compute(d, this._config);
      if (!res.decider) return;
      const opts = { single: true, resetBracket: false };
      const decisions = codesToDecisions(res.tie, opts, d.decider);
      if (!pickInBracket(res.tie, opts, decisions, matchId.slice(4), side)) return;
      d.decider = decisionsToCodes(res.tie, opts, decisions);
    } else if (d.mode === 'k') {
      const res = compute(d, this._config);
      if (!res.current) return;
      const pick = this._kothChallenger;
      const challenger = pick != null && res.queue.includes(pick) ? pick : res.current.challenger;
      if (challenger == null) return;
      d.w += kothChallengerCode(challenger) + (side === 'p1' ? '1' : '2');
      this._kothChallenger = null;
    } else {
      // round robin / Swiss: one code per match, addressed by its index.
      const res = compute(d, this._config);
      let match = null;
      for (const r of res.rounds) for (const m of r.matches) if (m.id === matchId) match = m;
      if (!match || match.index == null) return;
      const codes = d.w.padEnd(match.index + 1, '0').split('');
      const code = side === 'p1' ? '1' : '2';
      if (codes[match.index] === code) return;
      codes[match.index] = code;
      d.w = codes.join('');
      // Changing an earlier Swiss round invalidates the pairings after it.
      if (d.mode === 'w') {
        const lastIdx = Math.max(...res.rounds.find((r) => r.round === match.round).matches
          .map((m) => (m.index == null ? -1 : m.index)));
        d.w = d.w.slice(0, lastIdx + 1);
      }
      d.decider = '';
    }
    this._afterChange(d);
  }

  // King of the hill / free-for-all: take back the last game or round, or
  // reopen a finished session.
  _undo() {
    const d = decodeState(this._lastRaw);
    if (!d) return;
    if (d.finished) d.finished = false;
    else if (d.mode === 'k') d.w = d.w.slice(0, /[A-Za-z]/.test(d.w) ? -2 : -1); // letter+outcome per game (legacy: 1 char)
    else if (d.mode === 'f') d.w = d.w.split('|').filter(Boolean).slice(0, -1).join('|');
    this._afterChange(d);
  }

  _finish() {
    const d = decodeState(this._lastRaw);
    if (!d || d.finished) return;
    this._confirmFinish = false;
    d.finished = true;
    this._afterChange(d);
  }

  _saveFfaRound() {
    const d = decodeState(this._lastRaw);
    if (!d || d.mode !== 'f' || d.finished) return;
    if (this._ffaOrder.length < 2) { this._flash('Tap at least two players in finishing order.'); return; }
    const chunk = encodeFfaRound(this._ffaOrder);
    d.w = d.w ? `${d.w}|${chunk}` : chunk;
    this._ffaOrder = [];
    this._afterChange(d);
  }

  // Persist, then record the result if it's decided. Any change invalidates
  // an earlier record (a re-pick can change the standings without un-deciding
  // a round robin), and the re-write lands on the same point.
  _afterChange(d) {
    const res = compute(d, this._config);
    d.recorded = false;
    if (!this._save(d)) return;
    if (res.champion && this._tracking) this._recordResult(res);
  }

  // Write the decided result to InfluxDB through the configured rest_command,
  // then flag the tournament as recorded so no device writes it twice.
  async _recordResult(res) {
    if (this._track.busy) return;
    const d = decodeState(this._lastRaw);
    if (!d || !res.champion) return;
    this._track = { busy: true, error: null };
    this._render();
    const champ = res.champion;
    const koth = res.kind === 'koth';
    const line = resultLine(this._tracking.measurement, {
      game: d.game, mode: d.mode, winner: champ.name, runnerUp: champ.runnerUp,
      players: d.players, created: d.created || Math.floor(Date.now() / 1000),
      standings: standingsSummary(res), topWins: koth ? res.kingWins : undefined,
      placings: finishingOrder(res),
      snapshot: koth && !d.temp ? kothSnapshot(res) : null, sessions: res.sessions,
      games: res.totalGames, temp: koth && d.temp,
    });
    try {
      await callWithResponse(this._hass, this._tracking.write_service, { line });
      this._track = { busy: false, error: null };
      const fresh = decodeState(this._lastRaw) || d;
      fresh.recorded = true;
      this._save(fresh);
      return true;
    } catch (e) {
      const msg = (e && (e.message || e.error)) || String(e);
      this._track = { busy: false, error: msg };
      this._render();
      return false;
    }
  }

  // King of the hill "New game" with games on the board: record the lineage
  // first so it can be picked up again, then clear.
  async _recordAndClear() {
    const d = decodeState(this._lastRaw);
    if (!d) return;
    d.finished = true;
    if (!this._save(d)) return;
    const ok = await this._recordResult(compute(d, this._config));
    if (ok) this._clear();
    else this._confirmReset = false;
  }

  // Previous king-of-the-hill lineages, from the latest recorded point per
  // game, offered on the setup screen. Only those carrying a snapshot count.
  async _loadKothSessions() {
    if (!this._tracking || !this._hass) return;
    this._kothSessions = 'loading';
    const q = `SELECT "state", "winner", "top_wins", "games", "sessions", "last_played", "temp", "game" FROM "${this._tracking.measurement}" WHERE "mode" = 'king_of_the_hill' ORDER BY time DESC LIMIT 100`;
    try {
      const r = await callWithResponse(this._hass, this._tracking.query_service, { q });
      const rows = parseInfluxRows(r && r.content != null ? r.content : r);
      const seen = new Set();
      const out = [];
      for (const row of rows) {
        if (row.temp === true) continue;        // one-off games never become the lineage
        const game = row.game || 'Untitled';
        if (seen.has(game)) continue;   // rows are newest first: keep the latest lineage per game
        seen.add(game);
        let snap;
        try { snap = JSON.parse(row.state); } catch (e) { continue; }
        if (!snap || !Array.isArray(snap.p) || !snap.b) continue;
        out.push({ game, time: row.time, king: row.winner, topWins: row.top_wins, games: row.games,
          sessions: row.sessions, lastPlayed: row.last_played || row.time, players: snap.p, base: snap.b });
      }
      this._kothSessions = out;
    } catch (e) {
      this._kothSessions = { error: (e && (e.message || e.error)) || String(e) };
    }
    this._render();
  }

  // The ongoing lineage for a game name, if one has been recorded.
  _lineageFor(game) {
    const list = Array.isArray(this._kothSessions) ? this._kothSessions : [];
    const want = String(game || '').trim().toLowerCase();
    return list.find((x) => String(x.game).toLowerCase() === want) || null;
  }

  // Start (or continue) a king-of-the-hill game.
  //   lineage + base -> carries the game's ongoing lineage on
  //   temp           -> a one-off that leaves the lineage alone
  _startKoth(players, { game, base = null, created = 0, temp = false }) {
    this._track = { busy: false, error: null };
    this._kothChallenger = null;
    this._pending = null;
    this._save({
      players, mode: 'k', w: '', decisions: {},
      resetBracket: this._config.reset_bracket !== false,
      decider: '', finished: false, swissRounds: 0, base, temp,
      // Continuing reuses the lineage's timestamp, so recording updates that
      // same point instead of starting a second history entry.
      game, created: created || Math.floor(Date.now() / 1000), recorded: false,
    });
  }

  // Roster step: build the final player list and re-map the lineage onto it.
  _continueLineage() {
    const p = this._pending;
    if (!p || p.kind !== 'roster') return;
    const players = p.order.filter((n) => p.selected.has(n));
    if (players.length < 2) { this._flash('Keep at least two players.'); return; }
    if (players.length > KOTH_MAX_PLAYERS) { this._flash(`King of the hill supports up to ${KOTH_MAX_PLAYERS} players.`); return; }
    const base = kothRebase(p.lineage.base, p.lineage.players, players);
    if (!base) { this._flash(`${p.lineage.king} holds this hill and has to be playing to continue it.`); return; }
    this._startKoth(players, { game: p.lineage.game, base, created: p.lineage.time });
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
    this._lineJobs = [];
    this._result = null;

    let body;
    if (!this._hass) {
      body = `<div class="pad muted">Loading…</div>`;
    } else if (!this._hass.states[this._config.entity]) {
      body = `<div class="pad err">Helper <code>${esc(this._config.entity)}</code> not found. Create the input_text helper first.</div>`;
    } else if (!decoded) {
      body = this._pending ? this._pendingView() : this._setupView();
    } else {
      const res = compute(decoded, this._config);
      this._result = res;
      body = this._banner(decoded, res)
        + (res.kind === 'bracket' ? this._bracketView(res.state, 'main', decoded.mode === 's')
          : res.kind === 'koth' ? this._kothView(decoded, res)
          : res.kind === 'ffa' ? this._ffaView(decoded, res)
          : this._pairedView(decoded, res));
    }

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="hdr">
          <div class="title">${esc(title)}${decoded && decoded.game
            ? `<span class="pill">${esc(decoded.game)}</span>` : ``}${decoded
            ? `<span class="pill mode">${esc(MODES[decoded.mode].label)}</span>` : ``}${decoded && decoded.temp
            ? `<span class="pill temp" title="A one-off game — the ongoing title is untouched">one-off</span>` : ``}</div>
          ${decoded ? `<button class="ghost" id="new">New game</button>` : ``}
        </div>
        ${this._msg ? `<div class="flash">${esc(this._msg)}</div>` : ``}
        ${this._confirmReset ? (this._result && this._result.kind === 'koth' && this._tracking
            && !decoded.recorded && this._result.totalGames > 0 ? `
          <div class="confirm">
            <span>Record this king-of-the-hill session so it can be picked up later?</span>
            <button class="primary" id="do-record-reset" ${this._track.busy ? 'disabled' : ''}>${this._track.busy ? 'Saving…' : 'Record & clear'}</button>
            <button class="danger" id="do-reset">Clear without recording</button>
            <button class="ghost" id="cancel-reset">Cancel</button>
          </div>` : `
          <div class="confirm">
            <span>Clear this tournament and start over?</span>
            <button class="danger" id="do-reset">Yes, clear</button>
            <button class="ghost" id="cancel-reset">Cancel</button>
          </div>`) : ``}
        ${body}
        <div class="foot">bracket-card v${CARD_VERSION}</div>
      </ha-card>
      <style>${STYLE}</style>
    `;

    this._wire(decoded);

    // Connector lines are measured from laid-out positions. Measuring forces
    // layout, so they can be drawn right away; the next-frame pass catches
    // late font metrics, and the observer handles resizes.
    this._drawLines();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this._drawLines());
    this._observeResize();
  }

  // Every render replaces the DOM, so re-point the observer at the new elements.
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    if (this._ro) this._ro.disconnect();
    const wraps = this.shadowRoot.querySelectorAll('.bracket');
    if (!wraps.length) return;
    this._ro = this._ro || new ResizeObserver(() => this._drawLines());
    wraps.forEach((w) => this._ro.observe(w));
  }

  disconnectedCallback() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  _setupView() {
    const modeOpts = Object.entries(MODES).map(([k, m]) =>
      `<option value="${k}" ${k === this._mode ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    // King of the hill keeps one ongoing lineage per game. Say where it
    // stands, so it's clear what happens when Start is pressed.
    let lineageNote = '';
    if (this._mode === 'k' && this._tracking) {
      if (this._kothSessions === undefined) { this._kothSessions = 'loading'; setTimeout(() => this._loadKothSessions(), 0); }
      const ks = this._kothSessions;
      if (ks === 'loading') lineageNote = `<p class="muted small">Checking for an existing king…</p>`;
      else if (ks && ks.error) lineageNote = `<p class="err small">Couldn't check for an existing king: ${esc(ks.error)}</p>`;
      else if (Array.isArray(ks) && ks.length) {
        const hit = this._lineageFor(this._game);
        lineageNote = hit ? `
          <div class="lineage">
            <div>👑 <strong>${esc(hit.king)}</strong> holds the ${esc(hit.game)} hill${Number.isFinite(hit.topWins) ? ` — ${hit.topWins} wins on top` : ''}${Number.isFinite(hit.games) ? `, ${hit.games} games` : ''}, last played ${esc(fmtDate(hit.lastPlayed))}.</div>
            <div class="muted tiny">Include ${esc(hit.king)} in the players to carry that game on; without them it's a one-off and the title stays put.</div>
          </div>` : `
          <p class="muted small">No king recorded for this game yet${this._game.trim() ? '' : ' — type the game above to check'}. Ongoing games: ${ks.map((x) => `${esc(x.game)} (👑 ${esc(x.king)})`).join(', ')}.</p>`;
      }
    }
    return `
      <div class="pad">
        <label class="lbl" for="game">Game</label>
        <input id="game" type="text" placeholder="e.g. Mario Kart, UNO" value="${esc(this._game)}" maxlength="40">
        <label class="lbl" for="mode">Format</label>
        <select id="mode">${modeOpts}</select>
        <p class="muted small">${esc(MODES[this._mode].help)}</p>
        ${lineageNote}
        ${this._mode === 'w' ? `
          <label class="lbl" for="rounds">Rounds</label>
          <input id="rounds" type="number" min="1" max="20" placeholder="automatic (log\u2082 of players)" value="${esc(this._swissRounds)}">` : ''}
        <label class="lbl" for="draft">Players</label>
        <p class="muted small">One per line. ${this._mode === 'k'
          ? 'The first two play for the hill — the winner is crowned.'
          : 'The order is shuffled when you start.'}</p>
        <textarea id="draft" rows="8" placeholder="Alice&#10;Bob&#10;Charlie&#10;Dana">${esc(this._draft)}</textarea>
        <div class="row">
          <button class="primary" id="create">Start</button>
        </div>
      </div>`;
  }

  // Start-time prompts for a king-of-the-hill game whose champion is playing.
  _pendingView() {
    const p = this._pending;
    if (!p) return '';
    if (p.kind === 'continue') {
      return `
        <div class="pad">
          <div class="confirm stack">
            <div>👑 <strong>${esc(p.lineage.king)}</strong> holds the ${esc(p.lineage.game)} hill${Number.isFinite(p.lineage.games) ? ` (${p.lineage.games} games` : ''}${Number.isFinite(p.lineage.topWins) ? `, ${p.lineage.topWins} wins on top)` : p.lineage.games != null ? ')' : ''} and is playing. Carry that game on?</div>
            <div class="row">
              <button class="primary" id="koth-continue">Continue it</button>
              <button class="ghost" id="koth-oneoff">No — one-off game</button>
              <button class="ghost" id="koth-cancel">Cancel</button>
            </div>
          </div>
        </div>`;
    }
    const rows = p.order.map((name) => {
      const on = p.selected.has(name);
      const isKing = name === p.lineage.king;
      const known = p.lineage.players.includes(name);
      return `<button class="chip${on ? ' placed' : ''}${isKing ? ' locked' : ''}" data-roster="${esc(name)}"
        >${isKing ? '👑 ' : ''}${esc(name)}${!known ? '<span class="badge">new</span>' : ''}</button>`;
    }).join('');
    return `
      <div class="pad">
        <div class="sub">Who's playing? — ${esc(p.lineage.game)}</div>
        <p class="muted small">Tap to add or drop a player. Returning players keep their record; ${esc(p.lineage.king)} holds the hill and stays.</p>
        <div class="chips">${rows}</div>
        <div class="row">
          <input id="roster-add" type="text" placeholder="Add someone new" maxlength="20">
          <button class="ghost" id="roster-add-btn">Add</button>
        </div>
        <div class="row">
          <button class="primary" id="roster-go">Continue with ${p.selected.size} player${p.selected.size === 1 ? '' : 's'}</button>
          <button class="ghost" id="koth-cancel">Cancel</button>
        </div>
      </div>`;
  }

  // Champion / tie banner with the tracking status, shared by every format.
  _banner(decoded, res) {
    const champ = res.champion;
    let trackNote = '';
    if (champ && this._tracking) {
      if (this._track.busy) trackNote = `<span class="tnote">Saving result…</span>`;
      else if (this._track.error) trackNote = `<span class="tnote terr">Not saved: ${esc(this._track.error)}</span> <button class="ghost small" id="retry">Retry</button>`;
      else if (decoded.recorded) trackNote = `<span class="tnote">Result recorded ✓</span>`;
      else trackNote = `<button class="ghost small" id="retry">Record result</button>`;
    }
    if (champ) {
      const extra = res.kind === 'koth'
        ? ` <span class="tnote">👑 ${res.kingWins} wins on top · ${res.totalGames} games${res.sessions > 1 ? ` · session ${res.sessions}` : ''}${decoded.temp ? ' · one-off' : ''}</span>` : '';
      return `<div class="champ">🏆 Champion:&nbsp;<strong>${esc(champ.name)}</strong>${extra}${trackNote}</div>`;
    }
    if (res.tie && (res.kind === 'ffa' || res.complete) && !res.decider) {
      return `<div class="tie">Tied at the top: ${res.tie.map(esc).join(', ')}${res.kind === 'ffa'
        ? ' — play another round to split them.' : ''}</div>`;
    }
    return '';
  }

  /* ----- bracket (double / single elimination) ----- */
  _bracketView(s, key, single) {
    this._lineJobs.push({ key, state: s });
    const prefix = key === 'main' ? '' : `${key}:`;

    const groups = { W: {}, L: {} };
    let gf1 = null, gf2 = null;
    for (const id of s.order) {
      const m = s.matches[id];
      if (m.bracket === 'GF') { if (m.id === 'GF-1') gf1 = m; else gf2 = m; continue; }
      (groups[m.bracket][m.round] ||= []).push(m);
    }

    // Every column stretches to the section's height and spreads its matches
    // evenly, so a match in round r+1 sits centred between the two that feed
    // it. Hidden (bye-vs-bye) matches keep their slot so that stays true.
    const section = (label, roundsObj, cls) => {
      const rounds = Object.keys(roundsObj).map(Number).sort((a, b) => a - b);
      if (!rounds.length) return '';
      const cols = rounds.map((r) => `
        <div class="col">
          <div class="col-h">${roundName(single ? 'se' : cls, r, rounds.length)}</div>
          <div class="col-body">${roundsObj[r].map((m) => this._matchHtml(m, '', prefix)).join('')}</div>
        </div>`).join('');
      return `<div class="section ${cls}">${label ? `<div class="sec-h ${cls}">${label}</div>` : ''}<div class="cols">${cols}</div></div>`;
    };

    // The reset game only exists once the losers-bracket entrant has won GF-1.
    const showGf2 = gf2 && (isRealPlayer(gf2.p1) || isRealPlayer(gf2.p2));
    const gfCol = gf1 ? `
      <div class="gf-col">
        <div class="sec-h gf">Grand Final</div>
        <div class="gf-body">
          ${this._matchHtml(gf1, '', prefix)}
          ${showGf2 ? this._matchHtml(gf2, 'Reset game', prefix) : ''}
        </div>
      </div>` : '';

    return `
      <div class="scroll">
        <div class="bracket" data-key="${key}">
          <svg class="lines" aria-hidden="true"></svg>
          <div class="left">
            ${section(single ? '' : 'Winners Bracket', groups.W, 'wb')}
            ${section('Losers Bracket', groups.L, 'lb')}
          </div>
          ${gfCol}
        </div>
      </div>`;
  }

  _matchHtml(m, tag = '', prefix = '') {
    // A match with a bye on both sides is scaffolding, not a game: it exists
    // so the tree stays a power of two. Keep its slot (for centring) but
    // don't show it.
    const hidden = m.winner === 'bye' || (isBye(m.p1) && isBye(m.p2));
    const row = (side) => {
      const ref = m[side];
      const label = slotLabel(ref);
      const real = isRealPlayer(ref);
      const isWinner = m.winner === side;
      const isLoser = m.winner && m.winner !== side && m.winner !== 'bye';
      const cls = ['p', real ? 'real' : 'empty', isWinner ? 'win' : '', isLoser ? 'lose' : '']
        .join(' ').trim();
      const clickable = real && !isWinner && isRealPlayer(m.p1) && isRealPlayer(m.p2);
      return `<div class="${cls}" data-match="${prefix}${m.id}" data-side="${side}" data-click="${clickable ? 1 : 0}">
                <span class="nm">${label ? esc(label) : '&nbsp;'}</span>${isWinner ? '<span class="chk">✓</span>' : ''}
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
   * Draw the connectors as one SVG path over each bracket, measured from
   * where the matches actually landed. Measuring (rather than a pure-CSS
   * bracket) is what lets the lines survive hidden bye matches and the
   * losers bracket's uneven wiring, and lets both finals converge on the
   * grand final off to the right.
   */
  _drawLines() {
    const root = this.shadowRoot;
    if (!root || !this._lineJobs) return;
    for (const job of this._lineJobs) {
      const wrap = root.querySelector(`.bracket[data-key="${job.key}"]`);
      const svg = wrap && wrap.querySelector('svg.lines');
      const st = job.state;
      if (!wrap || !svg || !st) continue;

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
  }

  /* ----- round robin / Swiss ----- */
  _pairedView(decoded, res) {
    const P = res.players;
    const isSwiss = res.kind === 'swiss';
    // Reuse the bracket match markup by converting index pairs to refs.
    const toRef = (i) => (i == null ? { type: 'bye' } : { type: 'player', seed: i + 1, name: P[i] });
    const cols = res.rounds.map((r) => `
      <div class="col">
        <div class="col-h">Round ${r.round}${isSwiss ? ` of ${res.totalRounds}` : ''}</div>
        <div class="col-body top">
          ${r.matches.map((m) => (m.p2 == null
            ? `<div class="sitout">${esc(P[m.p1])} ${isSwiss ? 'has a bye (win)' : 'sits out'}</div>`
            : this._matchHtml({ id: m.id, p1: toRef(m.p1), p2: toRef(m.p2), winner: m.winner }))).join('')}
        </div>
      </div>`).join('');

    const rows = res.standings.map((s, i) => `
      <tr><td class="rank">${i + 1}</td><td>${esc(s.name)}</td>
          <td class="num">${s.wins}–${s.losses}</td>${isSwiss ? `<td class="num muted" title="Strength of opposition">${s.buchholz}</td>` : ''}</tr>`).join('');

    const decider = res.decider ? `
      <div class="pad">
        <div class="sub">Decider — tied: ${res.tie.map(esc).join(', ')}</div>
        ${this._bracketView(res.decider, 'dec', true)}
      </div>` : '';

    return `
      <div class="pad grid">
        <div>
          <div class="sub">Standings</div>
          <table><tr class="th"><td></td><td>Player</td><td class="num">W–L</td>${isSwiss ? '<td class="num">SOS</td>' : ''}</tr>${rows}</table>
        </div>
        <div class="scroll tight"><div class="cols">${cols}</div></div>
      </div>
      ${decider}`;
  }

  /* ----- king of the hill ----- */
  _kothView(decoded, res) {
    const P = res.players;
    const cur = res.current;
    const kingStats = res.standings.find((s) => s.idx === res.king) || {};
    // The challenger defaults to whoever has waited longest, but any waiting
    // player can be tapped to take the game instead.
    const picked = this._kothChallenger;
    const challenger = cur && picked != null && res.queue.includes(picked) ? picked : (cur ? cur.challenger : null);
    const game = cur ? `
      <div class="match big" data-id="koth">
        <div class="mtag">${cur.crowning ? 'Game 1 — winner takes the hill'
          : `Game ${res.totalGames + 1}${res.sessions > 1 ? ` · session ${res.sessions}` : ''}`}</div>
        <div class="p real" data-match="koth" data-side="p1" data-click="1">
          <span class="nm">${cur.crowning ? '' : '👑 '}${esc(P[cur.holder])}</span><span class="side">${cur.crowning ? 'on the hill' : `${kingStats.kingWins || 0} on top`}</span>
        </div>
        <div class="vs"></div>
        <div class="p real" data-match="koth" data-side="p2" data-click="1">
          <span class="nm">${esc(P[challenger])}</span><span class="side">challenger</span>
        </div>
      </div>
      <p class="muted small">Tap the winner above, or pick who plays next:</p>
      <div class="chips">${res.queue.map((i) => `<button class="chip${i === challenger ? ' placed' : ''}" data-koth="${i}">${esc(P[i])}</button>`).join('')}</div>` : '';

    const rows = res.standings.map((s, i) => `
      <tr><td class="rank">${i + 1}</td><td>${s.idx === res.king ? '👑 ' : ''}${esc(s.name)}</td>
          <td class="num"><strong>${s.kingWins}</strong></td><td class="num muted">${s.reigns}</td><td class="num muted">${s.wins}–${s.losses}</td></tr>`).join('');
    const log = [...res.games].reverse().slice(0, 12).map((g) => {
      const winner = g.winner === 'king' ? P[g.king] : P[g.challenger];
      const loser = g.winner === 'king' ? P[g.challenger] : P[g.king];
      return `<tr><td class="rank">${g.n}</td><td>${g.crowning
        ? `👑 <strong>${esc(winner)}</strong> <span class="muted">took the hill from ${esc(loser)}</span>`
        : g.winner === 'king'
          ? `👑 <strong>${esc(winner)}</strong> <span class="muted">held off ${esc(loser)}</span>`
          : `<strong>${esc(winner)}</strong> <span class="muted">dethroned</span> 👑 ${esc(loser)}`}</td></tr>`;
    }).join('');

    return `
      <div class="pad grid">
        <div>
          ${game}
          <div class="row">
            ${res.games.length ? `<button class="ghost" id="undo">${res.finished ? 'Reopen' : 'Undo last game'}</button>` : ''}
            ${!res.finished && res.games.length ? (this._confirmFinish
              ? `<span class="muted small">End the session and crown the champion?</span><button class="primary" id="do-finish">Yes, finish</button><button class="ghost" id="cancel-finish">Cancel</button>`
              : `<button class="primary" id="finish">Finish session</button>`) : ''}
          </div>
        </div>
        <div>
          <div class="sub">Standings</div>
          <table><tr class="th"><td></td><td>Player</td><td class="num">Wins on top</td><td class="num">Reigns</td><td class="num">W–L</td></tr>${rows}</table>
          ${res.games.length ? `<div class="sub gap">Games${res.sessions > 1 ? ' this session' : ''}</div><table>${log}</table>` : ''}
        </div>
      </div>`;
  }

  /* ----- free-for-all ----- */
  _ffaView(decoded, res) {
    const P = res.players;
    const order = this._ffaOrder.filter((i) => i < P.length);
    const chips = P.map((name, i) => {
      const place = order.indexOf(i);
      return `<button class="chip${place >= 0 ? ' placed' : ''}" data-ffa="${i}">${place >= 0 ? `<span class="badge">${ordinal(place + 1)}</span>` : ''}${esc(name)}</button>`;
    }).join('');
    const entry = res.finished ? '' : `
      <div class="sub">Round ${res.rounds.length + 1} — tap players in finishing order</div>
      <div class="chips">${chips}</div>
      <p class="muted small">Points: ${res.points.slice(0, P.length).join(' · ')}. Anyone not placed scores 0.</p>
      <div class="row">
        <button class="primary" id="ffa-save" ${order.length < 2 ? 'disabled' : ''}>Save round</button>
        ${order.length ? `<button class="ghost" id="ffa-clear">Clear</button>` : ''}
      </div>`;

    const rows = res.standings.map((s, i) => `
      <tr><td class="rank">${i + 1}</td><td>${esc(s.name)}</td>
          <td class="num"><strong>${s.points}</strong></td><td class="num muted">${s.places[0]}</td><td class="num muted">${s.rounds}</td></tr>`).join('');
    const log = [...res.rounds].reverse().slice(0, 12).map((r) => `
      <tr><td class="rank">${r.n}</td><td>${r.order.map((i, k) => (k === 0 ? `<strong>${esc(P[i])}</strong>` : esc(P[i]))).join(', ')}</td></tr>`).join('');

    return `
      <div class="pad grid">
        <div>
          ${entry}
          <div class="row">
            ${res.rounds.length ? `<button class="ghost" id="undo">${res.finished ? 'Reopen' : 'Undo last round'}</button>` : ''}
            ${!res.finished && res.rounds.length ? (this._confirmFinish
              ? `<span class="muted small">End the session and crown the champion?</span><button class="primary" id="do-finish" ${res.tie ? 'disabled' : ''}>Yes, finish</button><button class="ghost" id="cancel-finish">Cancel</button>`
              : `<button class="primary" id="finish" ${res.tie ? 'disabled title="Tied at the top — play another round"' : ''}>Finish</button>`) : ''}
          </div>
        </div>
        <div>
          <div class="sub">Standings</div>
          <table><tr class="th"><td></td><td>Player</td><td class="num">Pts</td><td class="num">1sts</td><td class="num">Rounds</td></tr>${rows}</table>
          ${res.rounds.length ? `<div class="sub gap">Rounds</div><table>${log}</table>` : ''}
        </div>
      </div>`;
  }

  _wire(decoded) {
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#new', () => { this._confirmReset = true; this._render(); });
    on('#do-reset', () => this._clear());
    on('#do-record-reset', () => this._recordAndClear());
    on('#koth-continue', () => this._openRoster());
    on('#koth-oneoff', () => {
      const p = this._pending;
      if (!p) return;
      const names = [...p.names];
      shuffle(names);
      this._startKoth(names, { game: p.lineage.game, temp: true });
    });
    on('#koth-cancel', () => { this._pending = null; this._render(); });
    on('#roster-go', () => this._continueLineage());
    on('#roster-add-btn', () => this._addRosterName());
    const rosterAdd = $('#roster-add');
    if (rosterAdd) rosterAdd.onkeydown = (e) => { if (e.key === 'Enter') this._addRosterName(); };
    this.shadowRoot.querySelectorAll('[data-roster]').forEach((el) => {
      el.onclick = () => this._toggleRoster(el.getAttribute('data-roster'));
    });
    on('#cancel-reset', () => { this._confirmReset = false; this._render(); });

    const draft = $('#draft');
    if (draft) draft.oninput = (e) => { this._draft = e.target.value; };
    const game = $('#game');
    if (game) game.oninput = (e) => { this._game = e.target.value; };
    if (game && this._mode === 'k') game.onchange = () => this._render(); // re-sort the Continue list on blur
    const mode = $('#mode');
    if (mode) mode.onchange = (e) => { this._mode = e.target.value; this._render(); };
    const rounds = $('#rounds');
    if (rounds) rounds.oninput = (e) => { this._swissRounds = e.target.value; };
    on('#create', () => this._createFromDraft());

    on('#retry', () => { if (this._result && this._result.champion) this._recordResult(this._result); });
    on('#undo', () => this._undo());
    on('#finish', () => { this._confirmFinish = true; this._render(); });
    on('#cancel-finish', () => { this._confirmFinish = false; this._render(); });
    on('#do-finish', () => this._finish());
    on('#ffa-save', () => this._saveFfaRound());
    on('#ffa-clear', () => { this._ffaOrder = []; this._render(); });
    this.shadowRoot.querySelectorAll('[data-koth]').forEach((el) => {
      el.onclick = () => { this._kothChallenger = Number(el.getAttribute('data-koth')); this._render(); };
    });
    this.shadowRoot.querySelectorAll('[data-ffa]').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.getAttribute('data-ffa'));
        const at = this._ffaOrder.indexOf(i);
        if (at >= 0) this._ffaOrder.splice(at, 1); else this._ffaOrder.push(i);
        this._render();
      };
    });

    this.shadowRoot.querySelectorAll('[data-click="1"]').forEach((el) => {
      el.onclick = () => this._pick(el.getAttribute('data-match'), el.getAttribute('data-side'));
    });
  }
}

function roundName(cls, r, total) {
  if (cls === 'wb' || cls === 'se') {
    const pre = cls === 'wb' ? 'WB ' : '';
    if (r === total) return pre + 'Final';
    if (r === total - 1) return pre + 'Semis';
    return pre + 'R' + r;
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
         padding: 14px 16px 6px; gap: 8px; }
  .title { font-size: 1.25rem; font-weight: 600; color: var(--primary-text-color);
           display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .pill { font-size:.8rem; font-weight:600; padding: 2px 10px; border-radius: 999px;
          background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .pill.mode { font-weight:500; opacity:.85; }
  .lbl { display:block; font-size:.8rem; font-weight:600; margin: 8px 0 4px;
         color: var(--secondary-text-color); }
  input[type=text], input[type=number], select {
             width:100%; box-sizing:border-box; font: inherit; padding:10px;
             border:1px solid var(--divider-color, #e0e0e0); border-radius:8px;
             background: var(--card-background-color); color: var(--primary-text-color); }
  .tnote { font-size:.8rem; font-weight:400; margin-left: 12px; opacity:.9; }
  .terr { color: var(--error-color, #db4437); }
  .ghost.small { padding: 2px 10px; font-size:.8rem; margin-left: 8px; }
  .pad { padding: 8px 16px 16px; }
  .muted { color: var(--secondary-text-color); }
  .small { font-size:.85rem; margin: 4px 0 6px; }
  .err { color: var(--error-color, #db4437); }
  .foot { text-align:right; font-size: 10px; color: var(--disabled-text-color, #9e9e9e);
          padding: 2px 12px 2px; opacity:.7; }
  textarea { width:100%; box-sizing:border-box; font: inherit; padding:10px;
             border:1px solid var(--divider-color, #e0e0e0); border-radius:8px;
             background: var(--card-background-color); color: var(--primary-text-color);
             resize: vertical; }
  .row { margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .row input[type=text] { width:auto; flex:1 1 160px; min-width:0; }
  button { font: inherit; cursor:pointer; border-radius: 999px; border: none;
           padding: 8px 16px; }
  button[disabled] { opacity:.5; cursor:default; }
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
           display:flex; align-items:center; flex-wrap:wrap;
           background: linear-gradient(90deg, var(--primary-color), transparent);
           color: var(--text-primary-color, #fff); font-size: 1.05rem; }
  .champ strong { font-weight: 700; }
  .tie { margin: 4px 16px 8px; padding: 8px 14px; border-radius: 10px; font-size:.95rem;
         background: var(--secondary-background-color); color: var(--primary-text-color); }
  .scroll { overflow-x: auto; padding: 4px 12px 12px; }
  .scroll.tight { padding: 0; }
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
  .col-body.top { justify-content:flex-start; }
  .gf-col { display:flex; flex-direction:column; min-width: 132px; }
  .gf-body { flex:1; display:flex; flex-direction:column; justify-content:center; gap: 12px; }
  .match.hidden { visibility: hidden; }
  .match { position: relative; z-index: 1; border:1px solid var(--divider-color, #e0e0e0);
           border-radius: 8px; overflow: hidden; background: var(--card-background-color); }
  .match.big .p { padding: 12px 14px; font-size: 1.05rem; }
  .mtag { font-size:.6rem; text-transform:uppercase; letter-spacing:.06em;
          text-align:center; padding:2px; color: var(--secondary-text-color);
          background: var(--secondary-background-color); }
  .p { display:flex; align-items:center; justify-content:space-between;
       padding: 8px 10px; font-size:.92rem; gap:6px;
       color: var(--primary-text-color); user-select:none; }
  .p .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .p .side { font-size:.75rem; color: var(--secondary-text-color); white-space:nowrap; }
  .p.empty .nm { color: var(--disabled-text-color, #9e9e9e); font-style:italic; }
  .p[data-click="1"] { cursor:pointer; }
  .p[data-click="1"]:hover { background: var(--secondary-background-color); }
  .p.win { background: color-mix(in srgb, var(--primary-color) 16%, transparent);
           font-weight:700; }
  .p.win .chk { color: var(--primary-color); font-weight:700; }
  .p.lose .nm { color: var(--disabled-text-color, #9e9e9e); text-decoration: line-through; }
  .vs { height:1px; background: var(--divider-color, #e0e0e0); margin: 0 8px; }
  .sitout { font-size:.8rem; color: var(--secondary-text-color); font-style:italic;
            padding: 6px 4px; }
  /* tables + two-column layouts (standings / rounds, history) */
  .grid { display:grid; grid-template-columns: minmax(200px, 1fr) 2fr; gap: 16px; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  .sub { font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; font-weight:700;
         margin-bottom: 6px; color: var(--secondary-text-color); }
  .sub.gap { margin-top: 14px; }
  table { border-collapse: collapse; width:100%; font-size:.92rem; color: var(--primary-text-color); }
  td { padding: 6px 6px; border-bottom: 1px solid var(--divider-color, #e0e0e0); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr.th td { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em;
             color: var(--disabled-text-color, #9e9e9e); font-weight:600; }
  .rank { color: var(--disabled-text-color, #9e9e9e); width: 1.5em; }
  .num { text-align:right; white-space:nowrap; }
  .nowrap { white-space:nowrap; }
  .lineage { margin: 6px 0 4px; padding: 8px 10px; border-radius: 8px;
             border: 1px solid var(--primary-color); font-size:.92rem; }
  .pill.temp { background: var(--warning-color, #ffa600); color: #222; }
  .confirm.stack { display:block; }
  .chip.locked { cursor: default; }
  .tiny { font-size:.75rem; }
  /* free-for-all entry */
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { background: var(--secondary-background-color); color: var(--primary-text-color);
          border: 1px solid var(--divider-color, #e0e0e0); padding: 8px 14px;
          display:flex; align-items:center; gap:8px; }
  .chip.placed { background: color-mix(in srgb, var(--primary-color) 16%, var(--card-background-color));
                 border-color: var(--primary-color); font-weight:600; }
  .badge { font-size:.7rem; font-weight:700; padding: 1px 6px; border-radius: 999px;
           background: var(--primary-color); color: var(--text-primary-color, #fff); }
`;

/* ---------- history card ---------- */
/*
 * Reads recorded results back out of InfluxDB (through the query rest_command)
 * and shows the current champion, past winners and a wins leaderboard.
 *
 *   type: custom:bracket-history-card
 *   title: Hall of Fame                       # optional
 *   tracking: true                            # same options as bracket-card
 *   entity: input_text.game_night_bracket     # optional: refresh when it changes
 *   limit: 100                                # optional: rows to fetch
 *   game: Mario Kart                          # optional: preselect a game filter
 */
class BracketHistoryCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._rows = null;      // null = not loaded yet
    this._error = null;
    this._busy = false;
    this._filter = '';
    this._view = 'champions';
    this._sort = 'wins';
    this._player = null;      // when set, the card shows that player's page
    this._lastRaw = undefined;
  }

  setConfig(config) {
    this._config = { limit: 100, ...config, tracking: config.tracking == null ? true : config.tracking };
    this._tracking = trackingConfig(this._config);
    if (this._config.game) this._filter = String(this._config.game);
    if (this._config.view) this._view = String(this._config.view);
    if (this._config.sort) this._sort = String(this._config.sort);
    this._rows = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    // Refresh whenever the bracket helper changes (a result was just recorded).
    const ent = this._config.entity;
    const raw = ent && hass.states[ent] ? hass.states[ent].state : undefined;
    const changed = ent && raw !== this._lastRaw;
    this._lastRaw = raw;
    if (first || changed) this._load();
  }

  getCardSize() { return 4; }

  async _load() {
    if (this._busy || !this._hass || !this._tracking) return;
    this._busy = true; this._error = null;
    this._render();
    const limit = Math.max(1, Math.min(1000, Number(this._config.limit) || 100));
    const q = `SELECT "winner", "runner_up", "players", "player_count", "placings", "standings", "top_wins", "games", "sessions", "last_played", "temp", "game", "mode" FROM "${this._tracking.measurement}" ORDER BY time DESC LIMIT ${limit}`;
    try {
      const r = await callWithResponse(this._hass, this._tracking.query_service, { q });
      this._rows = parseInfluxRows(r && r.content != null ? r.content : r);
    } catch (e) {
      this._error = (e && (e.message || e.error)) || String(e);
    }
    this._busy = false;
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._config) { this.shadowRoot.innerHTML = ''; return; }
    const title = this._config.title || 'Past Winners';
    let body;
    if (!this._tracking) {
      body = `<div class="pad err">Tracking is disabled in this card's config.</div>`;
    } else if (this._error) {
      body = `<div class="pad err">Couldn't load results: ${esc(this._error)}</div>`;
    } else if (!this._rows) {
      body = `<div class="pad muted">Loading…</div>`;
    } else {
      body = this._historyView();
    }
    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="hdr">
          <div class="title">${esc(title)}${this._player ? `<span class="pill">${esc(this._player)}</span>` : ''}</div>
          <button class="ghost" id="refresh" ${this._busy ? 'disabled' : ''}>${this._busy ? 'Loading…' : 'Refresh'}</button>
        </div>
        ${body}
        <div class="foot">bracket-history-card v${CARD_VERSION}</div>
      </ha-card>
      <style>${STYLE}${HISTORY_STYLE}</style>`;
    const root = this.shadowRoot;
    const refresh = root.querySelector('#refresh');
    if (refresh) refresh.onclick = () => this._load();
    const sel = root.querySelector('#filter');
    if (sel) sel.onchange = (e) => { this._filter = e.target.value; this._render(); };
    const back = root.querySelector('#back');
    if (back) back.onclick = () => { this._player = null; this._render(); };
    root.querySelectorAll('[data-view]').forEach((el) => {
      el.onclick = () => { this._view = el.getAttribute('data-view'); this._player = null; this._render(); };
    });
    root.querySelectorAll('[data-sort]').forEach((el) => {
      el.onclick = () => { this._sort = el.getAttribute('data-sort'); this._render(); };
    });
    // Any name anywhere opens that player's page.
    root.querySelectorAll('[data-player]').forEach((el) => {
      el.onclick = () => { this._player = el.getAttribute('data-player'); this._render(); };
    });
  }

  /* ---- the views ---- */

  _historyView() {
    const rows = this._rows;
    if (!rows.length) {
      return `<div class="pad muted">No results recorded yet. Finish a tournament with tracking on and it will show up here.</div>`;
    }
    const scoped = this._filter
      ? rows.filter((r) => (r.game || 'Untitled') === this._filter) : rows;

    if (this._player) return this._playerView(scoped);
    const view = this._view || 'champions';
    const body = view === 'league' ? this._leagueView(scoped)
      : view === 'h2h' ? this._h2hView(scoped)
      : view === 'history' ? this._resultsView(scoped)
      : this._championsView(scoped);
    return this._chrome(rows, view) + body;
  }

  // Tabs and the game filter, shared by every view.
  _chrome(rows, view) {
    const games = [...new Set(rows.map((r) => r.game || 'Untitled'))].sort();
    const tabs = [
      ['champions', 'Champions'],
      ['league', 'League'],
      ['h2h', 'Head to head'],
      ['history', 'History'],
    ];
    return `
      <div class="pad bar">
        <div class="tabs">${tabs.map(([id, label]) =>
          `<button class="tab${id === view ? ' on' : ''}" data-view="${id}">${label}</button>`).join('')}</div>
        ${games.length > 1 ? `
          <select id="filter" title="Show one game only">
            <option value="">All games</option>
            ${games.map((g) => `<option value="${esc(g)}" ${g === this._filter ? 'selected' : ''}>${esc(g)}</option>`).join('')}
          </select>` : ''}
      </div>`;
  }

  /* ---- champions: belts, this season, the board ---- */
  _championsView(rows) {
    const held = belts(rows);
    const board = leaderboard(rows, { sort: this._sort || 'wins' });
    const years = seasons(rows);
    const season = years[0];
    const day = onThisDay(rows, new Date());

    const beltRow = held.length ? `
      <div class="pad">
        <div class="sub">Title holders</div>
        <div class="belts">${held.map((b) => `
          <div class="belt">
            <div class="belt-game">${esc(b.game)}</div>
            <div class="belt-holder" data-player="${esc(b.holder)}">👑 ${esc(b.holder)}</div>
            <div class="muted tiny">${b.defences
              ? `${b.defences} defence${b.defences === 1 ? '' : 's'}`
              : 'just won it'}${b.previous ? ` · took it from ${esc(b.previous)}` : ''}</div>
            <div class="muted tiny">${esc(fmtDate(b.wonAt))}</div>
          </div>`).join('')}</div>
      </div>` : '';

    const seasonBlock = season ? `
      <div class="pad">
        <div class="sub">${season.year} so far</div>
        <div class="champ">🏆 ${season.year} leader:&nbsp;<strong>${esc(season.champion.name)}</strong>
          <span class="tnote">${season.champion.points} pts · ${season.champion.wins} win${season.champion.wins === 1 ? '' : 's'} from ${season.champion.appearances} played · ${season.events} event${season.events === 1 ? '' : 's'}</span>
        </div>
      </div>` : '';

    const sorts = [['wins', 'Wins'], ['rate', 'Win rate'], ['points', 'Points'], ['rating', 'Rating']];
    const boardBlock = `
      <div class="pad">
        <div class="sub row-between">
          <span>Leaderboard</span>
          <span class="sorts">${sorts.map(([id, label]) =>
            `<button class="chipbtn${(this._sort || 'wins') === id ? ' on' : ''}" data-sort="${id}">${label}</button>`).join('')}</span>
        </div>
        <table>
          <tr class="th"><td></td><td>Player</td><td class="num">W</td><td class="num">2nd</td>
              <td class="num">Played</td><td class="num">Rate</td><td class="num">Pts</td>
              <td class="num">Rating</td><td>Form</td></tr>
          ${board.map((p, i) => `
            <tr>
              <td class="rank">${i + 1}</td>
              <td><button class="linkish" data-player="${esc(p.name)}">${esc(p.name)}</button>${streakBadge(p)}</td>
              <td class="num"><strong>${p.wins}</strong></td>
              <td class="num muted">${p.runnerUps}</td>
              <td class="num muted">${p.appearances}</td>
              <td class="num">${pct(p.winRate)}</td>
              <td class="num">${p.points}</td>
              <td class="num muted">${p.rating}</td>
              <td class="nowrap">${formDots(p.form)}</td>
            </tr>`).join('')}
        </table>
        <p class="muted tiny">Points: a placing in a field of n is worth n − place + 1. Rating starts at ${ELO_START} and moves with who you beat.</p>
      </div>`;

    const dayBlock = day.length ? `
      <div class="pad">
        <div class="sub">On this day</div>
        ${day.slice(0, 3).map((r) => `
          <div class="onthisday">${r.yearsAgo} year${r.yearsAgo === 1 ? '' : 's'} ago —
            <strong>${esc(r.winner)}</strong> won ${esc(r.game || 'Untitled')}${r.runner_up ? `, beating ${esc(r.runner_up)}` : ''}.</div>`).join('')}
      </div>` : '';

    return beltRow + seasonBlock + boardBlock + dayBlock;
  }

  /* ---- league: season tables and formats ---- */
  _leagueView(rows) {
    const years = seasons(rows);
    const formats = byFormat(rows);
    const big = biggestWins(rows, { limit: 3 });

    const seasonBlocks = years.map((season) => `
      <div class="pad">
        <div class="sub">${season.year} — ${season.events} event${season.events === 1 ? '' : 's'}, ${season.games.length} game${season.games.length === 1 ? '' : 's'}</div>
        <table>
          <tr class="th"><td></td><td>Player</td><td class="num">Pts</td><td class="num">W</td>
              <td class="num">Played</td><td class="num">Rating</td></tr>
          ${season.table.map((p, i) => `
            <tr${i === 0 ? ' class="leader"' : ''}>
              <td class="rank">${i + 1}</td>
              <td><button class="linkish" data-player="${esc(p.name)}">${esc(p.name)}</button>${i === 0 ? ' 🏆' : ''}</td>
              <td class="num"><strong>${p.points}</strong></td>
              <td class="num">${p.wins}</td>
              <td class="num muted">${p.appearances}</td>
              <td class="num muted">${p.rating}</td>
            </tr>`).join('')}
        </table>
      </div>`).join('');

    const formatBlock = formats.length ? `
      <div class="pad">
        <div class="sub">By format</div>
        <table>
          <tr class="th"><td>Format</td><td class="num">Events</td><td>Winners</td></tr>
          ${formats.map((f) => `
            <tr>
              <td>${esc(modeLabelFromTag(f.mode))}</td>
              <td class="num muted">${f.events}</td>
              <td>${f.winners.slice(0, 4).map((w) =>
                `<span class="pillcount"><button class="linkish" data-player="${esc(w.name)}">${esc(w.name)}</button> ${w.wins}</span>`).join(' ')}</td>
            </tr>`).join('')}
        </table>
      </div>` : '';

    const bigBlock = big.length ? `
      <div class="pad">
        <div class="sub">Biggest fields</div>
        ${big.map((r) => `<div class="onthisday"><strong>${esc(r.winner)}</strong> beat ${r.field - 1} others at ${esc(r.game || 'Untitled')} — ${esc(fmtDate(r.time))}</div>`).join('')}
      </div>` : '';

    return seasonBlocks + formatBlock + bigBlock;
  }

  /* ---- head to head ---- */
  _h2hView(rows) {
    const h = headToHead(rows);
    const rivals = rivalries(rows, { min: 1 });
    if (!h.players.length) {
      return `<div class="pad muted">No finals with a named runner-up yet — this fills in as tournaments finish.</div>`;
    }
    const grid = `
      <div class="pad">
        <div class="sub">Finals won against</div>
        <div class="scroll tight">
          <table class="matrix">
            <tr class="th"><td></td>${h.players.map((p) => `<td class="num">${esc(p)}</td>`).join('')}</tr>
            ${h.players.map((a) => `
              <tr><td class="nowrap"><button class="linkish" data-player="${esc(a)}">${esc(a)}</button></td>
                ${h.players.map((b) => {
                  if (a === b) return `<td class="num self">—</td>`;
                  const w = h.wins(a, b), l = h.wins(b, a);
                  if (!w && !l) return `<td class="num muted">·</td>`;
                  return `<td class="num ${w > l ? 'ahead' : w < l ? 'behind' : ''}">${w}–${l}</td>`;
                }).join('')}
              </tr>`).join('')}
          </table>
        </div>
        <p class="muted tiny">Read across: how often that player has beaten each other player in a final.</p>
      </div>`;

    const rivalBlock = rivals.length ? `
      <div class="pad">
        <div class="sub">Rivalries</div>
        <table>
          ${rivals.slice(0, 8).map((r) => `
            <tr>
              <td class="nowrap"><button class="linkish" data-player="${esc(r.a)}">${esc(r.a)}</button>
                <span class="muted">v</span>
                <button class="linkish" data-player="${esc(r.b)}">${esc(r.b)}</button></td>
              <td class="num"><strong>${r.aWins}–${r.bWins}</strong></td>
              <td class="muted">${r.leader ? `${esc(r.leader)} leads` : 'all square'} · ${r.meetings} final${r.meetings === 1 ? '' : 's'}</td>
            </tr>`).join('')}
        </table>
      </div>` : '';

    return grid + rivalBlock;
  }

  /* ---- the plain results list ---- */
  _resultsView(rows) {
    const detail = (r) => {
      if (r.mode === 'king_of_the_hill') {
        const bits = [];
        if (Number.isFinite(r.top_wins)) bits.push(`${r.top_wins} wins on top`);
        if (Number.isFinite(r.games)) bits.push(`${r.games} games`);
        if (Number.isFinite(r.sessions) && r.sessions > 1) bits.push(`${r.sessions} sessions`);
        return `<span class="muted"> — 👑 ${bits.join(' · ') || 'king of the hill'}</span>`;
      }
      return r.runner_up ? `<span class="muted"> beat ${esc(r.runner_up)}</span>` : '';
    };
    return `
      <div class="pad">
        <table>
          ${rows.map((r) => `
            <tr>
              <td class="muted nowrap">${esc(fmtDate(r.time))}</td>
              <td>${esc(r.game || 'Untitled')}
                <div class="muted tiny">${esc(modeLabelFromTag(r.mode))}${r.temp === true ? ' <span class="tag">one-off</span>' : ''}</div></td>
              <td><button class="linkish"><strong data-player="${esc(r.winner)}">${esc(r.winner)}</strong></button>${detail(r)}
                ${r.placings ? `<div class="muted tiny">${esc(r.placings)}</div>`
                  : r.players ? `<div class="muted tiny">Players: ${esc(r.players)}</div>` : ''}
                ${r.standings ? `<div class="muted tiny">${esc(r.standings)}</div>` : ''}</td>
            </tr>`).join('')}
        </table>
      </div>`;
  }

  /* ---- one player ---- */
  _playerView(rows) {
    const name = this._player;
    const board = leaderboard(rows);
    const p = board.find((x) => x.name === name);
    if (!p) {
      return `<div class="pad"><button class="ghost" id="back">← Back</button>
        <p class="muted">Nothing recorded for ${esc(name)}.</p></div>`;
    }
    const held = belts(rows).filter((b) => b.holder === name);
    const recent = p.results.slice().reverse().slice(0, 8);
    const stat = (label, value, note = '') =>
      `<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div>${note ? `<div class="muted tiny">${note}</div>` : ''}</div>`;

    return `
      <div class="pad bar">
        <button class="ghost" id="back">← Back</button>
        <div class="who">${esc(name)}${held.length ? ` <span class="muted">— holds ${held.map((b) => esc(b.game)).join(', ')}</span>` : ''}</div>
      </div>
      <div class="pad stats">
        ${stat('Wins', p.wins, `from ${p.appearances} played`)}
        ${stat('Win rate', pct(p.winRate))}
        ${stat('Points', p.points)}
        ${stat('Rating', p.rating)}
        ${stat('Runner-up', p.runnerUps)}
        ${stat('Best field', p.bestField || '—', p.bestField ? `${p.bestField} players` : '')}
      </div>
      <div class="pad">
        <div class="sub">Form</div>
        <div>${formDots(p.form)} <span class="muted tiny">${streakLine(p)}</span></div>
      </div>
      <div class="pad grid">
        <div>
          <div class="sub">By game</div>
          <table>
            ${p.byGame.map((g) => `<tr><td>${esc(g.game)}</td><td class="num">${g.wins}/${g.played}</td>
              <td class="num muted">${pct(g.played ? g.wins / g.played : 0)}</td></tr>`).join('')}
          </table>
          ${p.bestGame ? `<p class="muted tiny">Best at ${esc(p.bestGame.game)}${p.worstGame && p.worstGame.game !== p.bestGame.game ? `, worst at ${esc(p.worstGame.game)}` : ''}.</p>` : ''}
        </div>
        <div>
          <div class="sub">By format</div>
          <table>
            ${p.byMode.map((m) => `<tr><td>${esc(modeLabelFromTag(m.mode))}</td><td class="num">${m.wins}/${m.played}</td>
              <td class="num muted">${pct(m.played ? m.wins / m.played : 0)}</td></tr>`).join('')}
          </table>
          ${p.nemesis ? `<p class="muted tiny">Beaten most often by <button class="linkish" data-player="${esc(p.nemesis.name)}">${esc(p.nemesis.name)}</button> (${p.nemesis.count}).</p>` : ''}
          ${p.favouriteVictim ? `<p class="muted tiny">Beats <button class="linkish" data-player="${esc(p.favouriteVictim.name)}">${esc(p.favouriteVictim.name)}</button> most (${p.favouriteVictim.count}).</p>` : ''}
        </div>
      </div>
      <div class="pad">
        <div class="sub">Recent results</div>
        <table>
          ${recent.map((r) => `<tr>
            <td class="muted nowrap">${esc(fmtDate(r.time))}</td>
            <td>${esc(r.game || 'Untitled')}</td>
            <td class="num">${r.won ? '🏆 1st' : ordinal(r.rank)}</td>
            <td class="num muted">of ${r.field}</td></tr>`).join('')}
        </table>
      </div>`;
  }
}

const HISTORY_STYLE = `
  .top { padding-bottom: 0; }
  .top:empty { display:none; }
  select { width:auto; padding: 6px 10px; }
  .tag { display:inline-block; padding: 0 6px; border-radius: 999px; font-size:.7rem;
         background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding-bottom: 0; }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; }
  .tab { font: inherit; font-size:.85rem; cursor:pointer; padding: 6px 12px; border-radius: 999px;
         border: 1px solid var(--divider-color, #e0e0e0); background: transparent;
         color: var(--primary-text-color); }
  .tab.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .chipbtn { font: inherit; font-size:.72rem; cursor:pointer; padding: 3px 9px; border-radius: 999px;
             border: 1px solid var(--divider-color, #e0e0e0); background: transparent;
             color: var(--secondary-text-color); margin-left: 4px; }
  .chipbtn.on { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .sorts { display:inline-flex; flex-wrap:wrap; }
  .row-between { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .linkish { font: inherit; background:none; border:none; padding:0; cursor:pointer;
             color: var(--primary-color); text-align:left; }
  .linkish:hover { text-decoration: underline; }
  .who { font-size: 1.05rem; font-weight: 600; }
  /* belts */
  .belts { display:flex; gap:10px; flex-wrap:wrap; }
  .belt { flex: 1 1 150px; min-width: 150px; padding: 10px 12px; border-radius: 10px;
          border: 1px solid var(--divider-color, #e0e0e0);
          background: var(--secondary-background-color); }
  .belt-game { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em;
               color: var(--secondary-text-color); font-weight:700; }
  .belt-holder { font-size: 1.05rem; font-weight: 700; margin: 2px 0 4px; cursor:pointer;
                 color: var(--primary-text-color); }
  /* form dots */
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:3px;
         background: var(--divider-color, #ccc); }
  .dot.won { background: var(--primary-color); }
  .badge.hot { background: var(--warning-color, #ffa600); color:#222; }
  .badge.cold { background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .badge { display:inline-block; padding: 0 6px; border-radius: 999px; font-size:.7rem; font-weight:700; }
  /* stats strip on a player page */
  .stats { display:grid; gap:10px; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); }
  .stat { padding: 8px 10px; border-radius: 10px;
          background: var(--secondary-background-color); }
  .stat-v { font-size: 1.25rem; font-weight: 700; }
  .stat-l { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em;
            color: var(--secondary-text-color); }
  /* head-to-head grid */
  .matrix td { text-align:center; padding: 5px 8px; white-space:nowrap; }
  .matrix td:first-child { text-align:left; }
  .matrix .self { color: var(--disabled-text-color, #9e9e9e); }
  .matrix .ahead { color: var(--success-color, #43a047); font-weight:700; }
  .matrix .behind { color: var(--error-color, #db4437); }
  .onthisday { font-size:.92rem; padding: 3px 0; }
  .pillcount { display:inline-block; margin-right: 8px; white-space:nowrap; }
  tr.leader td { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
`;

if (!customElements.get('bracket-card')) {
  customElements.define('bracket-card', BracketCard);
}
if (!customElements.get('bracket-history-card')) {
  customElements.define('bracket-history-card', BracketHistoryCard);
}

// Register in the card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'bracket-card',
  name: 'Bracket Card',
  description: 'Game-night tournaments: double/single elimination, round robin, Swiss, king of the hill, free-for-all.',
}, {
  type: 'bracket-history-card',
  name: 'Bracket History Card',
  description: 'Current champion, past winners and leaderboard from recorded results.',
});

console.info(
  `%c BRACKET-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#3f51b5;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
  'color:#3f51b5;background:#eee;border-radius:0 3px 3px 0;padding:2px 4px'
);
