/*
 * Standalone server: the storage engine (line protocol + the InfluxQL subset)
 * and the HTTP API the page talks to. Run with `node test/server.test.mjs`.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine, runQuery, applyPoint, seriesKey } from '../server/lib/influx.mjs';
import { Store } from '../server/lib/store.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('  ✗', m));
const section = (n) => console.log('\n== ' + n + ' ==');
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bracket-')); dirs.push(d); return d; };

// A real line, exactly as the card emits one.
const LINE = 'result,game=Mario\\ Kart,mode=king_of_the_hill winner="Dad",runner_up="Mum",'
  + 'players="Mum, Dad, Atlas",player_count=3i,standings="Dad=4, Mum=2",top_wins=4i,'
  + 'state="{\\"p\\":[\\"Mum\\"],\\"b\\":{\\"k\\":0}}",sessions=2i,games=10i,last_played=1790000000i 1789000000';

// ---- line protocol ----
section('line protocol');
{
  const p = parseLine(LINE);
  ok(p.measurement === 'result', 'measurement');
  ok(p.tags.game === 'Mario Kart' && p.tags.mode === 'king_of_the_hill', `tags unescaped (${JSON.stringify(p.tags)})`);
  ok(p.fields.winner === 'Dad' && p.fields.players === 'Mum, Dad, Atlas', 'string fields keep their commas');
  ok(p.fields.player_count === 3 && p.fields.top_wins === 4 && p.fields.games === 10, 'integer fields');
  ok(p.time === 1789000000, 'timestamp in seconds');
  ok(JSON.parse(p.fields.state).b.k === 0, 'embedded JSON survives escaping');

  const esc = parseLine('m,tag=a\\,b\\ c,k=v f="say \\"hi\\"",n=-2i,b=true 5');
  ok(esc.tags.tag === 'a,b c', `escaped comma and space in a tag (${esc.tags.tag})`);
  ok(esc.fields.f === 'say "hi"' && esc.fields.n === -2 && esc.fields.b === true, 'quotes, negatives and booleans');
  ok(parseLine('m f=1').time > 1700000000, 'missing timestamp defaults to now');
  ok(parseLine('') === null && parseLine('   ') === null && parseLine('# comment') === null,
     'blank and comment lines are skipped, not errors');
  for (const bad of ['nofields', 'm ', 'm f=1 notanumber', 'm badfield 5']) {
    let threw = false;
    try { parseLine(bad); } catch (e) { threw = true; }
    ok(threw, `rejects "${bad}"`);
  }
}

// ---- point identity / merging ----
section('point identity');
{
  const points = [];
  applyPoint(points, parseLine('result,game=UNO a="1",b="keep" 100'));
  applyPoint(points, parseLine('result,game=UNO a="2" 100'));
  ok(points.length === 1, 'same series + timestamp is one point');
  ok(points[0].fields.a === '2' && points[0].fields.b === 'keep', 'fields merge, like InfluxDB');
  applyPoint(points, parseLine('result,game=UNO a="3" 101'));
  applyPoint(points, parseLine('result,game=Darts a="4" 100'));
  ok(points.length === 3, 'different timestamp or tags is a new point');
  ok(seriesKey(points[0]) !== seriesKey(points[2]), 'tag values separate the series');
}

// ---- query subset ----
section('influxql subset');
{
  const points = [];
  for (const l of [
    'result,game=UNO,mode=king_of_the_hill winner="Dad",temp=false,games=4i 300',
    'result,game=UNO,mode=king_of_the_hill winner="Guest",temp=true 400',
    'result,game=Darts,mode=round_robin winner="Mum" 200',
  ]) applyPoint(points, parseLine(l));

  const q = (s) => runQuery(points, s, () => {});
  const rows = (r) => {
    const s = r.results[0].series;
    return s ? s[0].values.map((v) => Object.fromEntries(s[0].columns.map((c, i) => [c, v[i]]))) : [];
  };

  // The two queries the cards actually send.
  const hist = q('SELECT "winner", "temp", "game", "mode" FROM "result" ORDER BY time DESC LIMIT 100');
  ok(rows(hist).length === 3 && rows(hist)[0].time === 400, 'ORDER BY time DESC');
  ok(rows(hist)[0].winner === 'Guest' && rows(hist)[0].temp === true, 'selected columns come back');
  ok(hist.results[0].series[0].columns[0] === 'time', 'time is always the first column');

  const koth = q(`SELECT "state", "winner", "temp", "game" FROM "result" WHERE "mode" = 'king_of_the_hill' ORDER BY time DESC LIMIT 100`);
  ok(rows(koth).length === 2, 'WHERE on a tag');
  ok(rows(koth).every((r) => r.game === 'UNO'), 'only matching rows');

  ok(rows(q('SELECT "winner" FROM "result" LIMIT 1')).length === 1, 'LIMIT');
  ok(rows(q('SELECT "winner" FROM "result" ORDER BY time ASC'))[0].time === 200, 'ORDER BY time ASC');
  ok(rows(q(`SELECT * FROM "result" WHERE "game" = 'Darts'`))[0].mode === 'round_robin', 'SELECT * includes tags');
  ok(rows(q(`SELECT "winner" FROM "result" WHERE "temp" != true`)).length === 2, 'WHERE != on a field');
  ok(rows(q('SELECT "winner" FROM "result" WHERE time > 250')).length === 2, 'WHERE on time');
  ok(rows(q(`SELECT "winner" FROM "result" WHERE "game" = 'UNO' AND "temp" = true`)).length === 1, 'AND');
  ok(rows(q(`SELECT "winner" FROM "result" WHERE "game" = 'Nothing'`)).length === 0, 'no matches -> no series');
  ok(!q(`SELECT "winner" FROM "result" WHERE "game" = 'Nothing'`).results[0].error, 'no matches is not an error');
  ok(q('SHOW MEASUREMENTS').results[0].series[0].values[0][0] === 'result', 'SHOW MEASUREMENTS');

  // Errors come back the way InfluxDB reports them, so the card can show them.
  for (const bad of ['DROP DATABASE x', 'SELECT winner', `SELECT * FROM "result" WHERE "a" = 'b' OR "c" = 'd'`]) {
    ok(!!q(bad).results[0].error, `rejects ${bad}`);
  }

  // DELETE, the documented way to clear history.
  const before = points.length;
  ok(!q(`DELETE FROM "result" WHERE "game" = 'Darts'`).results[0].error, 'DELETE runs');
  ok(points.length === before - 1, 'DELETE with WHERE removes the matching point');
  q('DELETE FROM "result"');
  ok(points.length === 0, 'DELETE without WHERE empties the measurement');
}

// ---- store: boards, persistence, long poll ----
section('store');
{
  const dir = tmp();
  const s = new Store(dir, { flushMs: 5 });
  ok(s.board('default').value === '' && s.board('default').rev === 0, 'unknown board starts empty');
  const a = s.setBoard('default', '{"v":2}');
  ok(a.rev === 1, 'rev increments');
  ok(s.setBoard('default', '{"v":2}').rev === 1, 'writing the same value is a no-op');
  s.setBoard('kitchen', 'other');
  ok(s.board('default').value === '{"v":2}' && s.board('kitchen').value === 'other', 'boards are independent');

  s.write(LINE);
  s.flush();
  const reloaded = new Store(dir);
  ok(reloaded.board('default').value === '{"v":2}', 'boards survive a restart');
  ok(reloaded.query('SELECT "winner" FROM "result"').results[0].series[0].values[0][1] === 'Dad', 'points survive a restart');

  // A corrupt file must not take the night down.
  writeFileSync(join(dir, 'store.json'), '{ not json');
  const recovered = new Store(dir);
  ok(recovered.board('default').value === '' && recovered.stats().points === 0, 'corrupt file starts clean');
  const kept = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  ok(kept.length === 1 && readFileSync(join(dir, kept[0]), 'utf8') === '{ not json',
     'the unreadable file is kept aside rather than overwritten');

  // Long poll resolves on change and on timeout.
  const s2 = new Store(tmp(), { flushMs: 5 });
  const waited = s2.watch('default', 0, 2000);
  setTimeout(() => s2.setBoard('default', 'changed'), 10);
  const got = await waited;
  ok(got.value === 'changed' && got.rev === 1, 'watch wakes when the board changes');
  const timedOut = await s2.watch('default', 1, 30);
  ok(timedOut.rev === 1, 'watch returns the current value on timeout');
  ok((await s2.watch('default', 999, 2000)).rev === 1, 'a stale rev returns immediately');
}

// ---- HTTP API ----
section('http api');
{
  process.env.DATA_DIR = tmp();
  process.env.PORT = '0';
  process.env.TITLE = 'Test Night';
  process.env.POLL_MS = '300';
  const { server, store } = await import('../server/server.mjs');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const send = (p, body, method = 'POST') => fetch(base + p, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  ok((await get('/healthz')).body.ok === true, 'healthz');
  ok((await get('/api/config')).body.title === 'Test Night', 'config carries the configured title');

  const empty = await get('/api/state');
  ok(empty.body.value === '' && empty.body.rev === 0, 'state starts empty');
  ok((await send('/api/state', { value: '{"v":2,"p":["A","B"]}' }, 'PUT')).body.rev === 1, 'PUT state');
  ok((await get('/api/state')).body.value === '{"v":2,"p":["A","B"]}', 'GET state returns it');
  ok((await send('/api/state', { value: 42 }, 'PUT')).status === 400, 'PUT rejects a non-string');

  // Long poll: pending until another device writes.
  const pending = get('/api/state?rev=1');
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 60));
  ok(!settled, 'sync request waits while nothing changes');
  await send('/api/state', { value: 'moved' }, 'PUT');
  const woke = await pending;
  ok(woke.body.value === 'moved' && woke.body.rev === 2, 'sync request wakes on a change');
  const timeout = await get('/api/state?rev=2');
  ok(timeout.body.rev === 2, 'sync request returns on timeout');

  // Separate boards don't disturb each other.
  await send('/api/state?board=kitchen', { value: 'k' }, 'PUT');
  ok((await get('/api/state?board=kitchen')).body.value === 'k', 'board parameter');
  ok((await get('/api/state')).body.value === 'moved', 'default board untouched');

  ok((await send('/api/write', { line: LINE })).body.written === 1, 'write accepts a line');
  const q = await send('/api/query', { q: 'SELECT "winner", "game" FROM "result" ORDER BY time DESC LIMIT 5' });
  ok(q.body.results[0].series[0].values[0][1] === 'Dad', 'query returns the point');
  ok((await get(`/api/query?q=${encodeURIComponent('SHOW MEASUREMENTS')}`)).status === 200, 'query over GET');
  ok((await send('/api/query', { q: 'DROP DATABASE x' })).status === 400, 'a bad query is a 400');
  ok((await send('/api/write', { line: 'rubbish' })).status === 400, 'a bad line is a 400');

  // Static files, including the card bundle from dist/.
  const page = await fetch(base + '/');
  const html = await page.text();
  ok(page.status === 200 && html.includes('./board.js') && html.includes('./app.js'), 'serves the page');
  ok(!/home\s*assistant|hacs|input_text/i.test(html), 'the page carries no Home Assistant branding');
  const bundle = await fetch(base + '/board.js');
  ok(bundle.status === 200 && (await bundle.text()).includes("customElements.define('bracket-card'"), 'serves the board bundle under its own name');
  ok((await fetch(base + '/ha-bracket-card.js')).status === 404, 'nothing is served under the Home Assistant name');
  ok((await fetch(base + '/api/nope')).status === 404, '404 for unknown paths');
  const escape = await fetch(base + '/../package.json');
  ok(escape.status === 404 || escape.status === 400, 'no climbing out of the static root');

  store.flush();
  await new Promise((r) => server.close(r));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
