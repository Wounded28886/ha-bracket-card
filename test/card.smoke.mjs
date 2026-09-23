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
  ok(/^result,game=UNO,mode=double_elimination winner="[A-Za-z]+",runner_up="[A-Za-z]+",players="[^"]+",player_count=3i,placings="[^"]+" \d{10}$/.test(line),
     `line protocol shape (got ${line})`);
  const placed = /placings="([^"]+)"/.exec(line)[1].split(', ');
  const winner = /winner="([^"]+)"/.exec(line)[1];
  const second = /runner_up="([^"]+)"/.exec(line)[1];
  ok(placed.length === 3 && placed[0] === winner && placed[1] === second,
     `the finishing order leads with the champion and runner-up (${placed})`);
  ok(new Set(placed).size === 3, 'every player is placed exactly once');
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
  const DAY = 86400;
  const at = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);
  const cols = ['time', 'winner', 'runner_up', 'players', 'player_count', 'placings',
                'standings', 'top_wins', 'games', 'sessions', 'last_played', 'temp', 'game', 'mode'];
  const row = (time, game, mode, winner, runnerUp, players, placings, extra = {}) => ([
    time, winner, runnerUp, players.join(', '), players.length,
    placings ? placings.join(', ') : null, extra.standings ?? null, extra.top_wins ?? null,
    extra.games ?? null, extra.sessions ?? null, extra.last_played ?? null,
    extra.temp ?? null, game, mode,
  ]);
  const thisYear = new Date().getFullYear();
  const values = [
    row(at(thisYear, 9, 20), 'UNO', 'double_elimination', 'Dad', 'Mum',
        ['Dad', 'Mum', 'Atlas'], ['Dad', 'Mum', 'Atlas']),
    row(at(thisYear, 9, 13), 'UNO', 'double_elimination', 'Dad', 'Atlas',
        ['Dad', 'Mum', 'Atlas'], ['Dad', 'Atlas', 'Mum']),
    row(at(thisYear, 9, 6), 'UNO', 'round_robin', 'Mum', 'Dad',
        ['Dad', 'Mum', 'Atlas'], ['Mum', 'Dad', 'Atlas']),
    row(at(thisYear, 8, 30), 'Mario Kart', 'free_for_all', 'Atlas', 'Dad',
        ['Atlas', 'Dad', 'Mum', 'Miles'], ['Atlas', 'Dad', 'Mum', 'Miles']),
    // A one-off: no belt, no win, but still listed and tagged.
    row(at(thisYear, 8, 1), 'Table tennis', 'king_of_the_hill', 'Guest', 'Mum',
        ['Guest', 'Mum'], null, { temp: true, top_wins: 2 }),
    row(at(thisYear - 1, 9, 21), 'UNO', 'double_elimination', 'Miles', 'Dad',
        ['Miles', 'Dad', 'Mum', 'Atlas'], null),
  ];
  const influx = { results: [{ series: [{ name: 'result', columns: cols, values }] }] };

  const queries = [];
  const h = document.createElement('bracket-history-card');
  h.setConfig({ title: 'Hall of Fame' });
  h.hass = { states: {}, callWS: async (msg) => { queries.push(msg); return { response: { status: 200, content: influx } }; } };
  await tick(); await tick();
  const txt = () => h.shadowRoot.textContent.replace(/\s+/g, ' ');
  const click = (sel) => { const el = h.shadowRoot.querySelector(sel); ok(!!el, `found ${sel}`); el.onclick(); };

  ok(queries.length === 1 && queries[0].service === 'game_night_query'
     && /"placings"/.test(queries[0].service_data.q)
     && /ORDER BY time DESC LIMIT 100$/.test(queries[0].service_data.q),
     'history asks for the finishing order too');

  // --- champions: belts, season, leaderboard ---
  ok(/Title holders/.test(txt()), 'the champions view leads with the belts');
  const beltCards = [...h.shadowRoot.querySelectorAll('.belt')];
  ok(beltCards.length === 2, `one belt per game, a one-off game holds none (${beltCards.length})`);
  const uno = beltCards.find((b) => /UNO/.test(b.textContent));
  ok(/👑 Dad/.test(uno.textContent), `UNO is held by its latest winner (${uno.textContent.trim().slice(0, 40)})`);
  ok(/1 defence/.test(uno.textContent), 'and shows the defence count');
  ok(/took it from Mum/.test(uno.textContent), 'and who it was taken from');

  ok(new RegExp(`${thisYear} leader`).test(txt()), 'this season has a leader');
  ok(/Dad/.test(h.shadowRoot.querySelector('.champ').textContent), 'and it is the points leader');

  const headerCells = [...h.shadowRoot.querySelectorAll('tr.th td')].map((td) => td.textContent.trim());
  ok(headerCells.includes('Rate') && headerCells.includes('Pts') && headerCells.includes('Rating'),
     `the leaderboard shows rate, points and rating (${headerCells})`);
  const boardRows = [...h.shadowRoot.querySelectorAll('table tr')]
    .filter((tr) => !tr.classList.contains('th'))
    .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
  const dadRow = boardRows.find((r) => r[1].startsWith('Dad'));
  ok(dadRow && dadRow[2] === '2', `wins counted (${dadRow})`);
  ok(dadRow[5] === '40%', `win rate is wins over appearances (${dadRow[5]})`);
  ok(/🔥2/.test(dadRow[1]), `a run of wins is badged (${dadRow[1]})`);
  ok(h.shadowRoot.querySelectorAll('.dot').length > 0, 'form is drawn as dots');

  // Sorting the board is a click.
  click('[data-sort="rating"]');
  const firstAfter = h.shadowRoot.querySelectorAll('table tr')[1].children[1].textContent.trim();
  ok(firstAfter.length > 0, `sorting by rating re-orders the board (top: ${firstAfter})`);
  click('[data-sort="wins"]');

  // --- league ---
  click('[data-view="league"]');
  ok(new RegExp(`${thisYear} —`).test(txt()) && new RegExp(`${thisYear - 1} —`).test(txt()),
     'the league view lists every season');
  ok(/By format/.test(txt()) && /Double elimination/.test(txt()), 'and breaks results down by format');
  ok(/Biggest fields/.test(txt()) && /beat 3 others/.test(txt()), 'and names the biggest win');

  // --- head to head ---
  click('[data-view="h2h"]');
  ok(/Finals won against/.test(txt()), 'the head-to-head grid is shown');
  const matrix = h.shadowRoot.querySelector('table.matrix');
  ok(!!matrix && matrix.querySelectorAll('tr').length >= 4, 'the matrix has a row per finalist');
  ok(/Rivalries/.test(txt()) && /leads|all square/.test(txt()), 'rivalries are listed with who leads');

  // --- history list ---
  click('[data-view="history"]');
  ok(/one-off/.test(txt()), 'the results list tags a one-off game');
  ok(/Guest/.test(txt()), 'and still lists it');
  const listRows = h.shadowRoot.querySelectorAll('table tr').length;
  ok(listRows === values.length, `every result is listed (${listRows} of ${values.length})`);

  // --- a player page ---
  click('[data-view="champions"]');
  click('[data-player="Dad"]');
  ok(/Dad/.test(h.shadowRoot.querySelector('.title').textContent), 'the player page names the player');
  const stats = [...h.shadowRoot.querySelectorAll('.stat')].map((s) => s.textContent.replace(/\s+/g, ' '));
  ok(stats.some((s) => /2Wins/.test(s)), `wins shown (${stats[0]})`);
  ok(stats.some((s) => /Rating/.test(s)) && stats.some((s) => /Points/.test(s)), 'points and rating shown');
  ok(/By game/.test(txt()) && /By format/.test(txt()), 'broken down by game and format');
  ok(/Recent results/.test(txt()), 'with recent results');
  ok(/Beaten most often by|Beats/.test(txt()), 'and who they beat or lose to');
  click('#back');
  ok(/Title holders/.test(txt()), 'back returns to the champions view');

  // --- filtering by game ---
  const sel = h.shadowRoot.querySelector('#filter');
  ok(!!sel, 'game filter shown when more than one game');
  sel.value = 'Mario Kart'; sel.onchange({ target: sel });
  ok(h.shadowRoot.querySelectorAll('.belt').length === 1, 'filtering narrows to one game');
  ok(/Atlas/.test(h.shadowRoot.querySelector('.belt').textContent), 'and shows that game\'s holder');
  sel.value = ''; sel.onchange({ target: sel });

  // --- no data, and a failed load ---
  const hEmpty = document.createElement('bracket-history-card');
  hEmpty.setConfig({});
  hEmpty.hass = { states: {}, callWS: async () => ({ response: { status: 200, content: { results: [{}] } } }) };
  await tick(); await tick();
  ok(/No results recorded yet/.test(hEmpty.shadowRoot.textContent), 'an empty history says so');

  const hErr = document.createElement('bracket-history-card');
  hErr.setConfig({});
  hErr.hass = { states: {}, callWS: async () => { throw new Error('Service rest_command.game_night_query not found'); } };
  await tick(); await tick();
  ok(/Couldn't load results: Service rest_command.game_night_query not found/.test(hErr.shadowRoot.textContent), 'history shows load error');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
