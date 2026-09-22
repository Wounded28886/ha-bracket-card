import {
  roundRobinSchedule, roundRobin, swiss, kingOfTheHill, freeForAll,
  encodeFfaRound, standingsSummary, kothChallengerCode, kothSnapshot,
} from '../src/formats.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }
const names = (n) => Array.from({ length: n }, (_, i) => 'P' + (i + 1));

// ---- round robin schedule ----
section('round robin schedule');
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  const rounds = roundRobinSchedule(n);
  const expectRounds = n % 2 === 0 ? n - 1 : n;
  assert(rounds.length === expectRounds, `n=${n}: ${expectRounds} rounds (got ${rounds.length})`);
  const seen = new Set();
  let byes = 0, ok = true;
  for (const r of rounds) {
    const inRound = new Set();
    for (const [a, b] of r) {
      if (b == null) { byes++; continue; }
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(k)) ok = false;
      seen.add(k);
      if (inRound.has(a) || inRound.has(b)) ok = false;
      inRound.add(a); inRound.add(b);
    }
  }
  assert(ok && seen.size === n * (n - 1) / 2, `n=${n}: every pair exactly once, nobody twice per round`);
  assert(byes === (n % 2 ? n : 0), `n=${n}: byes = ${n % 2 ? n : 0} (got ${byes})`);
}

// ---- round robin play ----
section('round robin');
{
  const r0 = roundRobin(names(4));
  assert(r0.matchCount === 6 && !r0.complete && !r0.champion, '4 players: 6 matches, not complete');
  // Everyone beats higher-numbered players -> P1 wins all.
  const w = r0.rounds.flatMap((r) => r.matches).filter((m) => m.p2 != null)
    .map((m) => (m.p1 < m.p2 ? '1' : '2')).join('');
  const r = roundRobin(names(4), w);
  assert(r.complete && r.champion && r.champion.name === 'P1' && r.champion.runnerUp === 'P2', 'lowest seed wins with 3-0');
  assert(r.standings.map((s) => `${s.name}:${s.wins}-${s.losses}`).join(',') === 'P1:3-0,P2:2-1,P3:1-2,P4:0-3', 'standings W-L');

  // Head-to-head tiebreak: 3 players, rock-paper-scissors is a 3-way tie.
  const s3 = roundRobinSchedule(3);
  const all = roundRobin(names(3)).rounds.flatMap((x) => x.matches).filter((m) => m.p2 != null);
  const cyc = { '0-1': 0, '1-2': 1, '2-0': 2 }; // winner of each pair
  const wCyc = all.map((m) => {
    const key = `${m.p1}-${m.p2}`, rev = `${m.p2}-${m.p1}`;
    return key in cyc ? '1' : rev in cyc ? '2' : '1';
  }).join('');
  const rc = roundRobin(names(3), wCyc);
  assert(rc.complete && !rc.champion && rc.tie && rc.tie.length === 3, `circular 3-way tie is reported (tie=${rc.tie})`);
  assert(s3.length === 3, 'n=3 has 3 rounds');

  // Partial results: undecided matches leave standings partial and no champion.
  const part = roundRobin(names(4), '1');
  assert(!part.complete && !part.champion && part.standings[0].wins === 1, 'partial round robin');
  // Garbage decisions are ignored.
  assert(roundRobin(names(4), 'xyz').standings.every((s) => s.wins === 0), 'garbage codes ignored');
}

// ---- swiss ----
section('swiss');
{
  const s0 = swiss(names(8));
  assert(s0.totalRounds === 3 && s0.rounds.length === 1 && s0.rounds[0].matches.length === 4, '8 players: 3 rounds, round 1 has 4 matches');
  // Play favourites (lower index wins) through all rounds.
  let w = '';
  let s = s0;
  for (let guard = 0; guard < 5 && !s.complete; guard++) {
    const cur = s.rounds[s.rounds.length - 1];
    for (const m of cur.matches) {
      if (m.p2 == null) continue;
      w += m.p1 < m.p2 ? '1' : '2';
    }
    s = swiss(names(8), w);
  }
  assert(s.complete && s.champion && s.champion.name === 'P1', `favourite wins swiss (got ${s.champion && s.champion.name})`);
  assert(s.rounds.length === 3 && s.matchCount === 12, 'three rounds of four matches');
  // No rematches when avoidable.
  const pairs = new Set();
  let rematch = false;
  for (const r of s.rounds) for (const m of r.matches) {
    if (m.p2 == null) continue;
    const k = m.p1 < m.p2 ? `${m.p1}-${m.p2}` : `${m.p2}-${m.p1}`;
    if (pairs.has(k)) rematch = true;
    pairs.add(k);
  }
  assert(!rematch, 'no rematches in 3-round swiss of 8');
  // Round 2 pairs winners with winners.
  const r2 = s.rounds[1].matches;
  const w1 = new Set(s.rounds[0].matches.map((m) => (m.winner === 'p1' ? m.p1 : m.p2)));
  assert(r2[0].p1 != null && w1.has(r2[0].p1) && w1.has(r2[0].p2), 'round 2 top match is winner vs winner');

  // Odd count: bye each round to someone new, bye counts as a win.
  const o = swiss(names(5), '', { rounds: 3 });
  const bye1 = o.rounds[0].matches.find((m) => m.p2 == null);
  assert(bye1 && o.standings.find((x) => x.idx === bye1.p1).wins === 1, 'bye player credited with a win');
  let ow = '', os = o;
  for (let guard = 0; guard < 5 && !os.complete; guard++) {
    for (const m of os.rounds[os.rounds.length - 1].matches) if (m.p2 != null) ow += '1';
    os = swiss(names(5), ow, { rounds: 3 });
  }
  const byePlayers = os.rounds.map((r) => r.matches.find((m) => m.p2 == null).p1);
  assert(new Set(byePlayers).size === 3, `three different players got the bye (${byePlayers})`);
  assert(os.complete, 'odd swiss completes');

  // Next round isn't generated until the current one is done.
  const half = swiss(names(8), '11');
  assert(half.rounds.length === 1, 'round 2 withheld while round 1 incomplete');
}

// ---- king of the hill ----
section('king of the hill');
{
  const k0 = kingOfTheHill(names(4));
  assert(k0.current.king === 0 && k0.current.challenger === 1 && k0.games.length === 0, 'starts P1 v P2');
  // King holds twice, then loses, then new king holds once.
  const k = kingOfTheHill(names(4), '1121');
  assert(k.games.length === 4, '4 games');
  assert(k.games[2].challenger === 3 && k.games[2].winner === 'challenger', 'third game: P4 took the throne');
  assert(k.king === 3, 'P4 is king');
  // queue after 4 games: P2 lost g1 -> back; P3 lost g2 -> back; P1 lost g3 -> back; P2 lost g4 -> back => P3 next
  assert(k.current.challenger === 2, `queue rotates: P3 challenges next (got ${k.current.challenger})`);
  const by = Object.fromEntries(k.standings.map((s) => [s.name, s]));
  assert(by.P1.kingWins === 2 && by.P1.reigns === 1 && by.P1.losses === 1, 'P1: 2 wins on top, 1 reign');
  assert(by.P4.kingWins === 1 && by.P4.reigns === 1 && by.P4.wins === 2, 'P4: 1 win on top, 2 wins total');
  assert(!k.champion, 'no champion until finished');
  const kf = kingOfTheHill(names(4), '1121', true);
  assert(kf.champion && kf.champion.name === 'P4' && kf.champion.runnerUp === 'P1', `champion = whoever holds the hill (got ${kf.champion && kf.champion.name}/${kf.champion && kf.champion.runnerUp})`);
  assert(kf.kingWins === 1 && kf.totalGames === 4 && kf.sessions === 1, 'king wins / totals reported');
  assert(kf.current === null, 'no current game once finished');
  // Tie on king wins -> current king ranks first.
  const kt = kingOfTheHill(names(3), '121', true);
  assert(kt.standings[0].name === 'P3' && kt.standings[0].kingWins === 1, `tie broken in favour of current king (got ${kt.standings[0].name})`);
  assert(standingsSummary(kf) === 'P1=2, P4=1, P2=0, P3=0', `koth summary (${standingsSummary(kf)})`);

  // Carry a lineage across sessions via a snapshot.
  const snap = kothSnapshot(kf);
  assert(snap.k === 3 && snap.g === 4 && snap.n === 1 && snap.s[0][0] === 2, `snapshot (${JSON.stringify(snap)})`);
  const resumed = kingOfTheHill(names(4), '', false, snap);
  assert(resumed.king === 3 && resumed.current.challenger === kf.queue[0], 'resumed: same king and next challenger');
  assert(resumed.games.length === 0 && resumed.totalGames === 4 && resumed.sessions === 2, 'resumed: fresh log, running totals kept');
  assert(resumed.standings.find((x) => x.name === 'P1').kingWins === 2, 'resumed: wins on top carried over');
  const resumed2 = kingOfTheHill(names(4), 'B1', true, snap);
  assert(resumed2.games[0].n === 5 && resumed2.kingWins === 2 && resumed2.champion.name === 'P4', 'resumed: game numbering and king wins continue');
  assert(kothSnapshot(resumed2).g === 5 && kothSnapshot(resumed2).n === 2, 'snapshot of a resumed session accumulates');
  // A snapshot for a different player count is ignored.
  assert(kingOfTheHill(names(3), '', false, snap).king === 0, 'mismatched snapshot ignored');
  assert(!kingOfTheHill(names(4), '', true).champion, 'finishing with no games gives no champion');

  // Chosen challengers: letter + outcome per game. Same story as '1121' but
  // spelled out, then a hand-picked challenger who wasn't next in line.
  const spelled = kingOfTheHill(names(4), 'B1C1D2B1', true);
  assert(JSON.stringify(spelled.games) === JSON.stringify(k.games), 'explicit challengers reproduce the legacy queue order');
  const chosen = kingOfTheHill(names(4), 'D1');            // P4 jumps the queue to challenge first
  assert(chosen.games[0].challenger === 3 && chosen.queue[0] === 1, `chosen challenger plays, queue order kept for the rest (${chosen.queue})`);
  assert(chosen.current.challenger === 1, 'default next challenger is still the longest wait');
  assert(kothChallengerCode(0) === 'A' && kothChallengerCode(26) === 'a', 'challenger codes');
  // Invalid: challenging yourself, unknown player, dangling letter -> stops parsing there.
  assert(kingOfTheHill(names(4), 'A1').games.length === 0, 'king cannot challenge himself');
  assert(kingOfTheHill(names(4), 'B1Z1').games.length === 1, 'unknown challenger ignored');
  assert(kingOfTheHill(names(4), 'B1C').games.length === 1, 'dangling code ignored');
}

// ---- free-for-all ----
section('free-for-all');
{
  const f0 = freeForAll(names(4));
  assert(f0.rounds.length === 0 && !f0.champion && !f0.tie, 'empty');
  const r1 = encodeFfaRound([2, 0, 3, 1]);
  const r2 = encodeFfaRound([2, 3]); // only two raced
  const f = freeForAll(names(4), [r1, r2].join('|'));
  const by = Object.fromEntries(f.standings.map((s) => [s.name, s]));
  assert(by.P3.points === 8 && by.P4.points === 5 && by.P1.points === 3 && by.P2.points === 1, `default points n..1 (${standingsSummary(f)})`);
  assert(by.P2.rounds === 1 && by.P3.rounds === 2, 'rounds played counted');
  assert(f.standings[0].name === 'P3', 'leader');
  assert(!f.champion, 'no champion until finished');
  assert(freeForAll(names(4), [r1, r2].join('|'), true).champion.name === 'P3', 'champion on finish');
  // Custom points.
  const fc = freeForAll(names(4), r1, false, { points: [10, 5] });
  assert(fc.standings[0].points === 10 && fc.standings[1].points === 5 && fc.standings[2].points === 0, 'custom points table');
  // Tie: equal points and identical placings.
  const ft = freeForAll(names(2), [encodeFfaRound([0, 1]), encodeFfaRound([1, 0])].join('|'), true);
  assert(ft.tie && ft.tie.length === 2 && !ft.champion, 'tie blocks the champion');
  // Tie on points broken by more firsts.
  // P1: 1st + 3rd = 6, P2: 2nd + 2nd = 6 -> P1 ahead on firsts.
  const fp = freeForAll(names(4), [encodeFfaRound([0, 1, 2, 3]), encodeFfaRound([3, 1, 0, 2])].join('|'), true);
  assert(fp.standings[0].name === 'P1' && fp.standings[0].points === fp.standings[1].points, `points tie broken by firsts (${standingsSummary(fp)})`);
  // Garbage is ignored.
  assert(freeForAll(names(4), 'zz|').rounds.length === 0, 'garbage round ignored');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
