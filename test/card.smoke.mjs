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

// Simulate typing players and creating.
el._draft = 'Alice\nBob\nCharlie\nDana\nEve';
el.shadowRoot.querySelector('#create').click();
ok(calls.length === 1 && calls[0].service === 'set_value', 'create wrote to helper');
ok(saved.length > 0 && saved.length <= 255, `payload persisted and <=255 chars (len=${saved.length})`);
const parsed = JSON.parse(saved);
ok(parsed.p.length === 5, 'stored 5 players');

// Feed the saved value back as new hass state -> bracket view.
el.hass = makeHass(saved);
ok(!el.shadowRoot.querySelector('#draft'), 'setup gone after creation');
ok(el.shadowRoot.querySelectorAll('.section').length >= 2, 'winners + losers sections rendered');
ok(!!el.shadowRoot.querySelector('#new'), 'New bracket button shown');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
