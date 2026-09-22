/*
 * A very small subset of InfluxDB 1.x, enough for the bracket card.
 *
 * The card talks to Home Assistant's InfluxDB through two rest_commands: one
 * writes a line-protocol point, the other runs an InfluxQL SELECT. The
 * standalone server speaks that same pair so the card itself needs no changes
 * between the two deployments — this module is the storage behind it.
 *
 * Supported:
 *   write  measurement,tag=v,tag2=v2 field="s",n=1i,b=true <epoch seconds>
 *   query  SELECT <cols|*> FROM "m" [WHERE <cond> [AND <cond>]]
 *                                   [ORDER BY time ASC|DESC] [LIMIT n]
 *          DELETE FROM "m" [WHERE <cond> [AND <cond>]]
 *          SHOW MEASUREMENTS
 *   cond   "key" = 'value' | "key" != 'value' | "key" = 123 | "key" = true
 *          time > 1790000000 (and >=, <, <=)
 *
 * Points are keyed by measurement + tag set + timestamp, and a write to an
 * existing key merges its fields — the same rule real InfluxDB follows, and
 * what lets the card re-record a corrected result over the original point.
 */

/* ---------- line protocol ---------- */

/*
 * Split on separators that aren't backslash-escaped. With `quoted`, a
 * separator inside a double-quoted string is ignored too — a string field
 * may hold unescaped spaces and commas (players="Mum, Dad, Atlas") and has
 * to survive in one piece.
 *
 * Escapes are carried through untouched: a line splits key / fields /
 * timestamp, then the key splits into tags, so unescaping before the last
 * split would turn an escaped comma into a separator.
 */
function splitUnescaped(str, sep, quoted = false) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) { cur += c + str[i + 1]; i++; continue; }
    if (quoted && c === '"') { inStr = !inStr; cur += c; continue; }
    if (c === sep && !inStr) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Undo line-protocol escaping — only ever at the leaves (see above).
const unescape = (s) => s.replace(/\\(.)/g, '$1');

// Fields can hold quoted strings containing commas, so they split separately.
function splitFields(str) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) { cur += c + str[i + 1]; i++; continue; }
    if (c === '"') { inStr = !inStr; cur += c; continue; }
    if (c === ',' && !inStr) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseFieldValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const body = v.slice(1, v.endsWith('"') ? -1 : undefined);
    return body.replace(/\\(.)/g, '$1');
  }
  if (v === 'true' || v === 'TRUE' || v === 't' || v === 'T') return true;
  if (v === 'false' || v === 'FALSE' || v === 'f' || v === 'F') return false;
  if (/^-?\d+i$/.test(v)) return parseInt(v.slice(0, -1), 10);
  if (/^-?\d+u$/.test(v)) return parseInt(v.slice(0, -1), 10);
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  return v;
}

/* Parse one line of line protocol. Returns {measurement, tags, fields, time}. */
export function parseLine(line, nowSeconds = Math.floor(Date.now() / 1000)) {
  const text = String(line).trim();
  if (!text || text.startsWith('#')) return null;

  // measurement+tags / fields / timestamp, split on unescaped spaces.
  const parts = splitUnescaped(text, ' ', true).filter((p, i, a) => !(p === '' && i === a.length - 1));
  if (parts.length < 2) throw new Error('unable to parse: missing fields');
  const keyPart = parts[0];
  const fieldPart = parts[1];
  const tsPart = parts.length > 2 ? parts[2] : '';

  const keyBits = splitUnescaped(keyPart, ',');
  const measurement = unescape(keyBits.shift() || '');
  if (!measurement) throw new Error('unable to parse: missing measurement');
  const tags = {};
  for (const bit of keyBits) {
    if (!bit) continue;
    const eq = splitUnescaped(bit, '=');
    if (eq.length < 2) throw new Error(`unable to parse tag "${bit}"`);
    tags[unescape(eq[0])] = unescape(eq.slice(1).join('='));
  }

  const fields = {};
  for (const bit of splitFields(fieldPart)) {
    if (!bit.trim()) continue;
    const eq = bit.indexOf('=');
    if (eq < 0) throw new Error(`unable to parse field "${bit}"`);
    const key = bit.slice(0, eq).replace(/\\(.)/g, '$1');
    fields[key] = parseFieldValue(bit.slice(eq + 1));
  }
  if (!Object.keys(fields).length) throw new Error('unable to parse: no fields');

  let time = nowSeconds;
  if (tsPart) {
    if (!/^-?\d+$/.test(tsPart)) throw new Error(`unable to parse timestamp "${tsPart}"`);
    time = parseInt(tsPart, 10);
  }
  return { measurement, tags, fields, time };
}

// Identity of a point: measurement + tag set + timestamp. JSON keeps it
// unambiguous whatever turns up in a tag value.
export const seriesKey = (p) => JSON.stringify([
  p.measurement,
  Object.keys(p.tags).sort().map((k) => [k, p.tags[k]]),
  p.time,
]);

/*
 * Apply a point to the list, merging fields when the same series+timestamp is
 * written again (InfluxDB's own behaviour). Returns true if anything changed.
 */
export function applyPoint(points, point) {
  const key = seriesKey(point);
  const existing = points.find((p) => seriesKey(p) === key);
  if (existing) {
    Object.assign(existing.fields, point.fields);
    return true;
  }
  points.push(point);
  return true;
}

/* ---------- InfluxQL (the subset above) ---------- */

function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return t;
}

function parseLiteral(raw) {
  const t = raw.trim();
  if (t.startsWith("'") || t.startsWith('"')) return stripQuotes(t);
  if (t === 'true' || t === 'TRUE') return true;
  if (t === 'false' || t === 'FALSE') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d+s$/.test(t)) return parseInt(t.slice(0, -1), 10);   // 1790000000s
  return t;
}

// "key" op literal, joined by AND. OR isn't supported (the card never uses it).
function parseWhere(clause) {
  if (!clause || !clause.trim()) return [];
  if (/\bOR\b/i.test(clause)) throw new Error('OR is not supported');
  return clause.split(/\bAND\b/i).map((part) => {
    const m = part.trim().match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)\s*(!=|>=|<=|=~|!~|=|>|<)\s*(.+)$/);
    if (!m) throw new Error(`unable to parse condition "${part.trim()}"`);
    const op = m[2];
    if (op === '=~' || op === '!~') throw new Error('regex conditions are not supported');
    return { key: stripQuotes(m[1]), op, value: parseLiteral(m[3]) };
  });
}

export function parseQuery(q) {
  const text = String(q || '').trim().replace(/;$/, '');
  if (/^SHOW\s+MEASUREMENTS$/i.test(text)) return { type: 'show-measurements' };

  const del = text.match(/^DELETE\s+FROM\s+("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)\s*(?:WHERE\s+(.+))?$/i);
  if (del) {
    return { type: 'delete', measurement: stripQuotes(del[1]), where: parseWhere(del[2]) };
  }

  const sel = text.match(/^SELECT\s+(.+?)\s+FROM\s+("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)((?:\s|\S)*)$/i);
  if (!sel) throw new Error('only SELECT, DELETE FROM and SHOW MEASUREMENTS are supported');
  const columns = sel[1].trim() === '*' ? '*'
    : sel[1].split(',').map((c) => stripQuotes(c)).filter(Boolean);
  const measurement = stripQuotes(sel[2]);

  let rest = sel[3] || '';
  let limit = 0;
  const lim = rest.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (lim) { limit = parseInt(lim[1], 10); rest = rest.slice(0, lim.index); }
  let desc = false;
  const ord = rest.match(/\bORDER\s+BY\s+time\s*(ASC|DESC)?\s*$/i);
  if (ord) { desc = (ord[1] || 'ASC').toUpperCase() === 'DESC'; rest = rest.slice(0, ord.index); }
  const wh = rest.match(/^\s*WHERE\s+([\s\S]+)$/i);
  const where = wh ? parseWhere(wh[1]) : [];
  if (!wh && rest.trim()) throw new Error(`unable to parse "${rest.trim()}"`);

  return { type: 'select', measurement, columns, where, desc, limit };
}

function valueOf(point, key) {
  if (key === 'time') return point.time;
  if (key in point.tags) return point.tags[key];
  if (key in point.fields) return point.fields[key];
  return null;
}

function matches(point, where) {
  return where.every(({ key, op, value }) => {
    const v = valueOf(point, key);
    switch (op) {
      case '=': return v === value || (v != null && String(v) === String(value));
      case '!=': return !(v === value || (v != null && String(v) === String(value)));
      case '>': return Number(v) > Number(value);
      case '>=': return Number(v) >= Number(value);
      case '<': return Number(v) < Number(value);
      case '<=': return Number(v) <= Number(value);
      default: return false;
    }
  });
}

/*
 * Run a query against `points`. Returns the same envelope InfluxDB's
 * /query endpoint produces, so the card's own parser handles it unchanged.
 * Mutates `points` for DELETE; `onChange` is called when it does.
 */
export function runQuery(points, q, onChange) {
  let parsed;
  try {
    parsed = parseQuery(q);
  } catch (e) {
    return { results: [{ statement_id: 0, error: e.message }] };
  }

  if (parsed.type === 'show-measurements') {
    const names = [...new Set(points.map((p) => p.measurement))].sort().map((n) => [n]);
    return {
      results: [names.length
        ? { statement_id: 0, series: [{ name: 'measurements', columns: ['name'], values: names }] }
        : { statement_id: 0 }],
    };
  }

  if (parsed.type === 'delete') {
    let removed = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      if (p.measurement !== parsed.measurement) continue;
      if (!matches(p, parsed.where)) continue;
      points.splice(i, 1);
      removed++;
    }
    if (removed && onChange) onChange();
    return { results: [{ statement_id: 0 }] };
  }

  const rows = points
    .filter((p) => p.measurement === parsed.measurement && matches(p, parsed.where))
    .sort((a, b) => (parsed.desc ? b.time - a.time : a.time - b.time));
  const limited = parsed.limit ? rows.slice(0, parsed.limit) : rows;
  if (!limited.length) return { results: [{ statement_id: 0 }] };

  let columns;
  if (parsed.columns === '*') {
    const keys = new Set();
    for (const p of limited) { Object.keys(p.tags).forEach((k) => keys.add(k)); Object.keys(p.fields).forEach((k) => keys.add(k)); }
    columns = [...keys].sort();
  } else {
    columns = parsed.columns.filter((c) => c !== 'time');
  }
  return {
    results: [{
      statement_id: 0,
      series: [{
        name: parsed.measurement,
        columns: ['time', ...columns],
        values: limited.map((p) => [p.time, ...columns.map((c) => valueOf(p, c))]),
      }],
    }],
  };
}
