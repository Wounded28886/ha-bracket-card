import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// Minimal DOM + globals for the card bundle.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.customElements = window.customElements;
// Keep Node's own timers (jsdom's setTimeout delegates back to the global and
// would recurse). Run rAF callbacks synchronously so the connector-line pass
// executes inside the test; jsdom has no layout, so it draws zero-length paths.
globalThis.requestAnimationFrame = (f) => { f(); return 0; };
globalThis.SVGElement = window.SVGElement;
// jsdom lacks color-mix but never evaluates CSS values in JS, so nothing to shim.

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('  ✗', m));

// Load the bundle as a module.
const code = readFileSync(new URL('../dist/ha-bracket-card.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
await import(dataUrl);

ok(!!customElements.get('bracket-card'), 'custom element registered');
ok(window.customCards && window.customCards.some(c => c.type === 'bracket-card'), 'card registered in picker');

// Fake hass with a mutable input_text state and a recording callService.
const ENTITY = 'input_text.game_night_bracket';
let saved = '';
const calls = [];
function makeHass(value) {
  return {
    states: { [ENTITY]: { state: value, attributes: {} } },
    callService: (domain, service, data) => {
      calls.push({ domain, service, data });
      saved = data.value;
    },
  };
}

const el = document.createElement('bracket-card');
el.setConfig({ entity: ENTITY, title: 'Game Night' });
el.hass = makeHass('');
document.body.appendChild(el);

// Setup view should be present.
ok(!!el.shadowRoot.querySelector('#draft'), 'setup textarea shown when empty');
ok(!!el.shadowRoot.querySelector('#create'), 'create button shown');

// Simulate typing a game and players, then creating.
ok(!!el.shadowRoot.querySelector('#game'), 'game name input shown on setup');
el._game = 'Mario Kart';
el._draft = 'Alice\nBob\nCharlie\nDana\nEve';
el.shadowRoot.querySelector('#create').click();
ok(calls.length === 1 && calls[0].service === 'set_value', 'create wrote to helper');
ok(saved.length > 0 && saved.length <= 255, `payload persisted and <=255 chars (len=${saved.length})`);
const parsed = JSON.parse(saved);
ok(parsed.p.length === 5, 'stored 5 players');
ok(parsed.g === 'Mario Kart', 'stored game name');
ok(Number.isInteger(parsed.c) && parsed.c > 1700000000, 'stored creation time');

// Feed the saved value back as new hass state -> bracket view.
el.hass = makeHass(saved);
ok(!el.shadowRoot.querySelector('#draft'), 'setup gone after creation');
ok(el.shadowRoot.querySelectorAll('.section').length >= 2, 'winners + losers sections rendered');
ok(!!el.shadowRoot.querySelector('#new'), 'New bracket button shown');
ok(el.shadowRoot.querySelector('.title .pill')?.textContent === 'Mario Kart', 'game name shown in header');
ok(el.shadowRoot.querySelector('.title .pill.mode')?.textContent === 'Double elimination', 'format shown in header');
ok(!!el.shadowRoot.querySelector('#mode') === false, 'mode select only on setup');

// New layout: 5 players -> 2 real round-1 matches, 1 walkover, 1 hidden bye-vs-bye;
// grand final in its own column on the right; connector SVG present.
const r1 = [...el.shadowRoot.querySelectorAll('.section.wb .col')][0].querySelectorAll('.match');
ok(r1.length === 4, `round 1 keeps 4 slots (got ${r1.length})`);
ok([...r1].filter(m => m.classList.contains('hidden')).length === 1, 'exactly one bye-vs-bye slot hidden');
ok([...r1].filter(m => m.querySelectorAll('.p.real').length === 2).length === 2, 'two real round-1 matches');
ok(!!el.shadowRoot.querySelector('.bracket > .gf-col .match[data-id="GF-1"]'), 'grand final in right-hand column');
ok(!el.shadowRoot.querySelector('.match[data-id="GF-2"]'), 'reset game not shown before it exists');
ok(!!el.shadowRoot.querySelector('svg.lines path'), 'connector path drawn');
// Names were shuffled: the stored order is a permutation of the input.
ok([...parsed.p].sort().join() === ['Alice','Bob','Charlie','Dana','Eve'].join(), 'stored players are a permutation of the input');

// Play the whole thing out by repeatedly clicking the first clickable name
// until a champion banner appears (guard against infinite loop).
let guard = 0;
while (!el.shadowRoot.querySelector('.champ') && guard++ < 100) {
  // Pick a name only inside an UNDECIDED match (no .p.win present), to mimic
  // real forward play rather than re-picking settled matches.
  let clicked = false;
  for (const match of el.shadowRoot.querySelectorAll('.match')) {
    if (match.querySelector('.p.win')) continue;           // already decided
    const name = match.querySelector('.p[data-click="1"]');
    if (name) { name.click(); clicked = true; break; }
  }
  if (!clicked) break;
  el.hass = makeHass(saved); // reflect the just-saved state back
}
ok(guard < 100, 'bracket resolved without runaway loop');
const champ = el.shadowRoot.querySelector('.champ');
ok(!!champ, 'champion banner appears when tournament completes');
ok(/Champion:/.test(champ ? champ.textContent : ''), 'champion banner text');

// Re-pick safety: clicking a decided early match should not throw.
let threw = false;
try {
  const anyName = el.shadowRoot.querySelector('.p.real');
  if (anyName && anyName.getAttribute('data-click') === '1') anyName.click();
} catch (e) { threw = true; }
ok(!threw, 're-pick does not throw');

// Reset flow.
el.hass = makeHass(saved);
el.shadowRoot.querySelector('#new').click();          // -> confirm
ok(!!el.shadowRoot.querySelector('#do-reset'), 'confirm shown');
el.shadowRoot.querySelector('#do-reset').click();      // -> clear
ok(saved === '', 'reset cleared the helper value');

// Unknown entity handling.
const el2 = document.createElement('bracket-card');
el2.setConfig({ entity: ENTITY });
el2.hass = { states: {}, callService: () => {} };
ok(/not found/.test(el2.shadowRoot.textContent), 'missing helper message');

// Bad config rejected.
let cfgThrew = false;
try { document.createElement('bracket-card').setConfig({}); } catch (e) { cfgThrew = true; }
ok(cfgThrew, 'setConfig without entity throws');

// ---- tracking: result written through the rest_command, then flagged ----
const tick = () => new Promise((r) => setTimeout(r, 0));
async function playOut(card, hassFor) {
  let g = 0;
  while (!card.shadowRoot.querySelector('.champ') && g++ < 100) {
    let clicked = false;
    for (const match of card.shadowRoot.querySelectorAll('.match')) {
      if (match.querySelector('.p.win')) continue;
      const name = match.querySelector('.p[data-click="1"]');
      if (name) { name.click(); clicked = true; break; }
    }
    if (!clicked) break;
    await tick();
    card.hass = hassFor(saved);
  }
}
{
  saved = '';
  const ws = [];
  let failWrite = false;
  const hassT = (value) => ({
    ...makeHass(value),
    callWS: async (msg) => {
      ws.push(msg);
      if (failWrite) throw new Error('boom');
      return { response: { status: 204, content: '' } };
    },
  });
  const t = document.createElement('bracket-card');
  t.setConfig({ entity: ENTITY, tracking: true });
  t.hass = hassT('');
  t._game = 'UNO';
  t._draft = 'Alice\nBob\nCharlie';
  t.shadowRoot.querySelector('#create').click();
  t.hass = hassT(saved);
  failWrite = true;
  await playOut(t, hassT);
  await tick();
  t.hass = hassT(saved);
  ok(ws.length === 1 && ws[0].domain === 'rest_command' && ws[0].service === 'game_night_write'
     && ws[0].return_response === true, 'write went to rest_command.game_night_write with return_response');
  const line = ws[0].service_data.line;
  ok(/^result,game=UNO,mode=double_elimination winner="[A-Za-z]+",runner_up="[A-Za-z]+",players="[^"]+",player_count=3i \d{10}$/.test(line),
     `line protocol shape (got ${line})`);
  ok(!JSON.parse(saved).r && /Not saved: boom/.test(t.shadowRoot.querySelector('.champ').textContent)
     && !!t.shadowRoot.querySelector('#retry'), 'failed write shows error and Retry, state not flagged');
  failWrite = false;
  t.shadowRoot.querySelector('#retry').click();
  await tick(); await tick();
  t.hass = hassT(saved);
  ok(ws.length === 2 && ws[1].service_data.line === line, 'retry re-sends the same line');
  ok(JSON.parse(saved).r === 1 && /Result recorded/.test(t.shadowRoot.querySelector('.champ').textContent),
     'successful write flags the bracket as recorded');

  // Escaping: spaces/commas in the game tag, quotes in names.
  saved = '';
  ws.length = 0;
  const t2 = document.createElement('bracket-card');
  t2.setConfig({ entity: ENTITY, tracking: { measurement: 'gn' } });
  t2.hass = hassT('');
  t2._game = 'Mario Kart, deluxe';
  t2._draft = 'Al "Ace"\nBo';
  t2.shadowRoot.querySelector('#create').click();
  t2.hass = hassT(saved);
  await playOut(t2, hassT);
  await tick();
  const l2 = ws[0].service_data.line;
  ok(l2.startsWith('gn,game=Mario\\ Kart\\,\\ deluxe,mode=double_elimination ') && l2.includes('\\"Ace\\"'),
     `tag and string escaping (got ${l2})`);
  let badCfg = false;
  try { document.createElement('bracket-card').setConfig({ entity: ENTITY, tracking: { measurement: 'a b' } }); } catch (e) { badCfg = true; }
  ok(badCfg, 'invalid measurement rejected');
}

// ---- history card ----
{
  const now = Math.floor(Date.now() / 1000);
  const influx = { results: [{ series: [{ name: 'result',
    columns: ['time', 'winner', 'runner_up', 'players', 'player_count', 'game'],
    values: [
      [now, 'Eve', 'Bob', 'Alice, Bob, Eve', 3, 'UNO'],
      [now - 86400, 'Bob', 'Eve', 'Alice, Bob, Eve', 3, 'Mario Kart'],
      [now - 2 * 86400, 'Eve', 'Alice', 'Alice, Bob, Eve', 3, 'Mario Kart'],
    ] }] }] };
  const queries = [];
  const h = document.createElement('bracket-history-card');
  h.setConfig({ title: 'Hall of Fame' });
  h.hass = { states: {}, callWS: async (msg) => { queries.push(msg); return { response: { status: 200, content: influx } }; } };
  await tick(); await tick();
  ok(queries.length === 1 && queries[0].service === 'game_night_query'
     && /^SELECT .*"standings", "top_wins", "game", "mode" FROM "result" ORDER BY time DESC LIMIT 100$/.test(queries[0].service_data.q), 'history queries InfluxQL via rest_command');
  const txt = h.shadowRoot.textContent;
  ok(/Current champion:[ \u00a0]Eve/.test(txt) && /UNO/.test(txt), 'current champion from most recent row');
  const board = [...h.shadowRoot.querySelectorAll('table')[0].querySelectorAll('tr')]
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()).join('|')).join(';');
  ok(board === '1|Eve|2 wins;2|Bob|1 win', `leaderboard counts (got ${board})`);
  ok(h.shadowRoot.querySelectorAll('table')[1].querySelectorAll('tr').length === 3, 'all results listed');
  const sel = h.shadowRoot.querySelector('#filter');
  ok(!!sel, 'game filter shown when more than one game');
  sel.value = 'Mario Kart'; sel.onchange({ target: sel });
  ok(/Current champion:[ \u00a0]Bob/.test(h.shadowRoot.textContent), 'filtering by game changes champion');
  ok(h.shadowRoot.querySelectorAll('table')[1].querySelectorAll('tr').length === 2, 'filter narrows results');

  const hErr = document.createElement('bracket-history-card');
  hErr.setConfig({});
  hErr.hass = { states: {}, callWS: async () => { throw new Error('Service rest_command.game_night_query not found'); } };
  await tick(); await tick();
  ok(/Couldn't load results: Service rest_command.game_night_query not found/.test(hErr.shadowRoot.textContent), 'history shows load error');
}

// ---- formats: single elimination, round robin, swiss, king of the hill, free-for-all ----
{
  const mk = (mode, players, extra = {}) => {
    saved = '';
    const ws = [];
    const hassF = (value) => ({ ...makeHass(value), callWS: async (m) => { ws.push(m); return { response: { status: 204, content: '' } }; } });
    const c = document.createElement('bracket-card');
    c.setConfig({ entity: ENTITY, tracking: true, ...extra });
    c.hass = hassF('');
    ok(!!c.shadowRoot.querySelector('#mode'), `${mode}: format select on setup`);
    c._mode = mode; c._game = 'G'; c._draft = players.join('\n');
    c.shadowRoot.querySelector('#create').click();
    c.hass = hassF(saved);
    return { c, ws, hassF };
  };
  const names = (card) => [...card.shadowRoot.querySelectorAll('.p.real .nm')].map((n) => n.textContent.trim());

  // single elimination: no losers bracket, no grand final, champion after n-1 matches
  {
    const { c, ws, hassF } = mk('s', ['A', 'B', 'C', 'D', 'E']);
    ok(JSON.parse(saved).m === 's', 'single: mode stored');
    ok(!c.shadowRoot.querySelector('.section.lb') && !c.shadowRoot.querySelector('.gf-col'), 'single: no losers bracket / grand final');
    ok(c.shadowRoot.querySelector('.title .pill.mode')?.textContent === 'Single elimination', 'single: header pill');
    let picks = 0;
    await playOut(c, hassF);
    await tick(); c.hass = hassF(saved);
    ok(!!c.shadowRoot.querySelector('.champ'), 'single: champion decided');
    ok(ws.length === 1 && /,mode=single_elimination /.test(ws[0].service_data.line), 'single: recorded with mode tag');
    ok(JSON.parse(saved).r === 1, 'single: flagged recorded');
  }

  // round robin: 4 players -> 6 matches in 3 rounds; standings; champion; tie decider
  {
    const { c, ws, hassF } = mk('r', ['A', 'B', 'C', 'D']);
    ok(c.shadowRoot.querySelectorAll('.col').length === 3 && c.shadowRoot.querySelectorAll('.match').length === 6, 'rr: 3 rounds, 6 matches');
    ok(/Standings/.test(c.shadowRoot.textContent), 'rr: standings table');
    // Pick p1 everywhere except make it a clean sweep by index order: click first name of each undecided match.
    for (let g = 0; g < 10 && !c.shadowRoot.querySelector('.champ') && !c.shadowRoot.querySelector('.tie') && !c.shadowRoot.querySelector('.bracket[data-key="dec"]'); g++) {
      const m = [...c.shadowRoot.querySelectorAll('.match')].find((x) => !x.querySelector('.p.win'));
      if (!m) break;
      m.querySelector('.p[data-click="1"]').click();
      await tick(); c.hass = hassF(saved);
    }
    const st = JSON.parse(saved);
    ok(st.w.length === 6 && !/0/.test(st.w), `rr: all six decided (w=${st.w})`);
    const done = !!c.shadowRoot.querySelector('.champ');
    const dec = !!c.shadowRoot.querySelector('.bracket[data-key="dec"]');
    ok(done || dec, 'rr: complete -> champion or decider bracket');
    if (dec) {
      // Play the decider to a finish.
      for (let g = 0; g < 6 && !c.shadowRoot.querySelector('.champ'); g++) {
        const m = [...c.shadowRoot.querySelectorAll('.bracket[data-key="dec"] .match')].find((x) => !x.querySelector('.p.win') && x.querySelector('.p[data-click="1"]'));
        if (!m) break;
        m.querySelector('.p[data-click="1"]').click();
        await tick(); c.hass = hassF(saved);
      }
      ok(JSON.parse(saved).d && JSON.parse(saved).d.length > 0, 'rr: decider decisions stored');
    }
    ok(!!c.shadowRoot.querySelector('.champ'), 'rr: champion crowned');
    await tick(); c.hass = hassF(saved);
    ok(ws.length === 1 && /,mode=round_robin .*standings="[^"]+=\d-\d/.test(ws[0].service_data.line), `rr: recorded with standings (${ws[0] && ws[0].service_data.line})`);
    // Re-pick an early match: champion gone, record flag cleared.
    const first = c.shadowRoot.querySelector('.match .p.lose');
    ok(first && first.getAttribute('data-click') === '1', 'rr: loser row is re-pickable');
    first.click(); await tick(); c.hass = hassF(saved);
    ok(JSON.parse(saved).d === undefined, 'rr: re-pick clears the decider');
    // Either the tournament is undecided again, or the changed standings were re-recorded.
    const stillDone = !!c.shadowRoot.querySelector('.champ');
    ok(stillDone ? ws.length === 2 && JSON.parse(saved).r === 1 : JSON.parse(saved).r !== 1,
       `rr: re-pick re-records (stillDone=${stillDone}, writes=${ws.length})`);
  }

  // swiss: rounds appear one at a time; rounds input on setup
  {
    saved = '';
    const c0 = document.createElement('bracket-card');
    c0.setConfig({ entity: ENTITY });
    c0.hass = makeHass('');
    c0._mode = 'w'; c0._render();
    ok(!!c0.shadowRoot.querySelector('#rounds'), 'swiss: rounds input shown');
    const { c, hassF } = mk('w', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    ok(JSON.parse(saved).m === 'w' && /Round 1 of 3/.test(c.shadowRoot.textContent), 'swiss: 8 players -> 3 rounds');
    ok(c.shadowRoot.querySelectorAll('.col').length === 1, 'swiss: only round 1 shown');
    for (const m of c.shadowRoot.querySelectorAll('.match')) { m.querySelector('.p[data-click="1"]').click(); await tick(); c.hass = hassF(saved); }
    ok(c.shadowRoot.querySelectorAll('.col').length === 2, 'swiss: round 2 appears once round 1 is done');
    // Decide one round-2 match, then change a round-1 result: round 2 is re-paired and its decision dropped.
    const r2 = c.shadowRoot.querySelectorAll('.col')[1].querySelector('.match .p[data-click="1"]');
    r2.click(); await tick(); c.hass = hassF(saved);
    ok(JSON.parse(saved).w.length === 5, `swiss: round-2 decision stored (w=${JSON.parse(saved).w})`);
    c.shadowRoot.querySelectorAll('.col')[0].querySelector('.match .p.lose').click(); await tick(); c.hass = hassF(saved);
    ok(JSON.parse(saved).w.length === 4 && c.shadowRoot.querySelectorAll('.col').length === 2
       && !c.shadowRoot.querySelectorAll('.col')[1].querySelector('.p.win'),
       `swiss: re-pick in round 1 drops round-2 decisions (w=${JSON.parse(saved).w})`);
  }

  // king of the hill: tap winner, undo, finish, top_wins recorded
  {
    const { c, ws, hassF } = mk('k', ['A', 'B', 'C']);
    const cur = () => names(c);
    ok(cur().length === 2 && /👑/.test(cur()[0]), `koth: current game shown (${cur()})`);
    const king0 = cur()[0].replace('👑 ', '');
    c.shadowRoot.querySelector('.p[data-side="p1"]').click(); await tick(); c.hass = hassF(saved); // king holds
    c.shadowRoot.querySelector('.p[data-side="p1"]').click(); await tick(); c.hass = hassF(saved); // holds again
    c.shadowRoot.querySelector('.p[data-side="p2"]').click(); await tick(); c.hass = hassF(saved); // dethroned
    ok(JSON.parse(saved).w === '112', 'koth: games encoded');
    ok(cur()[0] !== `👑 ${king0}`, 'koth: new king after challenger win');
    c.shadowRoot.querySelector('#undo').click(); await tick(); c.hass = hassF(saved);
    ok(JSON.parse(saved).w === '11' && cur()[0] === `👑 ${king0}`, 'koth: undo restores previous king');
    ok(!c.shadowRoot.querySelector('.champ'), 'koth: no champion before finish');
    c.shadowRoot.querySelector('#finish').click(); await tick();
    c.shadowRoot.querySelector('#do-finish').click(); await tick(); c.hass = hassF(saved);
    ok(JSON.parse(saved).f === 1 && /Champion:/.test(c.shadowRoot.querySelector('.champ').textContent), 'koth: finish crowns champion');
    ok(ws.length === 1 && new RegExp(`,mode=king_of_the_hill winner="${king0}".*top_wins=2i`).test(ws[0].service_data.line), `koth: recorded with top_wins (${ws[0] && ws[0].service_data.line})`);
    ok(!c.shadowRoot.querySelector('.p[data-click="1"]'), 'koth: no more picks after finish');
    c.shadowRoot.querySelector('#undo').click(); await tick(); c.hass = hassF(saved); // reopen
    ok(JSON.parse(saved).f !== 1 && JSON.parse(saved).r !== 1 && !!c.shadowRoot.querySelector('.p[data-click="1"]'), 'koth: reopen clears finish + recorded');
  }

  // free-for-all: tap order, save round, points, tie blocks finish, custom points
  {
    const { c, ws, hassF } = mk('f', ['A', 'B', 'C'], { ffa_points: [5, 3, 1] });
    const chips = () => [...c.shadowRoot.querySelectorAll('[data-ffa]')];
    ok(chips().length === 3 && c.shadowRoot.querySelector('#ffa-save').disabled, 'ffa: chips shown, save disabled until 2 placed');
    chips()[1].click(); chips()[0].click(); chips()[2].click();
    ok(c.shadowRoot.querySelectorAll('.chip.placed').length === 3 && c.shadowRoot.querySelector('.chip.placed .badge').textContent === '2nd', 'ffa: placings badged');
    c.shadowRoot.querySelector('#ffa-save').click(); await tick(); c.hass = hassF(saved);
    const P = JSON.parse(saved).p;
    ok(JSON.parse(saved).w.length === 3 && /Round 2/.test(c.shadowRoot.textContent), 'ffa: round saved');
    const top = c.shadowRoot.querySelector('table tr:nth-child(2)');
    ok(top && top.textContent.includes(P[1]) && top.textContent.includes('5'), `ffa: first place got 5 pts (${top && top.textContent.trim()})`);
    // Second round reversed -> tie on points? A:5+1=6? no: B first (5) then A (3) then C (1); reverse: C 5, A 3, B 1 -> B 6, A 6, C 6 all tied but identical placings? B: 1st,3rd; A: 2nd,2nd; C: 3rd,1st -> B and C tie on firsts too.
    chips()[2].click(); chips()[0].click(); chips()[1].click();
    c.shadowRoot.querySelector('#ffa-save').click(); await tick(); c.hass = hassF(saved);
    ok(!!c.shadowRoot.querySelector('.tie') && c.shadowRoot.querySelector('#finish').disabled, 'ffa: tie at the top blocks finish');
    c.shadowRoot.querySelector('#undo').click(); await tick(); c.hass = hassF(saved);
    ok(!c.shadowRoot.querySelector('.tie') && !c.shadowRoot.querySelector('#finish').disabled, 'ffa: undo round lifts the tie');
    c.shadowRoot.querySelector('#finish').click(); await tick();
    c.shadowRoot.querySelector('#do-finish').click(); await tick(); c.hass = hassF(saved);
    ok(/Champion:/.test(c.shadowRoot.querySelector('.champ')?.textContent || ''), 'ffa: champion on finish');
    ok(ws.length === 1 && new RegExp(`,mode=free_for_all winner="${P[1]}".*standings="${P[1]}=5`).test(ws[0].service_data.line), `ffa: recorded with points standings (${ws[0] && ws[0].service_data.line})`);
  }

  // default_mode config + legacy state without a mode decodes as double elim
  {
    const c = document.createElement('bracket-card');
    c.setConfig({ entity: ENTITY, default_mode: 'round robin' });
    c.hass = makeHass('');
    ok(c.shadowRoot.querySelector('#mode').value === 'r', 'default_mode accepts a label');
    c.hass = makeHass('{"v":2,"p":["A","B","C"],"w":"100000","x":1}');
    ok(c.shadowRoot.querySelector('.title .pill.mode')?.textContent === 'Double elimination' && !!c.shadowRoot.querySelector('.gf-col'), 'legacy state renders as double elimination');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
