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
  const single = opts.single === true;
  const resetBracket = !single && opts.resetBracket !== false;

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

  // Single elimination: the winners bracket is the whole tournament.
  if (single) {
    return resolve({
      version: 2, createdAt: new Date().toISOString(), size,
      single: true, resetBracket: false, players: names, matches, order,
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
    single: false,
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
  if (state.single) {
    const final = m[`W${Math.log2(state.size)}-1`];
    return final && final.winner && final.winner !== 'bye' ? decided(final) : null;
  }
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
 * ha-bracket-card — non-bracket tournament formats
 *
 * Pure, dependency-free logic for round robin, Swiss, king of the hill and
 * free-for-all. Like bracket.js, every format is rebuilt deterministically
 * from the player list plus a compact decisions string, so the card only
 * persists the decisions. Unit-tested in test/formats.test.mjs.
 *
 * Common result shape (what the card renders):
 *   {
 *     players: [names],
 *     standings: [{ idx, name, ...stats }],   // ranked, best first
 *     complete: bool,                         // nothing left to play (rr/swiss)
 *     tie: [names] | null,                    // unresolved tie at the top
 *     champion: { name, runnerUp } | null,
 *     ... format-specific fields
 *   }
 */

const cmpName = (a, b) => a.name.localeCompare(b.name);

/* ======================= paired formats (rr / swiss) ======================= */

// Circle-method round robin schedule. Returns rounds of [a, b] index pairs;
// a bye is [a, null] (odd player counts).
function roundRobinSchedule(n) {
  const ids = Array.from({ length: n }, (_, i) => i);
  if (n % 2 === 1) ids.push(null);
  const size = ids.length;
  const rounds = [];
  for (let r = 0; r < size - 1; r++) {
    const pairs = [];
    for (let i = 0; i < size / 2; i++) {
      const a = ids[i], b = ids[size - 1 - i];
      // Alternate who is "home" so nobody is always listed first.
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs.map(([a, b]) => (a == null ? [b, null] : [a, b])));
    // rotate all but the first
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

function decode(w, i) {
  const c = typeof w === 'string' ? w[i] : undefined;
  return c === '1' ? 'p1' : c === '2' ? 'p2' : null;
}

function emptyStats(players) {
  return players.map((name, idx) => ({ idx, name, wins: 0, losses: 0, played: 0, opponents: [], beat: new Set() }));
}

// Rank by wins, then by head-to-head record inside each tied group, then
// (Swiss) by strength of opposition, then name. Returns {standings, tie}
// where tie lists the names still level at the top after all tiebreaks.
function rank(stats, useBuchholz) {
  const rows = stats.map((s) => ({ ...s }));
  if (useBuchholz) {
    for (const r of rows) r.buchholz = r.opponents.reduce((acc, o) => acc + stats[o].wins, 0);
  }
  const h2h = (group) => {
    // wins against other members of the group
    for (const r of group) r.h2h = group.reduce((acc, o) => acc + (r.beat.has(o.idx) ? 1 : 0), 0);
  };
  const key = (r) => `${r.wins}|${r.h2h ?? ''}|${useBuchholz ? r.buchholz : ''}`;
  // First pass: split by wins, compute head-to-head inside each group.
  rows.sort((a, b) => b.wins - a.wins);
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j].wins === rows[i].wins) j++;
    h2h(rows.slice(i, j));
    i = j;
  }
  rows.sort((a, b) => b.wins - a.wins || b.h2h - a.h2h
    || (useBuchholz ? b.buchholz - a.buchholz : 0) || cmpName(a, b));
  const top = rows.filter((r) => key(r) === key(rows[0]));
  const tie = top.length > 1 ? top.map((r) => r.name) : null;
  for (const r of rows) delete r.beat;
  return { standings: rows, tie };
}

function applyMatch(stats, m) {
  if (m.p1 == null || m.p2 == null) return;
  if (m.winner !== 'p1' && m.winner !== 'p2') return;
  const w = m.winner === 'p1' ? m.p1 : m.p2;
  const l = m.winner === 'p1' ? m.p2 : m.p1;
  stats[w].wins++; stats[l].losses++;
  stats[w].played++; stats[l].played++;
  stats[w].opponents.push(l); stats[l].opponents.push(w);
  stats[w].beat.add(l);
}

/*
 * Round robin. Every match in the schedule is listed up front; `w` holds one
 * char per match in schedule order ('0' undecided, '1' p1, '2' p2).
 */
function roundRobin(players, w = '') {
  const n = players.length;
  const stats = emptyStats(players);
  const rounds = [];
  let i = 0;
  let undecided = 0;
  roundRobinSchedule(n).forEach((pairs, r) => {
    const matches = pairs.map(([a, b], k) => {
      const m = { id: `R${r + 1}-${k + 1}`, round: r + 1, p1: a, p2: b, winner: null, index: i };
      if (b == null) { m.winner = 'bye'; return m; } // no code consumed
      m.winner = decode(w, i++);
      if (!m.winner) undecided++;
      applyMatch(stats, m);
      return m;
    });
    rounds.push({ round: r + 1, matches });
  });
  const { standings, tie } = rank(stats, false);
  const complete = undecided === 0;
  return {
    kind: 'rr', players, rounds, matchCount: i, standings, complete, tie,
    champion: complete && !tie ? { name: standings[0].name, runnerUp: standings[1] ? standings[1].name : null } : null,
  };
}

/*
 * Swiss. `rounds` total; each round is paired from the current standings
 * (top plays the next-best they haven't met). Odd counts: the lowest-ranked
 * player without a bye yet sits out and takes a win. Pairings for round r+1
 * only exist once round r is fully decided, so they're reproducible.
 */
function swiss(players, w = '', opts = {}) {
  const n = players.length;
  const totalRounds = Math.max(1, opts.rounds || Math.ceil(Math.log2(Math.max(2, n))));
  const stats = emptyStats(players);
  const byes = new Set();
  const rounds = [];
  let i = 0;
  let complete = false;

  for (let r = 1; r <= totalRounds; r++) {
    // Order for pairing: by wins, then original seed (stable).
    const order = stats.map((s) => s.idx).sort((a, b) => stats[b].wins - stats[a].wins || a - b);
    const pending = [...order];
    let byeIdx = null;
    if (pending.length % 2 === 1) {
      for (let k = pending.length - 1; k >= 0; k--) {
        if (!byes.has(pending[k])) { byeIdx = pending.splice(k, 1)[0]; break; }
      }
      if (byeIdx == null) byeIdx = pending.pop();
      byes.add(byeIdx);
    }
    const matches = [];
    while (pending.length) {
      const a = pending.shift();
      let pick = pending.findIndex((b) => !stats[a].opponents.includes(b));
      if (pick < 0) pick = 0; // everyone left is a rematch; take the nearest
      const b = pending.splice(pick, 1)[0];
      matches.push({ id: `R${r}-${matches.length + 1}`, round: r, p1: a, p2: b, winner: null, index: i++ });
    }
    if (byeIdx != null) {
      matches.push({ id: `R${r}-${matches.length + 1}`, round: r, p1: byeIdx, p2: null, winner: 'bye', index: null });
      stats[byeIdx].wins++; stats[byeIdx].played++; stats[byeIdx].bye = true;
    }
    let undecided = 0;
    for (const m of matches) {
      if (m.p2 == null) continue;
      m.winner = decode(w, m.index);
      if (!m.winner) undecided++;
      applyMatch(stats, m);
    }
    rounds.push({ round: r, matches });
    if (undecided > 0) break;          // next round can't be paired yet
    if (r === totalRounds) complete = true;
  }
  const { standings, tie } = rank(stats, true);
  return {
    kind: 'swiss', players, rounds, totalRounds, matchCount: i, standings, complete, tie,
    champion: complete && !tie ? { name: standings[0].name, runnerUp: standings[1] ? standings[1].name : null } : null,
  };
}

/* ======================= king of the hill ======================= */
/*
 * Winner stays on. Player 1 starts as king; whoever is picked (or, by
 * default, whoever has waited longest) challenges; the loser goes to the
 * back of the queue. `w` is two chars per game: the challenger as a letter
 * (A-Z then a-z, see kothChallengerCode) and '1' the king held / '2' the
 * challenger took over. A `w` of bare 1/2 digits is the older form where
 * the queue always chose the challenger. Open-ended — `finished` ends it.
 *
 * A lineage can span sessions: `base` is a snapshot of where the previous
 * session left off (king, queue order, per-player totals, games played),
 * produced by kothSnapshot(). The champion is whoever holds the hill;
 * standings rank by wins while king, then the holder, then total wins.
 */
const KOTH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KOTH_MAX_PLAYERS = KOTH_LETTERS.length;
function kothChallengerCode(idx) { return KOTH_LETTERS[idx]; }

// Compact carry-over: { k: king idx, q: [queue idxs], s: [[kingWins, wins,
// losses, reigns, played] per player], g: games so far, n: sessions so far }.
function kothSnapshot(res) {
  const byIdx = [...res.standings].sort((a, b) => a.idx - b.idx);
  return {
    k: res.king, q: [...res.queue],
    s: byIdx.map((x) => [x.kingWins, x.wins, x.losses, x.reigns, x.played]),
    g: res.totalGames, n: res.sessions,
  };
}

function validBase(base, n) {
  return base && Number.isInteger(base.k) && base.k >= 0 && base.k < n
    && Array.isArray(base.q) && Array.isArray(base.s) && base.s.length === n;
}

function kingOfTheHill(players, w = '', finished = false, base = null) {
  const n = players.length;
  const stats = players.map((name, idx) => ({ idx, name, kingWins: 0, wins: 0, losses: 0, reigns: 0, played: 0 }));
  let queue = players.map((_, i) => i);
  let king;
  let priorGames = 0, sessions = 1;
  if (validBase(base, n)) {
    king = base.k;
    queue = base.q.filter((i) => Number.isInteger(i) && i >= 0 && i < n && i !== king);
    for (const i of players.keys()) if (i !== king && !queue.includes(i)) queue.push(i);
    base.s.forEach((row, i) => {
      const [kingWins = 0, wins = 0, losses = 0, reigns = 0, played = 0] = row || [];
      Object.assign(stats[i], { kingWins, wins, losses, reigns, played });
    });
    priorGames = Number.isInteger(base.g) ? base.g : 0;
    sessions = (Number.isInteger(base.n) ? base.n : 1) + 1;
  } else {
    king = queue.shift();
    stats[king].reigns++;
  }
  const games = [];
  const codes = typeof w === 'string' ? w : '';
  const legacy = codes.length > 0 && !/[A-Za-z]/.test(codes);
  for (let g = 0; g < codes.length;) {
    let challenger;
    let c;
    if (legacy) {
      challenger = queue[0];
      c = codes[g];
      g += 1;
    } else {
      challenger = KOTH_LETTERS.indexOf(codes[g]);
      c = codes[g + 1];
      g += 2;
    }
    if ((c !== '1' && c !== '2') || challenger == null || challenger < 0 || challenger >= n
        || challenger === king) break;
    queue.splice(queue.indexOf(challenger), 1);
    const game = { n: priorGames + games.length + 1, king, challenger, winner: c === '1' ? 'king' : 'challenger' };
    games.push(game);
    stats[king].played++; stats[challenger].played++;
    if (c === '1') {
      stats[king].kingWins++; stats[king].wins++; stats[challenger].losses++;
      queue.push(challenger);
    } else {
      stats[challenger].wins++; stats[challenger].reigns++; stats[king].losses++;
      queue.push(king);
      king = challenger;
    }
  }
  const standings = [...stats].sort((a, b) => b.kingWins - a.kingWins
    || (b.idx === king) - (a.idx === king) || b.wins - a.wins || cmpName(a, b));
  // Default challenger = longest wait; `queue` (in wait order) is the menu.
  const current = finished ? null : { king, challenger: queue[0] };
  const totalGames = priorGames + games.length;
  // The hill's holder is the champion; runner-up is the best of the rest.
  const rest = standings.filter((x) => x.idx !== king);
  const champion = finished && totalGames > 0
    ? { name: players[king], runnerUp: rest.length ? rest[0].name : null } : null;
  return {
    kind: 'koth', players, games, king, queue: [...queue], current, standings,
    finished, complete: finished, tie: null, champion, n, totalGames, sessions,
    kingWins: stats[king].kingWins,
  };
}

/* ======================= free-for-all ======================= */
/*
 * Everyone plays at once (a Mario Kart race, a hand of UNO). Each round is a
 * finishing order; players who sat out score 0. `w` is rounds joined by '|',
 * each round the player indices in finishing order as base-36 digits.
 * Points per place default to n, n-1, ... 1 (opts.points overrides).
 */
function freeForAll(players, w = '', finished = false, opts = {}) {
  const n = players.length;
  const points = Array.isArray(opts.points) && opts.points.length
    ? opts.points.map(Number) : players.map((_, i) => n - i);
  const stats = players.map((name, idx) => ({ idx, name, points: 0, rounds: 0, places: Array(n).fill(0) }));
  const rounds = [];
  const chunks = typeof w === 'string' && w.length ? w.split('|') : [];
  chunks.forEach((chunk, r) => {
    const order = [];
    for (const ch of chunk) {
      const idx = parseInt(ch, 36);
      if (Number.isNaN(idx) || idx < 0 || idx >= n || order.includes(idx)) continue;
      order.push(idx);
    }
    if (!order.length) return;
    order.forEach((idx, place) => {
      stats[idx].points += points[place] || 0;
      stats[idx].rounds++;
      stats[idx].places[place]++;
    });
    rounds.push({ n: rounds.length + 1, order });
  });
  const placesCmp = (a, b) => {
    for (let p = 0; p < n; p++) if (a.places[p] !== b.places[p]) return b.places[p] - a.places[p];
    return 0;
  };
  const standings = [...stats].sort((a, b) => b.points - a.points || placesCmp(a, b) || cmpName(a, b));
  const level = (a, b) => a.points === b.points && placesCmp(a, b) === 0;
  const top = standings.filter((s) => level(s, standings[0]));
  const tie = rounds.length && top.length > 1 ? top.map((s) => s.name) : null;
  const champion = finished && rounds.length > 0 && !tie
    ? { name: standings[0].name, runnerUp: standings[1] ? standings[1].name : null } : null;
  return { kind: 'ffa', players, rounds, points, standings, finished, complete: finished, tie, champion };
}

// Encode a finishing order for freeForAll's `w`.
function encodeFfaRound(order) {
  return order.map((i) => i.toString(36)).join('');
}

/* ======================= summaries for tracking ======================= */

// One-line standings summary stored alongside a recorded result, e.g.
// "Dad=3-1, Mum=2-2" (rr/swiss), "Dad=5" wins-as-king (koth), "Dad=21" points (ffa).
function standingsSummary(result) {
  const s = result.standings;
  switch (result.kind) {
    case 'rr':
    case 'swiss': return s.map((r) => `${r.name}=${r.wins}-${r.losses}`).join(', ');
    case 'koth': return s.map((r) => `${r.name}=${r.kingWins}`).join(', ');
    case 'ffa': return s.map((r) => `${r.name}=${r.points}`).join(', ');
    default: return '';
  }
}

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

const CARD_VERSION = '1.4.0';

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
       help: 'Winner stays on. Whoever holds the hill is the champion; wins on top are tracked. Sessions can be picked up again later.' },
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
// `b` king-of-the-hill carry-over from an earlier session (see kothSnapshot).
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

function resultLine(measurement, { game, mode, winner, runnerUp, players, created, standings, topWins, snapshot, sessions, games }) {
  const tags = `game=${lpTag(game || 'Untitled')},mode=${lpTag(MODES[mode].tag)}`;
  const fields = [
    `winner=${lpStr(winner)}`,
    `runner_up=${lpStr(runnerUp || '')}`,
    `players=${lpStr(players.join(', '))}`,
    `player_count=${players.length}i`,
  ];
  if (standings) fields.push(`standings=${lpStr(standings)}`);
  if (Number.isInteger(topWins)) fields.push(`top_wins=${topWins}i`);
  // King of the hill lineages carry enough to be picked up again later.
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
    this._lastRaw = '';
    this._setValue('');
    this._render();
  }

  /* --- actions --- */
  _createFromDraft() {
    const names = this._draft.split('\n').map((n) => n.trim()).filter(Boolean);
    if (names.length < 2) { this._flash('Enter at least two players (one per line).'); return; }
    if (names.length > 64) { this._flash('That is a lot of players — cap is 64.'); return; }
    if (this._mode === 'f' && names.length > 36) { this._flash('Free-for-all supports up to 36 players.'); return; }
    if (this._mode === 'k' && names.length > KOTH_MAX_PLAYERS) { this._flash(`King of the hill supports up to ${KOTH_MAX_PLAYERS} players.`); return; }
    // Entry order is seeding order, and a typed list is rarely random — so
    // shuffle once here. The shuffled order is what gets stored, so the
    // draw is stable from then on.
    shuffle(names);
    const swissRounds = this._mode === 'w' ? Math.max(0, parseInt(this._swissRounds, 10) || 0) : 0;
    this._track = { busy: false, error: null };
    this._ffaOrder = [];
    this._kothChallenger = null;
    this._save({
      players: names, mode: this._mode, w: '', decisions: {},
      resetBracket: this._config.reset_bracket !== false,
      decider: '', finished: false, swissRounds, base: null,
      game: this._game.trim(), created: Math.floor(Date.now() / 1000), recorded: false,
    });
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
      snapshot: koth ? kothSnapshot(res) : null, sessions: res.sessions, games: res.totalGames,
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
    const q = `SELECT "state", "winner", "top_wins", "games", "sessions", "last_played", "game" FROM "${this._tracking.measurement}" WHERE "mode" = 'king_of_the_hill' ORDER BY time DESC LIMIT 100`;
    try {
      const r = await callWithResponse(this._hass, this._tracking.query_service, { q });
      const rows = parseInfluxRows(r && r.content != null ? r.content : r);
      const seen = new Set();
      const out = [];
      for (const row of rows) {
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

  _resumeKoth(session) {
    this._track = { busy: false, error: null };
    this._kothChallenger = null;
    this._save({
      players: session.players, mode: 'k', w: '', decisions: {},
      resetBracket: this._config.reset_bracket !== false,
      decider: '', finished: false, swissRounds: 0, base: session.base,
      // Same creation time as the lineage's point, so the next record updates
      // it instead of starting a second history entry.
      game: session.game, created: session.time, recorded: false,
    });
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
      body = this._setupView();
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
            ? `<span class="pill mode">${esc(MODES[decoded.mode].label)}</span>` : ``}</div>
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
    let resume = '';
    if (this._mode === 'k' && this._tracking) {
      if (this._kothSessions === undefined) { this._kothSessions = 'loading'; setTimeout(() => this._loadKothSessions(), 0); }
      const ks = this._kothSessions;
      if (ks === 'loading') resume = `<p class="muted small">Looking for previous sessions…</p>`;
      else if (ks && ks.error) resume = `<p class="err small">Couldn't load previous sessions: ${esc(ks.error)}</p>`;
      else if (Array.isArray(ks) && ks.length) {
        const typed = this._game.trim().toLowerCase();
        const sorted = [...ks].sort((a, b) => (b.game.toLowerCase() === typed) - (a.game.toLowerCase() === typed) || b.lastPlayed - a.lastPlayed);
        resume = `
          <div class="sub gap">Continue a previous session</div>
          <div class="resume">${sorted.map((x) => `
            <div class="rrow${x.game.toLowerCase() === typed ? ' hit' : ''}">
              <div><strong>${esc(x.game)}</strong> <span class="muted">— 👑 ${esc(x.king)}${Number.isFinite(x.topWins) ? ` (${x.topWins} on top)` : ''}, ${x.games || '?'} games, last played ${esc(fmtDate(x.lastPlayed))}</span>
                <div class="muted tiny">${esc(x.players.join(', '))}</div></div>
              <button class="ghost" data-resume="${ks.indexOf(x)}">Continue</button>
            </div>`).join('')}</div>
          <p class="muted small">Or start a fresh one below — the previous session stays in the history.</p>`;
      }
    }
    return `
      <div class="pad">
        <label class="lbl" for="game">Game</label>
        <input id="game" type="text" placeholder="e.g. Mario Kart, UNO" value="${esc(this._game)}" maxlength="40">
        <label class="lbl" for="mode">Format</label>
        <select id="mode">${modeOpts}</select>
        <p class="muted small">${esc(MODES[this._mode].help)}</p>
        ${resume}
        ${this._mode === 'w' ? `
          <label class="lbl" for="rounds">Rounds</label>
          <input id="rounds" type="number" min="1" max="20" placeholder="automatic (log\u2082 of players)" value="${esc(this._swissRounds)}">` : ''}
        <label class="lbl" for="draft">Players</label>
        <p class="muted small">One per line. The order is shuffled when you start.</p>
        <textarea id="draft" rows="8" placeholder="Alice&#10;Bob&#10;Charlie&#10;Dana">${esc(this._draft)}</textarea>
        <div class="row">
          <button class="primary" id="create">Start</button>
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
        ? ` <span class="tnote">👑 ${res.kingWins} wins on top · ${res.totalGames} games${res.sessions > 1 ? ` · session ${res.sessions}` : ''}</span>` : '';
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
        <div class="mtag">Game ${res.totalGames + 1}${res.sessions > 1 ? ` · session ${res.sessions}` : ''}</div>
        <div class="p real" data-match="koth" data-side="p1" data-click="1">
          <span class="nm">👑 ${esc(P[cur.king])}</span><span class="side">${kingStats.kingWins || 0} on top</span>
        </div>
        <div class="vs"></div>
        <div class="p real" data-match="koth" data-side="p2" data-click="1">
          <span class="nm">${esc(P[challenger])}</span><span class="side">challenger</span>
        </div>
      </div>
      <p class="muted small">Tap the winner above, or pick who challenges next:</p>
      <div class="chips">${res.queue.map((i) => `<button class="chip${i === challenger ? ' placed' : ''}" data-koth="${i}">${esc(P[i])}</button>`).join('')}</div>` : '';

    const rows = res.standings.map((s, i) => `
      <tr><td class="rank">${i + 1}</td><td>${s.idx === res.king && !res.finished ? '👑 ' : ''}${esc(s.name)}</td>
          <td class="num"><strong>${s.kingWins}</strong></td><td class="num muted">${s.reigns}</td><td class="num muted">${s.wins}–${s.losses}</td></tr>`).join('');
    const log = [...res.games].reverse().slice(0, 12).map((g) => `
      <tr><td class="rank">${g.n}</td><td>${g.winner === 'king'
        ? `👑 <strong>${esc(P[g.king])}</strong> <span class="muted">held off ${esc(P[g.challenger])}</span>`
        : `<strong>${esc(P[g.challenger])}</strong> <span class="muted">dethroned</span> 👑 ${esc(P[g.king])}`}</td></tr>`).join('');

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
    this.shadowRoot.querySelectorAll('[data-resume]').forEach((el) => {
      el.onclick = () => {
        const list = Array.isArray(this._kothSessions) ? this._kothSessions : [];
        const sess = list[Number(el.getAttribute('data-resume'))];
        if (sess) this._resumeKoth(sess);
      };
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
  .resume .rrow { display:flex; align-items:center; justify-content:space-between; gap: 10px;
                  padding: 8px 10px; border: 1px solid var(--divider-color, #e0e0e0);
                  border-radius: 8px; margin-bottom: 6px; }
  .resume .rrow.hit { border-color: var(--primary-color); }
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
    const q = `SELECT "winner", "runner_up", "players", "player_count", "standings", "top_wins", "games", "sessions", "last_played", "game", "mode" FROM "${this._tracking.measurement}" ORDER BY time DESC LIMIT ${limit}`;
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
    if (!all.length) return `<div class="pad muted">No results recorded yet. Finish a tournament with tracking on and it will show up here.</div>`;
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

    const detail = (r) => {
      if (r.mode === 'king_of_the_hill') {
        const bits = [];
        if (Number.isFinite(r.top_wins)) bits.push(`${r.top_wins} wins on top`);
        if (Number.isFinite(r.games)) bits.push(`${r.games} games`);
        if (Number.isFinite(r.sessions) && r.sessions > 1) bits.push(`${r.sessions} sessions`);
        if (Number.isFinite(r.last_played) && r.last_played - r.time > 86400) bits.push(`last played ${fmtDate(r.last_played)}`);
        return `<span class="muted"> — 👑 ${bits.join(' · ') || 'king of the hill'}</span>`;
      }
      return r.runner_up ? `<span class="muted"> beat ${esc(r.runner_up)}</span>` : '';
    };
    const champ = latest ? `
      <div class="champ">🏆 Current champion:&nbsp;<strong>${esc(latest.winner)}</strong>
        <span class="tnote">${esc(latest.game || 'Untitled')}${latest.mode ? ` · ${esc(modeLabelFromTag(latest.mode))}` : ''} · ${esc(fmtDate(latest.time))}</span>
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
            ${rows.map((r) => `<tr><td class="muted nowrap">${esc(fmtDate(r.time))}</td>
              <td>${esc(r.game || 'Untitled')}${r.mode ? `<div class="muted tiny">${esc(modeLabelFromTag(r.mode))}</div>` : ''}</td>
              <td><strong>${esc(r.winner)}</strong>${detail(r)}
                  ${r.players ? `<div class="muted tiny">Players: ${esc(r.players)}</div>` : ''}
                  ${r.standings ? `<div class="muted tiny">${esc(r.standings)}</div>` : ''}</td></tr>`).join('')}
          </table>
        </div>
      </div>`;
  }
}

const HISTORY_STYLE = `
  .top { padding-bottom: 0; }
  .top:empty { display:none; }
  select { width:auto; padding: 6px 10px; }
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
