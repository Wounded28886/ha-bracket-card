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
 * Finishing order, best first.
 *
 * Placing in a bracket is "how long you lasted": whoever is eliminated last
 * finishes highest. `state.order` is topological — winners bracket, then
 * losers bracket, then the grand final — so walking it backwards visits
 * eliminations from last to first.
 *
 * In double elimination a loss in the winners bracket isn't an elimination
 * (you drop into the losers bracket), so only losers-bracket and grand-final
 * losses count. The champion is excluded, which also disposes of the grand
 * final's first game: when a reset is played its loser is the champion, and
 * the real runner-up falls out of the reset game instead.
 *
 * Players still alive (an unfinished tournament) come last, in seed order.
 */
function eliminationOrder(state) {
  const champ = champion(state);
  const order = [];
  const seen = new Set();
  if (champ) { order.push(champ.name); seen.add(champ.name); }

  for (let i = state.order.length - 1; i >= 0; i--) {
    const match = state.matches[state.order[i]];
    if (!match.winner || match.winner === 'bye') continue;
    // A winners-bracket loss only eliminates when there's nowhere to drop to.
    if (match.bracket === 'W' && !state.single && state.matches['GF-1']) continue;
    const loser = match.winner === 'p1' ? match.p2 : match.p1;
    if (!isPlayer(loser) || seen.has(loser.name)) continue;
    seen.add(loser.name);
    order.push(loser.name);
  }

  for (const name of state.players) {
    if (!seen.has(name)) { seen.add(name); order.push(name); }
  }
  return order;
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
 * Winner stays on. Nobody starts as king: the first two players play for the
 * hill and the winner is crowned. After that the king stays on and whoever
 * is picked (or, by default, whoever has waited longest) challenges; the
 * loser goes to the back of the queue.
 *
 * `w` is two chars per game: the challenger as a letter (A-Z then a-z, see
 * kothChallengerCode) and '1' the player on the hill held / '2' the
 * challenger won. A `w` of bare 1/2 digits is the older form, where player 1
 * started as king and the queue always chose the challenger; those sessions
 * keep their original meaning. Open-ended — `finished` ends it.
 *
 * A lineage can span sessions: `base` is a snapshot of where the previous
 * session left off (king, queue order, per-player totals, games played),
 * produced by kothSnapshot() and re-rostered by kothRebase(). The champion
 * is whoever holds the hill; standings rank by wins while king, then the
 * holder, then total wins.
 */
const KOTH_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KOTH_MAX_PLAYERS = KOTH_LETTERS.length;
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
  let king = null;                 // nobody holds the hill until a game is won
  let priorGames = 0, sessions = 1;
  const codes = typeof w === 'string' ? w : '';
  const legacy = codes.length > 0 && !/[A-Za-z]/.test(codes);
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
  } else if (legacy) {
    // Sessions stored before the crowning game existed: player 1 was king.
    king = queue.shift();
    stats[king].reigns++;
  }
  const games = [];
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
    // With no king yet, the first player in the queue defends the hill.
    const holder = king != null ? king : queue[0];
    if (holder == null) break;
    if ((c !== '1' && c !== '2') || challenger == null || challenger < 0 || challenger >= n
        || challenger === holder || !queue.includes(challenger)) break;
    if (king == null) queue.shift();
    queue.splice(queue.indexOf(challenger), 1);
    const winner = c === '1' ? holder : challenger;
    const loser = c === '1' ? challenger : holder;
    games.push({
      n: priorGames + games.length + 1, king: holder, challenger,
      winner: c === '1' ? 'king' : 'challenger', crowning: king == null,
    });
    stats[holder].played++; stats[challenger].played++;
    stats[winner].wins++; stats[loser].losses++;
    // A win that takes the hill is not a win *on* the hill.
    if (king != null && winner === king) stats[king].kingWins++;
    else stats[winner].reigns++;
    king = winner;
    queue.push(loser);
  }
  const standings = [...stats].sort((a, b) => b.kingWins - a.kingWins
    || (b.idx === king) - (a.idx === king) || b.wins - a.wins || cmpName(a, b));
  // Default challenger = longest wait; `queue` (in wait order) is the menu.
  const holder = king != null ? king : queue[0];
  const waiting = king != null ? queue : queue.slice(1);
  const current = finished ? null : { king, holder, challenger: waiting[0], crowning: king == null };
  const totalGames = priorGames + games.length;
  // The hill's holder is the champion; runner-up is the best of the rest.
  const rest = standings.filter((x) => x.idx !== king);
  const champion = finished && king != null && totalGames > 0
    ? { name: players[king], runnerUp: rest.length ? rest[0].name : null } : null;
  return {
    kind: 'koth', players, games, king, queue: [...waiting], current, standings,
    finished, complete: finished, tie: null, champion, n, totalGames, sessions,
    kingWins: king != null ? stats[king].kingWins : 0,
  };
}

/*
 * Re-roster a lineage snapshot: keep every returning player's totals (matched
 * by name), drop those who left, append newcomers to the back of the queue.
 * Returns null if the king isn't in the new roster — a lineage only continues
 * while its champion is playing.
 */
function kothRebase(base, oldPlayers, newPlayers) {
  if (!base || !Array.isArray(oldPlayers) || !Array.isArray(newPlayers)) return null;
  const k = newPlayers.indexOf(oldPlayers[base.k]);
  if (k < 0) return null;
  const s = newPlayers.map((name) => {
    const old = oldPlayers.indexOf(name);
    const row = old >= 0 && base.s ? base.s[old] : null;
    return row ? [...row] : [0, 0, 0, 0, 0];
  });
  const q = [];
  for (const i of base.q || []) {
    const idx = newPlayers.indexOf(oldPlayers[i]);
    if (idx >= 0 && idx !== k && !q.includes(idx)) q.push(idx);
  }
  newPlayers.forEach((_, i) => { if (i !== k && !q.includes(i)) q.push(i); });
  return { k, q, s, g: base.g || 0, n: base.n || 0 };
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
 * ha-bracket-card — what the recorded results add up to.
 *
 * Pure functions over the rows the history card reads back: no DOM, no
 * network, no dates beyond the ones in the data. Everything here works on
 * results recorded by any version — rows written before full finishing
 * orders existed fall back to "winner first, runner-up second, everyone
 * else level" — so the whole history counts, not just what came after.
 *
 * A row looks like:
 *   { time, game, mode, winner, runner_up, players, player_count,
 *     placings?, standings?, top_wins?, temp? }
 *
 * Unit-tested in test/stats.test.mjs.
 */

const SEP = /\s*,\s*/;

const splitNames = (value) =>
  String(value || '').split(SEP).map((n) => n.trim()).filter(Boolean);

/* A one-off king-of-the-hill game doesn't hold a title or count as a win. */
const isReal = (row) => row && row.temp !== true && !!row.winner;

const realRows = (rows) => (rows || []).filter(isReal);

/* Newest first, which is how the card wants nearly everything. */
const byNewest = (rows) => [...rows].sort((a, b) => b.time - a.time);

function rowDate(row) {
  const d = new Date((row.time || 0) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

const seasonOf = (row) => {
  const d = rowDate(row);
  return d ? d.getFullYear() : null;
};

/*
 * Who finished where, as [{name, rank}] with ties sharing a rank.
 *
 * Uses the recorded finishing order when there is one. Older rows only know
 * the top two, so everyone else is ranked joint third — enough for points
 * and ratings to treat them fairly without inventing an order.
 */
function ranked(row) {
  const players = splitNames(row.players);
  const placings = splitNames(row.placings);
  if (placings.length) {
    const known = placings.map((name, i) => ({ name, rank: i + 1 }));
    // Anyone missing from the order (shouldn't happen) trails the field.
    for (const name of players) {
      if (!known.some((k) => k.name === name)) known.push({ name, rank: known.length + 1 });
    }
    return known;
  }
  const out = [];
  if (row.winner) out.push({ name: row.winner, rank: 1 });
  if (row.runner_up) out.push({ name: row.runner_up, rank: 2 });
  const rest = players.filter((n) => n !== row.winner && n !== row.runner_up);
  for (const name of rest) out.push({ name, rank: 3 });
  return out;
}

const participants = (row) => {
  const players = splitNames(row.players);
  if (players.length) return players;
  return ranked(row).map((r) => r.name);
};

/* ---------------------------------------------------------------- belts */
/*
 * One title per game, held by whoever won it last. Losing it needs someone
 * else to win that game — which is what makes it worth defending.
 */
function belts(rows) {
  const byGame = new Map();
  for (const row of byNewest(realRows(rows))) {
    const game = row.game || 'Untitled';
    let belt = byGame.get(game);
    if (!belt) {
      belt = {
        game,
        holder: row.winner,
        since: row.time,
        wonAt: row.time,
        defences: 0,
        mode: row.mode,
        lastPlayed: row.last_played || row.time,
        previous: null,
      };
      byGame.set(game, belt);
      continue;
    }
    // Rows arrive newest first: keep counting back while the same person
    // keeps winning, and stop at the game they took it in.
    if (belt.previous === null) {
      if (row.winner === belt.holder) {
        belt.defences += 1;
        belt.since = row.time;
      } else {
        belt.previous = row.winner;
      }
    }
  }
  return [...byGame.values()].sort((a, b) => b.wonAt - a.wonAt);
}

/* --------------------------------------------------------------- points */
/*
 * A placing in a field of n is worth n - place + 1: winning six players is
 * six points, last is one. Beating more people is worth more, which is the
 * whole reason to record the field size.
 */
function pointsFor(rank, fieldSize) {
  return Math.max(1, fieldSize - rank + 1);
}

/* ------------------------------------------------------------------ elo */
/*
 * One tournament is every pair of its players compared at once: finishing
 * above someone counts as a win against them, level counts as a draw. Each
 * pair moves the rating by at most K/(n-1), so a big field doesn't swing
 * ratings more than a small one — it just settles them faster.
 */
const ELO_START = 1000;
const ELO_K = 32;

function elo(rows, { start = ELO_START, k = ELO_K } = {}) {
  const ratings = new Map();
  const get = (name) => (ratings.has(name) ? ratings.get(name) : start);
  const history = [];

  for (const row of [...realRows(rows)].sort((a, b) => a.time - b.time)) {
    const places = ranked(row);
    if (places.length < 2) continue;
    const before = new Map(places.map((p) => [p.name, get(p.name)]));
    const delta = new Map(places.map((p) => [p.name, 0]));
    const perPair = k / (places.length - 1);

    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        const a = places[i], b = places[j];
        if (a.name === b.name) continue;
        const ra = before.get(a.name), rb = before.get(b.name);
        const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
        const score = a.rank === b.rank ? 0.5 : a.rank < b.rank ? 1 : 0;
        delta.set(a.name, delta.get(a.name) + perPair * (score - expected));
        delta.set(b.name, delta.get(b.name) + perPair * ((1 - score) - (1 - expected)));
      }
    }
    for (const [name, d] of delta) ratings.set(name, get(name) + d);
    history.push({
      time: row.time,
      game: row.game,
      ratings: Object.fromEntries([...ratings].map(([n, r]) => [n, Math.round(r)])),
    });
  }
  return {
    ratings: Object.fromEntries([...ratings].map(([n, r]) => [n, Math.round(r)])),
    history,
  };
}

/* ---------------------------------------------------------- leaderboard */
/*
 * Everything known about each player, from every angle the card shows:
 * wins and how often they turned up, points, rating, form, streaks, the
 * games they're best and worst at, and who they beat most.
 */
function leaderboard(rows, opts = {}) {
  const live = realRows(rows);
  const scoped = opts.season ? live.filter((r) => seasonOf(r) === opts.season) : live;
  const ordered = [...scoped].sort((a, b) => a.time - b.time);
  const ratings = elo(live).ratings;   // rating is a career thing, not per season

  const table = new Map();
  const player = (name) => {
    if (!table.has(name)) {
      table.set(name, {
        name, wins: 0, runnerUps: 0, appearances: 0, points: 0,
        firstPlayed: null, lastPlayed: null, lastWin: null,
        bestField: 0, byGame: new Map(), byMode: new Map(),
        beat: new Map(), lostTo: new Map(), results: [],
      });
    }
    return table.get(name);
  };

  for (const row of ordered) {
    const places = ranked(row);
    const field = Math.max(places.length, Number(row.player_count) || 0);
    for (const { name, rank } of places) {
      const p = player(name);
      p.appearances += 1;
      p.points += pointsFor(rank, field);
      p.firstPlayed = p.firstPlayed === null ? row.time : Math.min(p.firstPlayed, row.time);
      p.lastPlayed = p.lastPlayed === null ? row.time : Math.max(p.lastPlayed, row.time);
      p.results.push({ time: row.time, game: row.game, mode: row.mode, rank, won: rank === 1, field });

      const game = row.game || 'Untitled';
      const g = p.byGame.get(game) || { game, wins: 0, played: 0 };
      g.played += 1;
      const mode = row.mode || 'unknown';
      const m = p.byMode.get(mode) || { mode, wins: 0, played: 0 };
      m.played += 1;

      if (rank === 1) {
        p.wins += 1;
        p.lastWin = row.time;
        p.bestField = Math.max(p.bestField, field);
        g.wins += 1;
        m.wins += 1;
        if (row.runner_up) p.beat.set(row.runner_up, (p.beat.get(row.runner_up) || 0) + 1);
      }
      if (rank === 2 && row.winner) {
        p.runnerUps += 1;
        p.lostTo.set(row.winner, (p.lostTo.get(row.winner) || 0) + 1);
      }
      p.byGame.set(game, g);
      p.byMode.set(mode, m);
    }
  }

  const best = (map, key) => {
    const rows2 = [...map.values()].filter((x) => x.played > 0);
    if (!rows2.length) return null;
    return rows2.map((x) => ({ ...x, rate: x.wins / x.played }))
      .sort((a, b) => b.rate - a.rate || b.played - a.played || String(a[key]).localeCompare(String(b[key])))[0];
  };
  const worst = (map, key) => {
    const rows2 = [...map.values()].filter((x) => x.played > 1);
    if (!rows2.length) return null;
    return rows2.map((x) => ({ ...x, rate: x.wins / x.played }))
      .sort((a, b) => a.rate - b.rate || b.played - a.played || String(a[key]).localeCompare(String(b[key])))[0];
  };
  const topOf = (map) => {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.length ? { name: entries[0][0], count: entries[0][1] } : null;
  };

  const out = [...table.values()].map((p) => {
    const results = p.results.sort((a, b) => a.time - b.time);
    return {
      ...p,
      winRate: p.appearances ? p.wins / p.appearances : 0,
      rating: ratings[p.name] ?? ELO_START,
      form: results.slice(-5).map((r) => r.won),
      streak: currentStreak(results),
      longestStreak: longestStreak(results),
      bestGame: best(p.byGame, 'game'),
      worstGame: worst(p.byGame, 'game'),
      byGame: [...p.byGame.values()].sort((a, b) => b.wins - a.wins || b.played - a.played),
      byMode: [...p.byMode.values()].sort((a, b) => b.wins - a.wins || b.played - a.played),
      nemesis: topOf(p.lostTo),
      favouriteVictim: topOf(p.beat),
    };
  });

  const sorters = {
    wins: (a, b) => b.wins - a.wins || b.winRate - a.winRate || a.name.localeCompare(b.name),
    rate: (a, b) => b.winRate - a.winRate || b.wins - a.wins || a.name.localeCompare(b.name),
    points: (a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name),
    rating: (a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name),
  };
  return out.sort(sorters[opts.sort] || sorters.wins);
}

function currentStreak(results) {
  let wins = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i].won) break;
    wins += 1;
  }
  if (wins) return { kind: 'wins', count: wins };
  let since = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].won) break;
    since += 1;
  }
  return { kind: 'drought', count: since };
}

function longestStreak(results) {
  let best = 0, run = 0;
  for (const r of results) {
    run = r.won ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/* -------------------------------------------------------------- seasons */
function seasons(rows) {
  const live = realRows(rows);
  const years = [...new Set(live.map(seasonOf).filter((y) => y !== null))].sort((a, b) => b - a);
  return years.map((year) => {
    const table = leaderboard(live, { season: year, sort: 'points' });
    const events = live.filter((r) => seasonOf(r) === year);
    return {
      year,
      events: events.length,
      table,
      champion: table[0] || null,
      games: [...new Set(events.map((r) => r.game || 'Untitled'))].sort(),
    };
  });
}

/* --------------------------------------------------------- head to head */
/*
 * Who has beaten whom in a final. Only the top two of an event are a real
 * meeting — everyone else may never have played each other.
 */
function headToHead(rows) {
  const names = new Set();
  const pairs = new Map();
  const key = (a, b) => `${a}\u0000${b}`;

  for (const row of realRows(rows)) {
    if (!row.winner || !row.runner_up) continue;
    names.add(row.winner);
    names.add(row.runner_up);
    pairs.set(key(row.winner, row.runner_up), (pairs.get(key(row.winner, row.runner_up)) || 0) + 1);
  }
  const list = [...names].sort((a, b) => a.localeCompare(b));
  return {
    players: list,
    wins: (a, b) => pairs.get(key(a, b)) || 0,
    meetings: (a, b) => (pairs.get(key(a, b)) || 0) + (pairs.get(key(b, a)) || 0),
  };
}

function rivalries(rows, { min = 2 } = {}) {
  const h2h = headToHead(rows);
  const out = [];
  for (let i = 0; i < h2h.players.length; i++) {
    for (let j = i + 1; j < h2h.players.length; j++) {
      const a = h2h.players[i], b = h2h.players[j];
      const meetings = h2h.meetings(a, b);
      if (meetings < min) continue;
      const aWins = h2h.wins(a, b), bWins = h2h.wins(b, a);
      const leader = aWins === bWins ? null : aWins > bWins ? a : b;
      out.push({ a, b, meetings, aWins, bWins, leader });
    }
  }
  return out.sort((x, y) => y.meetings - x.meetings
    || Math.abs(x.aWins - x.bWins) - Math.abs(y.aWins - y.bWins)
    || x.a.localeCompare(y.a));
}

/* ---------------------------------------------------------- on this day */
/*
 * The same date in an earlier year. Anything from the last few days counts
 * as "this week" so a board isn't blank for 364 days of the year.
 */
function onThisDay(rows, now = new Date(), { window = 3 } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (const row of realRows(rows)) {
    const d = rowDate(row);
    if (!d || d.getFullYear() >= today.getFullYear()) continue;
    const anniversary = new Date(today.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((anniversary - today) / 86400000);
    if (Math.abs(days) > window) continue;
    out.push({ ...row, yearsAgo: today.getFullYear() - d.getFullYear(), daysOff: days });
  }
  return out.sort((a, b) => Math.abs(a.daysOff) - Math.abs(b.daysOff) || a.yearsAgo - b.yearsAgo);
}

/* -------------------------------------------------------------- formats */
function byFormat(rows) {
  const modes = new Map();
  for (const row of realRows(rows)) {
    const mode = row.mode || 'unknown';
    const m = modes.get(mode) || { mode, events: 0, winners: new Map() };
    m.events += 1;
    m.winners.set(row.winner, (m.winners.get(row.winner) || 0) + 1);
    modes.set(mode, m);
  }
  return [...modes.values()]
    .map((m) => ({
      mode: m.mode,
      events: m.events,
      winners: [...m.winners.entries()]
        .map(([name, wins]) => ({ name, wins }))
        .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.events - a.events || a.mode.localeCompare(b.mode));
}

/* ------------------------------------------------------------ overviews */
function biggestWins(rows, { limit = 5 } = {}) {
  return realRows(rows)
    .map((r) => ({ ...r, field: Math.max(Number(r.player_count) || 0, participants(r).length) }))
    .sort((a, b) => b.field - a.field || b.time - a.time)
    .slice(0, limit);
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

const CARD_VERSION = '1.7.0';

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
