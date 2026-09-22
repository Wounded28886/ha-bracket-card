import {
  generateBracket, setWinner, champion, resolve,
  nextPow2, seedOrder, slotLabel,
} from '../src/bracket.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ---- nextPow2 / seedOrder ----
section('helpers');
assert(nextPow2(2) === 2, 'nextPow2(2)=2');
assert(nextPow2(3) === 4, 'nextPow2(3)=4');
assert(nextPow2(5) === 8, 'nextPow2(5)=8');
assert(nextPow2(8) === 8, 'nextPow2(8)=8');
assert(nextPow2(9) === 16, 'nextPow2(9)=16');
assert(JSON.stringify(seedOrder(4)) === JSON.stringify([1,4,2,3]), 'seedOrder(4)=[1,4,2,3]');
assert(JSON.stringify(seedOrder(8)) === JSON.stringify([1,8,4,5,2,7,3,6]), 'seedOrder(8) standard');

// ---- structure counts ----
section('structure counts');
function structure(n) {
  const names = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
  const s = generateBracket(names, { resetBracket: true });
  const byBracket = { W: 0, L: 0, GF: 0 };
  for (const id of s.order) byBracket[s.matches[id].bracket]++;
  return { s, byBracket, size: s.size };
}
// For size S: WB = S-1 matches, LB = S-2 matches, GF = 1 (+1 reset).
for (const [n, size] of [[2,2],[3,4],[4,4],[5,8],[8,8],[9,16],[16,16]]) {
  const { s, byBracket } = structure(n);
  assert(s.size === size, `n=${n} size=${size}`);
  assert(byBracket.W === size - 1, `n=${n} WB matches = ${size-1} (got ${byBracket.W})`);
  assert(byBracket.L === size - 2, `n=${n} LB matches = ${size-2} (got ${byBracket.L})`);
  assert(byBracket.GF === 2, `n=${n} GF matches = 2 (got ${byBracket.GF})`);
}

// ---- every non-GF match has routing wired ----
section('routing wiring');
{
  const { s } = structure(8);
  for (const id of s.order) {
    const m = s.matches[id];
    if (m.bracket === 'GF') continue;
    // Winners final winner -> GF-1; every other W/L winner must route somewhere.
    assert(m.winnerTo != null, `${id} has winnerTo`);
    if (m.bracket === 'W' && m.round < Math.log2(s.size)) {
      assert(m.loserTo != null, `${id} (WB non-final) has loserTo`);
    }
  }
  // WB final loser routes into LB final.
  const wbFinal = s.matches['W3-1'];
  assert(wbFinal.loserTo && wbFinal.loserTo.match === 'L4-1', 'WB final loser -> L4-1');
}

// ---- bye placement: byes as late as possible, spread fairly ----
section('bye handling (n=5)');
{
  const s = generateBracket(['A','B','C','D','E']);
  const r1 = s.order.map((id) => s.matches[id]).filter((m) => m.bracket === 'W' && m.round === 1);
  const kind = (m) => {
    const a = m.p1 && m.p1.type, b = m.p2 && m.p2.type;
    if (a === 'player' && b === 'player') return 'full';
    if (a === 'bye' && b === 'bye') return 'empty';
    return 'walkover';
  };
  const kinds = r1.map(kind);
  assert(kinds.filter((k) => k === 'full').length === 2, `2 real R1 matches for 5 players (got ${JSON.stringify(kinds)})`);
  assert(kinds.filter((k) => k === 'walkover').length === 1, 'exactly one player sits out R1');
  assert(kinds.filter((k) => k === 'empty').length === 1, 'the remaining slot pair is an empty (hidden) match');
  // Each non-full match must share its round-2 pair with a full match, so the
  // R1 bye player faces a real winner in R2 instead of walking over twice.
  for (let i = 0; i < r1.length; i += 2) {
    const pair = [kinds[i], kinds[i + 1]];
    assert(pair.includes('full'), `R2 pair ${i / 2} contains a real match (got ${pair})`);
  }
  // Play the real R1 matches; R2 then has exactly one real match and one
  // walkover — the R1 bye player faces a winner, the other winner sits out.
  for (const m of r1) if (kind(m) === 'full') setWinner(s, m.id, 'p1');
  const r2 = s.order.map((id) => s.matches[id]).filter((m) => m.bracket === 'W' && m.round === 2);
  const r2kinds = r2.map(kind);
  assert(r2kinds.filter((k) => k === 'full').length === 1, `1 real R2 match (got ${JSON.stringify(r2kinds)})`);
  assert(r2kinds.filter((k) => k === 'walkover').length === 1, '1 R2 walkover');
}

section('bye placement across sizes');
for (const n of [2, 3, 4, 5, 6, 7, 9, 12, 13]) {
  const names = Array.from({ length: n }, (_, i) => 'P' + (i + 1));
  const s = generateBracket(names);
  const r1 = s.order.map((id) => s.matches[id]).filter((m) => m.bracket === 'W' && m.round === 1);
  const full = r1.filter((m) => m.p1.type === 'player' && m.p2.type === 'player').length;
  const walk = r1.filter((m) => (m.p1.type === 'player') !== (m.p2.type === 'player')).length;
  assert(full === Math.floor(n / 2), `n=${n}: R1 has floor(n/2)=${Math.floor(n / 2)} real matches (got ${full})`);
  assert(walk === n % 2, `n=${n}: R1 has ${n % 2} walkover(s) (got ${walk})`);
  // Every player appears exactly once in R1.
  const seen = new Set();
  for (const m of r1) for (const p of [m.p1, m.p2]) if (p.type === 'player') seen.add(p.name);
  assert(seen.size === n, `n=${n}: every player placed once`);
}

// ---- full playthrough: seed 1 wins everything (n=8) ----
section('full playthrough, favourite wins (n=8)');
{
  const names = ['S1','S2','S3','S4','S5','S6','S7','S8'];
  let s = generateBracket(names);
  // Deterministically resolve: always the lower "seed number" (=stronger) wins.
  s = playOut(s, (m) => {
    const a = m.p1, b = m.p2;
    if (a.type==='player' && b.type==='player') return a.seed < b.seed ? 'p1' : 'p2';
    return a.type==='player' ? 'p1' : 'p2';
  });
  const champ = champion(s);
  assert(champ && champ.name === 'S1', `champion is S1 (got ${champ && champ.name})`);
  assert(champ && champ.runnerUp === 'S2', `runner-up is S2 (got ${champ && champ.runnerUp})`);
  // Favourite never lost, so no bracket reset should be needed (GF-1 p1 wins).
  assert(s.matches['GF-1'].winner === 'p1', 'GF-1 won by WB entrant');
  assert(!s.matches['GF-2'].winner, 'GF-2 not played');
}

// ---- bracket reset path: LB entrant wins GF-1 then GF-2 ----
section('grand-final bracket reset (n=4)');
{
  const names = ['A','B','C','D'];
  let s = generateBracket(names);
  // Play WB + LB arbitrarily until GF-1 is ready.
  s = playOut(s, favouriteLower, { stopAt: 'GF-1' });
  const gf1 = s.matches['GF-1'];
  assert(gf1.p1 && gf1.p2 && gf1.p1.type==='player' && gf1.p2.type==='player', 'GF-1 has two players');
  // Force LB entrant (p2) to win GF-1 -> should spawn GF-2 with same players.
  s = setWinner(s, 'GF-1', 'p2');
  const gf2 = s.matches['GF-2'];
  assert(gf2.p1 && gf2.p2, 'GF-2 populated after reset');
  assert(champion(s) === null, 'no champion yet after GF-1 reset');
  // p1 wins GF-2.
  s = setWinner(s, 'GF-2', 'p1');
  const champ = champion(s);
  assert(champ != null, 'champion decided after GF-2');
  const gf2Names = [gf2.p1.name, gf2.p2.name];
  assert(champ.name === gf2.p1.name && champ.runnerUp === gf2.p2.name,
    `champion/runner-up come from GF-2 (${gf2Names} -> ${champ.name}/${champ.runnerUp})`);
}

// ---- reset disabled: GF-1 decides outright ----
section('resetBracket=false');
{
  const s0 = generateBracket(['A','B','C','D'], { resetBracket: false });
  assert(!s0.matches['GF-2'], 'no GF-2 when resetBracket=false');
  let s = playOut(s0, favouriteLower);
  assert(champion(s) != null, 'champion decided with reset disabled');
}

// ---- idempotent resolve ----
section('resolve idempotency');
{
  const s = generateBracket(['A','B','C','D','E','F','G']); // 7 -> size 8
  const before = JSON.stringify(s.matches);
  resolve(s); resolve(s);
  assert(JSON.stringify(s.matches) === before, 'resolve is idempotent on fresh bracket');
}

// ---- helper: play a bracket to completion ----
function favouriteLower(m) {
  const a = m.p1, b = m.p2;
  if (a && b && a.type==='player' && b.type==='player') return a.seed < b.seed ? 'p1' : 'p2';
  if (a && a.type==='player') return 'p1';
  return 'p2';
}
function playOut(s, chooser, { stopAt } = {}) {
  let guard = 0;
  while (guard++ < 500) {
    // find next undecided match with two real players
    let next = null;
    for (const id of s.order) {
      if (stopAt && id === stopAt) continue;
      const m = s.matches[id];
      if (m.winner) continue;
      if (m.p1 && m.p2 && m.p1.type==='player' && m.p2.type==='player') { next = m; break; }
    }
    if (!next) break;
    s = setWinner(s, next.id, chooser(next));
  }
  return s;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
