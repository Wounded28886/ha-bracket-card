/*
 * The Home Assistant shim.
 *
 * The cards only ever ask `hass` for three things: the state of a text
 * entity, a service call to write it back, and a service call with a
 * response (the InfluxDB rest_commands). Provide those three against this
 * server's API and the cards run unmodified — the same file HACS installs.
 */
const ENTITY = 'input_text.bracket';
const WRITE = 'game_night_write';
const QUERY = 'game_night_query';

const qs = new URLSearchParams(location.search);
let config = { title: 'Game Night', board: 'default', poll_ms: 25000 };
let value = '';
let rev = -1;
let cards = [];

const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok && !body.results) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
});

const boardParam = () => `board=${encodeURIComponent(config.board)}`;

// A fresh object each time: the cards compare the entity's state against
// what they last saw, so re-assigning is how they learn about a change.
function hass() {
  return {
    states: { [ENTITY]: { state: value, attributes: {}, entity_id: ENTITY } },
    // Fire-and-forget, like Home Assistant's own callService. The card
    // renders optimistically and the poll confirms it.
    callService(domain, service, data) {
      if (service !== 'set_value') return;
      value = data.value;
      // Home Assistant hands the new state to every card; do the same, so the
      // history card notices a result the bracket card just recorded.
      apply();
      push(data.value);
    },
    // rest_command with return_response — the InfluxDB write/query pair.
    async callWS(msg) {
      const service = msg && msg.service;
      const data = (msg && msg.service_data) || {};
      if (service === WRITE) {
        await api('/api/write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ line: data.line }),
        });
        return { response: { status: 204, content: '' } };
      }
      if (service === QUERY) {
        const body = await api('/api/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: data.q }),
        });
        return { response: { status: 200, content: body } };
      }
      throw new Error(`unknown service ${service}`);
    },
  };
}

function apply() {
  const h = hass();
  for (const card of cards) card.hass = h;
}

let pushing = null;
let queued = null;
// One write in flight at a time; the newest value wins if taps come faster
// than the round trip.
function push(v) {
  if (pushing) { queued = v; return; }
  pushing = api('/api/state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board: config.board, value: v }),
  }).then((r) => { rev = r.rev; }).catch((e) => {
    status(`Couldn't save: ${e.message}`);
  }).finally(() => {
    pushing = null;
    if (queued != null) { const next = queued; queued = null; push(next); }
  });
}

// Long poll: the server holds the request until another device changes the
// board (or it times out), so every screen follows along without websockets.
async function sync() {
  for (;;) {
    try {
      const r = await api(`/api/state?${boardParam()}&rev=${rev}`);
      if (r.rev !== rev) {
        rev = r.rev;
        if (r.value !== value) { value = r.value; apply(); }
      }
      status('');
    } catch (e) {
      status(`Offline — retrying… (${e.message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function status(text) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

async function main() {
  const board = qs.get('board');
  config = await api(`/api/config${board ? `?board=${encodeURIComponent(board)}` : ''}`);
  if (qs.get('title')) config.title = qs.get('title');
  document.title = `${config.title} — Bracket`;

  const first = await api(`/api/state?${boardParam()}`);
  value = first.value;
  rev = first.rev;

  const bracket = document.createElement('bracket-card');
  bracket.setConfig({ entity: ENTITY, title: config.title, tracking: true });
  const history = document.createElement('bracket-history-card');
  history.setConfig({ title: 'Hall of Fame', entity: ENTITY, tracking: true });
  cards = [bracket, history];

  const root = document.getElementById('cards');
  root.append(bracket, history);
  apply();
  sync();
}

main().catch((e) => {
  status(`Failed to start: ${e.message}`);
  console.error(e);
});
