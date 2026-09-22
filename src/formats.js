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
export function roundRobinSchedule(n) {
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
export function roundRobin(players, w = '') {
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
export function swiss(players, w = '', opts = {}) {
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
 * Winner stays on. Player 1 starts as king against player 2; the loser goes
 * to the back of the queue. `w` is one char per game: '1' the king held,
 * '2' the challenger took over. Open-ended — `finished` ends the session.
 * Ranked by wins while king (the stat that matters here), then whoever
 * currently holds the hill, then total wins.
 */
export function kingOfTheHill(players, w = '', finished = false) {
  const n = players.length;
  const stats = players.map((name, idx) => ({ idx, name, kingWins: 0, wins: 0, losses: 0, reigns: 0, played: 0 }));
  const queue = players.map((_, i) => i);
  let king = queue.shift();
  stats[king].reigns++;
  const games = [];
  const codes = typeof w === 'string' ? w : '';
  for (let g = 0; g < codes.length; g++) {
    const c = codes[g];
    if (c !== '1' && c !== '2') break;
    const challenger = queue.shift();
    const game = { n: g + 1, king, challenger, winner: c === '1' ? 'king' : 'challenger' };
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
  const current = finished ? null : { king, challenger: queue[0] };
  const champion = finished && games.length > 0
    ? { name: standings[0].name, runnerUp: standings[1] ? standings[1].name : null } : null;
  return { kind: 'koth', players, games, king, queue: [...queue], current, standings, finished, complete: finished, tie: null, champion, n };
}

/* ======================= free-for-all ======================= */
/*
 * Everyone plays at once (a Mario Kart race, a hand of UNO). Each round is a
 * finishing order; players who sat out score 0. `w` is rounds joined by '|',
 * each round the player indices in finishing order as base-36 digits.
 * Points per place default to n, n-1, ... 1 (opts.points overrides).
 */
export function freeForAll(players, w = '', finished = false, opts = {}) {
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
export function encodeFfaRound(order) {
  return order.map((i) => i.toString(36)).join('');
}

/* ======================= summaries for tracking ======================= */

// One-line standings summary stored alongside a recorded result, e.g.
// "Dad=3-1, Mum=2-2" (rr/swiss), "Dad=5" wins-as-king (koth), "Dad=21" points (ffa).
export function standingsSummary(result) {
  const s = result.standings;
  switch (result.kind) {
    case 'rr':
    case 'swiss': return s.map((r) => `${r.name}=${r.wins}-${r.losses}`).join(', ');
    case 'koth': return s.map((r) => `${r.name}=${r.kingWins}`).join(', ');
    case 'ffa': return s.map((r) => `${r.name}=${r.points}`).join(', ');
    default: return '';
  }
}
