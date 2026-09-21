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

// ---- bye propagation (n=5 -> size 8, 3 byes) ----
section('bye handling (n=5)');
{
  const names = ['A','B','C','D','E'];
  const s = generateBracket(names);
  // Count real players auto-advanced in WB round 1.
  let r1decided = 0;
  for (const id of s.order) {
    const m = s.matches[id];
    if (m.bracket === 'W' && m.round === 1 && m.winner && m.winner !== 'bye') r1decided++;
  }
  assert(r1decided === 3, `3 R1 byes auto-advance real players (got ${r1decided})`);
  // No match ever pairs bye vs bye in round 1.
  let byeVbye = 0;
  for (const id of s.order) {
    const m = s.matches[id];
    if (m.bracket === 'W' && m.round === 1 && m.p1 && m.p2 &&
        m.p1.type === 'bye' && m.p2.type === 'bye') byeVbye++;
  }
  assert(byeVbye === 0, 'no bye-vs-bye in WB round 1');
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
