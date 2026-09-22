/*! ha-bracket-card — bundled build. Do not edit dist/ directly; edit src/ and run "node build.mjs". */
/*
 * ha-bracket-card — double-elimination bracket engine
 *
 * Pure, dependency-free logic. No DOM, no Home Assistant references.
 * This same source is bundled into dist/ha-bracket-card.js and is unit-tested
 * directly with node (see test/bracket.test.mjs).
 *
 * STATE SHAPE
 * -----------
 * {
 *   version: 2,
 *   createdAt: <iso string>,
 *   size: <bracket size, power of 2>,
 *   resetBracket: <bool>,          // allow grand-final "bracket reset"
 *   players: [ "Alice", "Bob", ... ],   // entry order = seed order
 *   matches: {
 *     <id>: {
 *       id, bracket: 'W'|'L'|'GF', round, order,
 *       p1, p2,                    // participant refs (see below) or null
 *       winner,                    // 'p1' | 'p2' | null
 *       // routing (set at generation time):
 *       winnerTo: { match, slot } | null,
 *       loserTo:  { match, slot } | null
 *     }, ...
 *   },
 *   order: [ <id>, ... ]           // stable display order
 * }
 *
 * PARTICIPANT REF
 * ---------------
 * A slot (p1/p2) holds one of:
 *   { type:'player', seed:<n>, name:<string> }
 *   { type:'bye' }
 *   { type:'from', match:<id>, side:'winner'|'loser' }   // unresolved feeder
 *   null                                                 // nothing yet
 */

const BYE = () => ({ type: 'bye' });

function nextPow2(n) {
  let s = 1;
  while (s < n) s *= 2;
  return Math.max(2, s);
}

// Standard single-elimination seeding order for a bracket of `size`.
// Returns an array of seed numbers (1-based) in slot order, such that top
// seeds are maximally separated and byes (highest seeds) meet top seeds first.
function seedOrder(size) {
  let seeds = [1, 2];
  let rounds = Math.log2(size);
  for (let r = 1; r < rounds; r++) {
    const out = [];
    const sum = Math.pow(2, r + 1) + 1;
    for (const s of seeds) {
      out.push(s);
      out.push(sum - s);
    }
    seeds = out;
  }
  return seeds;
}

function wbRounds(size) {
  return Math.log2(size);
}

// Number of matches in winners-bracket round r (1-based).
function wbMatchCount(size, r) {
  return size / Math.pow(2, r);
}

/*
 * Build the full match graph for `players` (array of names, entry order used
 * as seeding). Handles any count >= 2 via byes to the next power of two.
 */
function generateBracket(players, opts = {}) {
  const names = players.map((p) => String(p).trim()).filter((p) => p.length > 0);
  if (names.length < 2) {
    throw new Error('Need at least 2 players');
  }
  const size = nextPow2(names.length);
  const W = wbRounds(size);
  const resetBracket = opts.resetBracket !== false;

  const matches = {};
  const order = [];
  const add = (m) => {
    matches[m.id] = m;
    order.push(m.id);
    return m;
  };

  // ---- Winners bracket ----
  const wb = []; // wb[r-1] = array of match ids
  const placement = round1Placement(names, size);

  for (let r = 1; r <= W; r++) {
    const count = wbMatchCount(size, r);
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `W${r}-${i + 1}`;
      const m = add({
        id, bracket: 'W', round: r, order: i,
        p1: null, p2: null, winner: null,
        winnerTo: null, loserTo: null,
      });
      ids.push(id);
      if (r === 1) {
        const [a, b] = placement[i];
        m.p1 = a == null ? BYE() : { type: 'player', seed: a + 1, name: names[a] };
        m.p2 = b == null ? BYE() : { type: 'player', seed: b + 1, name: names[b] };
      }
    }
    wb.push(ids);
  }
  // Wire winners advancement.
  for (let r = 1; r < W; r++) {
    wb[r - 1].forEach((id, i) => {
      const target = wb[r][Math.floor(i / 2)];
      matches[id].winnerTo = { match: target, slot: i % 2 === 0 ? 'p1' : 'p2' };
    });
  }

  // ---- Losers bracket ----
  // LB has 2*(W-1) rounds. Rounds come in pairs (minor, major) per k=1..W-1.
  //   LB round (2k-1): "minor" — winners of previous LB round play each other
  //                    (k==1 special: WB R1 losers play each other).
  //   LB round (2k):   "major" — winner of LB(2k-1) vs a WB round (k+1) loser.
  const lb = []; // lb[j-1] = array of ids for LB round j
  const lbRoundCount = 2 * (W - 1);
  for (let j = 1; j <= lbRoundCount; j++) {
    const k = Math.ceil(j / 2);
    const count = size / Math.pow(2, k + 1);
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `L${j}-${i + 1}`;
      add({
        id, bracket: 'L', round: j, order: i,
        p1: null, p2: null, winner: null,
        winnerTo: null, loserTo: null,
      });
      ids.push(id);
    }
    lb.push(ids);
  }

  // Wire LB internal advancement (winner of LB round j -> next LB round).
  for (let j = 1; j < lbRoundCount; j++) {
    const from = lb[j - 1];
    const to = lb[j];
    const nextIsMinor = (j + 1) % 2 === 1; // next round is odd => minor (consolidation)
    from.forEach((id, i) => {
      let target, slot;
      if (nextIsMinor) {
        // two winners collapse into one match
        target = to[Math.floor(i / 2)];
        slot = i % 2 === 0 ? 'p1' : 'p2';
      } else {
        // major round: LB winner takes p1, WB dropout takes p2 (1:1 mapping)
        target = to[i];
        slot = 'p1';
      }
      matches[id].winnerTo = { match: target, slot };
    });
  }

  // Wire WB losers dropping into LB (only when a losers bracket exists;
  // size 2 has W=1 and no LB — that loser goes straight to the grand final).
  if (lbRoundCount >= 1) {
    // WB R1 losers -> LB R1 (2 per match, fill p1/p2).
    wb[0].forEach((id, i) => {
      const target = lb[0][Math.floor(i / 2)];
      matches[id].loserTo = { match: target, slot: i % 2 === 0 ? 'p1' : 'p2' };
    });
    // WB round (k+1) losers -> LB round 2k, slot p2 (1:1).
    for (let k = 1; k <= W - 1; k++) {
      const wbRound = k + 1;          // 2..W
      const lbRound = 2 * k;          // 2,4,6...
      const fromIds = wb[wbRound - 1];
      const toIds = lb[lbRound - 1];
      // Reverse the drop order to reduce early rematches (standard practice).
      fromIds.forEach((id, i) => {
        const target = toIds[toIds.length - 1 - i] || toIds[i];
        matches[id].loserTo = { match: target, slot: 'p2' };
      });
    }
  }

  // ---- Grand final ----
  const wbFinal = wb[W - 1][0];
  const lbFinal = lbRoundCount >= 1 ? lb[lbRoundCount - 1][0] : null;
  add({
    id: 'GF-1', bracket: 'GF', round: 1, order: 0,
    p1: { type: 'from', match: wbFinal, side: 'winner' },
    p2: lbFinal
      ? { type: 'from', match: lbFinal, side: 'winner' }
      : { type: 'from', match: wbFinal, side: 'loser' },
    winner: null, winnerTo: null, loserTo: null,
  });
  matches[wbFinal].winnerTo = { match: 'GF-1', slot: 'p1' };
  if (lbFinal) {
    matches[lbFinal].winnerTo = { match: 'GF-1', slot: 'p2' };
  } else {
    // Size-2 bracket: the sole match's loser is the grand-final challenger.
    matches[wbFinal].loserTo = { match: 'GF-1', slot: 'p2' };
  }

  if (resetBracket) {
    // GF-2 only comes alive if the LB entrant (p2) wins GF-1.
    add({
      id: 'GF-2', bracket: 'GF', round: 2, order: 0,
      p1: null, p2: null, winner: null, winnerTo: null, loserTo: null,
    });
  }

  const state = {
    version: 2,
    createdAt: new Date().toISOString(),
    size,
    resetBracket,
    players: names,
    matches,
    order,
  };
  return resolve(state);
}

/*
 * Round-1 slot layout that pushes byes as late as possible.
 *
 * Classic seeding (see seedOrder) hands every bye out in round 1, so 5 players
 * in an 8-slot bracket produce a single real match and three walkovers. This
 * instead plays as many full matches as the count allows, then at most one
 * player-vs-bye, and fills what's left with bye-vs-bye (which the renderer
 * hides). The non-full matches are interleaved with full ones so that each
 * feeds a round-2 match alongside a real winner — so the player who sat out
 * round 1 plays in round 2 rather than walking over twice in a row.
 *
 * Returns size/2 pairs of player indices; null means a bye in that slot.
 */
function round1Placement(names, size) {
  const n = names.length;
  const full = Math.floor(n / 2);
  const kinds = [];
  for (let i = 0; i < full; i++) kinds.push([2 * i, 2 * i + 1]);
  const nonFull = [];
  if (n % 2 === 1) nonFull.push([n - 1, null]);
  while (kinds.length + nonFull.length < size / 2) nonFull.push([null, null]);

  // Interleave so every non-full match sits next to a full one in its
  // round-2 pair. There are always at least as many full as non-full.
  const out = [];
  let f = 0, e = 0;
  while (out.length < size / 2) {
    if (f < kinds.length) out.push(kinds[f++]);
    if (e < nonFull.length && out.length < size / 2) out.push(nonFull[e++]);
  }
  return out;
}

// Is a slot a "real" player that can win?
function isPlayer(ref) {
  return ref && ref.type === 'player';
}
function isBye(ref) {
  return ref && ref.type === 'bye';
}

/*
 * Propagate byes and auto-advance decided matches through the graph until it
 * reaches a fixed point. Safe to call repeatedly. Returns the same (mutated)
 * state object for convenience.
 */
function resolve(state) {
  const m = state.matches;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (const id of state.order) {
      const match = m[id];

      // Auto-decide byes: if a slot is a bye and the other is a real player,
      // the player wins automatically. If both are byes, the match is a bye.
      if (match.winner == null) {
        const p1Bye = isBye(match.p1);
        const p2Bye = isBye(match.p2);
        if (p1Bye && isPlayer(match.p2)) { match.winner = 'p2'; changed = true; }
        else if (p2Bye && isPlayer(match.p1)) { match.winner = 'p1'; changed = true; }
        else if (p1Bye && p2Bye && (match.p1 || match.p2)) {
          // both byes -> propagate a bye onward, mark resolved with no winner
          match.winner = 'bye'; changed = true;
        }
      }

      if (match.winner == null) continue;

      // Push winner onward.
      if (match.winnerTo) {
        const w = match.winner === 'bye' ? BYE() : cloneWinner(match);
        if (setSlot(m, match.winnerTo, w)) changed = true;
      }
      // Push loser onward (only for real decisions, not byes).
      if (match.loserTo) {
        let loserRef;
        if (match.winner === 'bye') loserRef = BYE();
        else loserRef = cloneLoser(match);
        if (setSlot(m, match.loserTo, loserRef)) changed = true;
      }
    }
  }
  return state;
}

function cloneWinner(match) {
  const ref = match.winner === 'p1' ? match.p1 : match.p2;
  return ref ? { ...ref } : BYE();
}
function cloneLoser(match) {
  const ref = match.winner === 'p1' ? match.p2 : match.p1;
  return ref ? { ...ref } : BYE();
}

// Write a participant ref into target slot if different. Returns true if changed.
function setSlot(m, target, ref) {
  const match = m[target.match];
  if (!match) return false;
  const cur = match[target.slot];
  if (participantEq(cur, ref)) return false;
  // Only overwrite feeder placeholders / null / bye — never stomp a decided value
  // that already matches a concrete player unless it truly changed.
  match[target.slot] = ref;
  return true;
}

function participantEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'player') return a.seed === b.seed;
  return true; // bye===bye, from===from(don't care)
}

/*
 * Record a winner for a match (called by the UI). side is 'p1' or 'p2'.
 * Re-resolves the whole graph afterwards. Also handles grand-final reset logic.
 */
function setWinner(state, matchId, side) {
  const m = state.matches;
  const match = m[matchId];
  if (!match) throw new Error('Unknown match ' + matchId);
  if (!isPlayer(match[side])) return state; // can't pick an empty/bye slot

  match.winner = side;

  // Grand final special handling.
  if (matchId === 'GF-1' && state.resetBracket && m['GF-2']) {
    const gf2 = m['GF-2'];
    if (side === 'p2') {
      // LB entrant won game 1 -> bracket reset: play GF-2 with same two players.
      gf2.p1 = match.p1 ? { ...match.p1 } : null;
      gf2.p2 = match.p2 ? { ...match.p2 } : null;
      gf2.winner = null;
    } else {
      // WB entrant won -> tournament over, GF-2 not needed.
      gf2.p1 = null; gf2.p2 = null; gf2.winner = null;
    }
  }

  return resolve(state);
}

/*
 * Compute the champion, if any.
 * Returns { name } or null.
 */
// Returns { name, runnerUp } once the tournament is decided, else null.
function champion(state) {
  const m = state.matches;
  const decided = (match) => {
    const win = match.winner === 'p1' ? match.p1 : match.p2;
    const lose = match.winner === 'p1' ? match.p2 : match.p1;
    if (!isPlayer(win)) return null;
    return { name: win.name, runnerUp: isPlayer(lose) ? lose.name : null };
  };
  const gf2 = m['GF-2'];
  if (gf2 && gf2.winner && gf2.winner !== 'bye') return decided(gf2);
  const gf1 = m['GF-1'];
  if (gf1 && gf1.winner && gf1.winner !== 'bye') {
    // If reset is enabled and LB entrant won GF-1, GF-2 decides it (not done yet).
    if (state.resetBracket && m['GF-2'] && gf1.winner === 'p2') return null;
    return decided(gf1);
  }
  return null;
}

// Convenience for tests / UI: display label for a slot.
function slotLabel(ref) {
  if (!ref) return '';
  if (ref.type === 'player') return ref.name;
  if (ref.type === 'bye') return 'BYE';
  return '';
}

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

const CARD_VERSION = '1.2.0';

/* ---------- compact persistence ---------- */
// Persisted form: {"v":2,"p":[names],"w":"codes","x":0|1,"g":"game","c":epoch,"r":1}
// `w` is one char per match in canonical order: '0' undecided, '1' p1, '2' p2.
// `g` (game name), `c` (created, epoch seconds) and `r` (result recorded) are
// optional so brackets stored by older versions still decode.

function encodeState(players, resetBracket, decisions, meta = {}) {
  // Rebuild to obtain canonical order, then emit codes for user decisions only.
  const s = rebuild(players, resetBracket, decisions);
  let w = '';
  for (const id of s.order) {
    const d = decisions[id];
    w += d === 'p1' ? '1' : d === 'p2' ? '2' : '0';
  }
  const out = { v: 2, p: players, w, x: resetBracket ? 1 : 0 };
  if (meta.game) out.g = meta.game;
  if (meta.created) out.c = meta.created;
  if (meta.recorded) out.r = 1;
  return JSON.stringify(out);
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
  return {
    players: obj.p, resetBracket, decisions,
    game: typeof obj.g === 'string' ? obj.g : '',
    created: Number.isFinite(obj.c) ? obj.c : 0,
    recorded: obj.r === 1,
  };
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

function resultLine(measurement, { game, winner, runnerUp, players, created }) {
  const tags = `game=${lpTag(game || 'Untitled')}`;
  const fields = [
    `winner=${lpStr(winner)}`,
    `runner_up=${lpStr(runnerUp || '')}`,
    `players=${lpStr(players.join(', '))}`,
    `player_count=${players.length}i`,
  ].join(',');
  // Timestamp = bracket creation (seconds), so re-recording a corrected result
  // overwrites the same point instead of adding a second one.
  return `${measurement},${tags} ${fields} ${created}`;
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
    this._game = '';        // setup game-name input
    this._confirmReset = false;
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

  _save(players, resetBracket, decisions, meta) {
    const value = encodeState(players, resetBracket, decisions, meta);
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
    const meta = { game: this._game.trim(), created: Math.floor(Date.now() / 1000) };
    const value = encodeState(names, resetBracket, {}, meta);
    if (value.length > 255 && /^input_text\./.test(this._config.entity)) {
      this._flash('Too much data for a 255-char input_text. Use shorter names, fewer players, or a "text" helper with a higher max.');
      return;
    }
    this._track = { busy: false, error: null };
    this._save(names, resetBracket, {}, meta);
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
    const meta = { game: decoded.game, created: decoded.created, recorded: decoded.recorded };
    const done = champion(rebuild(players, resetBracket, decisions));
    // A correction that un-decides the tournament also un-records it, so the
    // corrected result gets written (over the same point) when it's decided.
    if (!done) meta.recorded = false;
    this._save(players, resetBracket, decisions, meta);
    if (done && this._tracking && !meta.recorded) this._recordResult(done);
  }

  // Write the decided result to InfluxDB through the configured rest_command,
  // then flag the bracket as recorded so no device writes it twice.
  async _recordResult(champ) {
    if (this._track.busy) return;
    const decoded = decodeState(this._lastRaw);
    if (!decoded) return;
    this._track = { busy: true, error: null };
    this._render();
    const line = resultLine(this._tracking.measurement, {
      game: decoded.game, winner: champ.name, runnerUp: champ.runnerUp,
      players: decoded.players, created: decoded.created || Math.floor(Date.now() / 1000),
    });
    try {
      await callWithResponse(this._hass, this._tracking.write_service, { line });
      this._track = { busy: false, error: null };
      const fresh = decodeState(this._lastRaw) || decoded;
      this._save(fresh.players, fresh.resetBracket, fresh.decisions,
        { game: fresh.game, created: fresh.created, recorded: true });
    } catch (e) {
      const msg = (e && (e.message || e.error)) || String(e);
      this._track = { busy: false, error: msg };
      this._render();
    }
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
          <div class="title">${esc(title)}${decoded && decoded.game
            ? `<span class="game">${esc(decoded.game)}</span>` : ``}</div>
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
        <label class="lbl" for="game">Game</label>
        <input id="game" type="text" placeholder="e.g. Mario Kart, UNO" value="${esc(this._game)}" maxlength="40">
        <label class="lbl" for="draft">Players</label>
        <p class="muted">One per line. The draw is shuffled and a double-elimination bracket is built automatically.</p>
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

    let trackNote = '';
    if (champ && this._tracking) {
      if (this._track.busy) trackNote = `<span class="tnote">Saving result…</span>`;
      else if (this._track.error) trackNote = `<span class="tnote terr">Not saved: ${esc(this._track.error)}</span> <button class="ghost small" id="retry">Retry</button>`;
      else if (decoded.recorded) trackNote = `<span class="tnote">Result recorded ✓</span>`;
      else trackNote = `<button class="ghost small" id="retry">Record result</button>`;
    }
    const champBanner = champ
      ? `<div class="champ">🏆 Champion:&nbsp;<strong>${esc(champ.name)}</strong>${trackNote}</div>`
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
    const game = $('#game');
    if (game) game.oninput = (e) => { this._game = e.target.value; };
    const retry = $('#retry');
    if (retry) retry.onclick = () => {
      const c = this._state && champion(this._state);
      if (c) this._recordResult(c);
    };
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
  .title { font-size: 1.25rem; font-weight: 600; color: var(--primary-text-color);
           display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .game { font-size:.8rem; font-weight:600; padding: 2px 10px; border-radius: 999px;
          background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .lbl { display:block; font-size:.8rem; font-weight:600; margin: 8px 0 4px;
         color: var(--secondary-text-color); }
  input[type=text] { width:100%; box-sizing:border-box; font: inherit; padding:10px;
             border:1px solid var(--divider-color, #e0e0e0); border-radius:8px;
             background: var(--card-background-color); color: var(--primary-text-color); }
  .tnote { font-size:.8rem; font-weight:400; margin-left: 12px; opacity:.9; }
  .terr { color: var(--error-color, #db4437); }
  .ghost.small { padding: 2px 10px; font-size:.8rem; margin-left: 8px; }
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
           display:flex; align-items:center; flex-wrap:wrap;
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
    this._lastRaw = undefined;
  }

  setConfig(config) {
    this._config = { limit: 100, ...config, tracking: config.tracking == null ? true : config.tracking };
    this._tracking = trackingConfig(this._config);
    if (this._config.game) this._filter = String(this._config.game);
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
    const q = `SELECT "winner", "runner_up", "players", "player_count", "game" FROM "${this._tracking.measurement}" ORDER BY time DESC LIMIT ${limit}`;
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
          <div class="title">${esc(title)}</div>
          <button class="ghost" id="refresh" ${this._busy ? 'disabled' : ''}>${this._busy ? 'Loading…' : 'Refresh'}</button>
        </div>
        ${body}
        <div class="foot">bracket-history-card v${CARD_VERSION}</div>
      </ha-card>
      <style>${STYLE}${HISTORY_STYLE}</style>`;
    const refresh = this.shadowRoot.querySelector('#refresh');
    if (refresh) refresh.onclick = () => this._load();
    const sel = this.shadowRoot.querySelector('#filter');
    if (sel) sel.onchange = (e) => { this._filter = e.target.value; this._render(); };
  }

  _historyView() {
    const all = this._rows;
    if (!all.length) return `<div class="pad muted">No results recorded yet. Finish a bracket with tracking on and it will show up here.</div>`;
    const games = [...new Set(all.map((r) => r.game || 'Untitled'))].sort();
    const rows = this._filter ? all.filter((r) => (r.game || 'Untitled') === this._filter) : all;
    const latest = rows[0];

    const wins = {};
    for (const r of rows) wins[r.winner] = (wins[r.winner] || 0) + 1;
    const board = Object.entries(wins).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const filter = games.length > 1 ? `
      <select id="filter">
        <option value="">All games</option>
        ${games.map((g) => `<option value="${esc(g)}" ${g === this._filter ? 'selected' : ''}>${esc(g)}</option>`).join('')}
      </select>` : '';

    const champ = latest ? `
      <div class="champ">🏆 Current champion:&nbsp;<strong>${esc(latest.winner)}</strong>
        <span class="tnote">${esc(latest.game || 'Untitled')} · ${esc(fmtDate(latest.time))}</span>
      </div>` : `<div class="pad muted">No results for this game yet.</div>`;

    return `
      <div class="pad top">${filter}</div>
      ${champ}
      <div class="pad grid">
        <div>
          <div class="sub">Leaderboard</div>
          <table>
            ${board.map(([n, c], i) => `<tr><td class="rank">${i + 1}</td><td>${esc(n)}</td><td class="num">${c} win${c === 1 ? '' : 's'}</td></tr>`).join('')}
          </table>
        </div>
        <div>
          <div class="sub">Results</div>
          <table>
            ${rows.map((r) => `<tr><td class="muted nowrap">${esc(fmtDate(r.time))}</td><td>${esc(r.game || 'Untitled')}</td><td><strong>${esc(r.winner)}</strong>${r.runner_up ? `<span class="muted"> beat ${esc(r.runner_up)}</span>` : ''}</td></tr>`).join('')}
          </table>
        </div>
      </div>`;
  }
}

const HISTORY_STYLE = `
  .top { padding-bottom: 0; }
  .top:empty { display:none; }
  select { font: inherit; padding: 6px 10px; border-radius: 8px;
           border:1px solid var(--divider-color, #e0e0e0);
           background: var(--card-background-color); color: var(--primary-text-color); }
  .grid { display:grid; grid-template-columns: minmax(160px, 1fr) 2fr; gap: 16px; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  .sub { font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; font-weight:700;
         margin-bottom: 6px; color: var(--secondary-text-color); }
  table { border-collapse: collapse; width:100%; font-size:.92rem; color: var(--primary-text-color); }
  td { padding: 6px 6px; border-bottom: 1px solid var(--divider-color, #e0e0e0); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .rank { color: var(--disabled-text-color, #9e9e9e); width: 1.5em; }
  .num { text-align:right; white-space:nowrap; }
  .nowrap { white-space:nowrap; }
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
  description: 'Reusable double-elimination tournament bracket for game night.',
}, {
  type: 'bracket-history-card',
  name: 'Bracket History Card',
  description: 'Current champion, past winners and leaderboard from recorded bracket results.',
});

console.info(
  `%c BRACKET-CARD %c v${CARD_VERSION} `,
  'color:#fff;background:#3f51b5;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
  'color:#3f51b5;background:#eee;border-radius:0 3px 3px 0;padding:2px 4px'
);
