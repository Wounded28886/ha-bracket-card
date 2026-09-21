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

export function nextPow2(n) {
  let s = 1;
  while (s < n) s *= 2;
  return Math.max(2, s);
}

// Standard single-elimination seeding order for a bracket of `size`.
// Returns an array of seed numbers (1-based) in slot order, such that top
// seeds are maximally separated and byes (highest seeds) meet top seeds first.
export function seedOrder(size) {
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
export function generateBracket(players, opts = {}) {
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
  const order2seed = seedOrder(size);

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
        // Seed players into slots.
        const seedA = order2seed[i * 2];
        const seedB = order2seed[i * 2 + 1];
        m.p1 = seedToParticipant(seedA, names);
        m.p2 = seedToParticipant(seedB, names);
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

function seedToParticipant(seed, names) {
  if (seed <= names.length) {
    return { type: 'player', seed, name: names[seed - 1] };
  }
  return BYE();
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
export function resolve(state) {
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
export function setWinner(state, matchId, side) {
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
export function champion(state) {
  const m = state.matches;
  const gf2 = m['GF-2'];
  if (gf2 && gf2.winner && gf2.winner !== 'bye') {
    const ref = gf2.winner === 'p1' ? gf2.p1 : gf2.p2;
    if (isPlayer(ref)) return { name: ref.name };
  }
  const gf1 = m['GF-1'];
  if (gf1 && gf1.winner && gf1.winner !== 'bye') {
    // If reset is enabled and LB entrant won GF-1, GF-2 decides it (not done yet).
    if (state.resetBracket && m['GF-2'] && gf1.winner === 'p2') return null;
    const ref = gf1.winner === 'p1' ? gf1.p1 : gf1.p2;
    if (isPlayer(ref)) return { name: ref.name };
  }
  return null;
}

// Convenience for tests / UI: display label for a slot.
export function slotLabel(ref) {
  if (!ref) return '';
  if (ref.type === 'player') return ref.name;
  if (ref.type === 'bye') return 'BYE';
  return '';
}
