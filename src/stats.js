/*
 * ha-bracket-card — what the recorded results add up to.
 *
 * Pure functions over the rows the history card reads back: no DOM, no
 * network, no dates beyond the ones in the data. Everything here works on
 * results recorded by any version — rows written before full finishing
 * orders existed fall back to "winner first, runner-up second, everyone
 * else level" — so the whole history counts, not just what came after.
 *
 * A row looks like:
 *   { time, game, mode, winner, runner_up, players, player_count,
 *     placings?, standings?, top_wins?, temp? }
 *
 * Unit-tested in test/stats.test.mjs.
 */

const SEP = /\s*,\s*/;

export const splitNames = (value) =>
  String(value || '').split(SEP).map((n) => n.trim()).filter(Boolean);

/* A one-off king-of-the-hill game doesn't hold a title or count as a win. */
export const isReal = (row) => row && row.temp !== true && !!row.winner;

export const realRows = (rows) => (rows || []).filter(isReal);

/* Newest first, which is how the card wants nearly everything. */
export const byNewest = (rows) => [...rows].sort((a, b) => b.time - a.time);

export function rowDate(row) {
  const d = new Date((row.time || 0) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const seasonOf = (row) => {
  const d = rowDate(row);
  return d ? d.getFullYear() : null;
};

/*
 * Who finished where, as [{name, rank}] with ties sharing a rank.
 *
 * Uses the recorded finishing order when there is one. Older rows only know
 * the top two, so everyone else is ranked joint third — enough for points
 * and ratings to treat them fairly without inventing an order.
 */
export function ranked(row) {
  const players = splitNames(row.players);
  const placings = splitNames(row.placings);
  if (placings.length) {
    const known = placings.map((name, i) => ({ name, rank: i + 1 }));
    // Anyone missing from the order (shouldn't happen) trails the field.
    for (const name of players) {
      if (!known.some((k) => k.name === name)) known.push({ name, rank: known.length + 1 });
    }
    return known;
  }
  const out = [];
  if (row.winner) out.push({ name: row.winner, rank: 1 });
  if (row.runner_up) out.push({ name: row.runner_up, rank: 2 });
  const rest = players.filter((n) => n !== row.winner && n !== row.runner_up);
  for (const name of rest) out.push({ name, rank: 3 });
  return out;
}

export const participants = (row) => {
  const players = splitNames(row.players);
  if (players.length) return players;
  return ranked(row).map((r) => r.name);
};

/* ---------------------------------------------------------------- belts */
/*
 * One title per game, held by whoever won it last. Losing it needs someone
 * else to win that game — which is what makes it worth defending.
 */
export function belts(rows) {
  const byGame = new Map();
  for (const row of byNewest(realRows(rows))) {
    const game = row.game || 'Untitled';
    let belt = byGame.get(game);
    if (!belt) {
      belt = {
        game,
        holder: row.winner,
        since: row.time,
        wonAt: row.time,
        defences: 0,
        mode: row.mode,
        lastPlayed: row.last_played || row.time,
        previous: null,
      };
      byGame.set(game, belt);
      continue;
    }
    // Rows arrive newest first: keep counting back while the same person
    // keeps winning, and stop at the game they took it in.
    if (belt.previous === null) {
      if (row.winner === belt.holder) {
        belt.defences += 1;
        belt.since = row.time;
      } else {
        belt.previous = row.winner;
      }
    }
  }
  return [...byGame.values()].sort((a, b) => b.wonAt - a.wonAt);
}

/* --------------------------------------------------------------- points */
/*
 * A placing in a field of n is worth n - place + 1: winning six players is
 * six points, last is one. Beating more people is worth more, which is the
 * whole reason to record the field size.
 */
export function pointsFor(rank, fieldSize) {
  return Math.max(1, fieldSize - rank + 1);
}

/* ------------------------------------------------------------------ elo */
/*
 * One tournament is every pair of its players compared at once: finishing
 * above someone counts as a win against them, level counts as a draw. Each
 * pair moves the rating by at most K/(n-1), so a big field doesn't swing
 * ratings more than a small one — it just settles them faster.
 */
export const ELO_START = 1000;
const ELO_K = 32;

export function elo(rows, { start = ELO_START, k = ELO_K } = {}) {
  const ratings = new Map();
  const get = (name) => (ratings.has(name) ? ratings.get(name) : start);
  const history = [];

  for (const row of [...realRows(rows)].sort((a, b) => a.time - b.time)) {
    const places = ranked(row);
    if (places.length < 2) continue;
    const before = new Map(places.map((p) => [p.name, get(p.name)]));
    const delta = new Map(places.map((p) => [p.name, 0]));
    const perPair = k / (places.length - 1);

    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        const a = places[i], b = places[j];
        if (a.name === b.name) continue;
        const ra = before.get(a.name), rb = before.get(b.name);
        const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
        const score = a.rank === b.rank ? 0.5 : a.rank < b.rank ? 1 : 0;
        delta.set(a.name, delta.get(a.name) + perPair * (score - expected));
        delta.set(b.name, delta.get(b.name) + perPair * ((1 - score) - (1 - expected)));
      }
    }
    for (const [name, d] of delta) ratings.set(name, get(name) + d);
    history.push({
      time: row.time,
      game: row.game,
      ratings: Object.fromEntries([...ratings].map(([n, r]) => [n, Math.round(r)])),
    });
  }
  return {
    ratings: Object.fromEntries([...ratings].map(([n, r]) => [n, Math.round(r)])),
    history,
  };
}

/* ---------------------------------------------------------- leaderboard */
/*
 * Everything known about each player, from every angle the card shows:
 * wins and how often they turned up, points, rating, form, streaks, the
 * games they're best and worst at, and who they beat most.
 */
export function leaderboard(rows, opts = {}) {
  const live = realRows(rows);
  const scoped = opts.season ? live.filter((r) => seasonOf(r) === opts.season) : live;
  const ordered = [...scoped].sort((a, b) => a.time - b.time);
  const ratings = elo(live).ratings;   // rating is a career thing, not per season

  const table = new Map();
  const player = (name) => {
    if (!table.has(name)) {
      table.set(name, {
        name, wins: 0, runnerUps: 0, appearances: 0, points: 0,
        firstPlayed: null, lastPlayed: null, lastWin: null,
        bestField: 0, byGame: new Map(), byMode: new Map(),
        beat: new Map(), lostTo: new Map(), results: [],
      });
    }
    return table.get(name);
  };

  for (const row of ordered) {
    const places = ranked(row);
    const field = Math.max(places.length, Number(row.player_count) || 0);
    for (const { name, rank } of places) {
      const p = player(name);
      p.appearances += 1;
      p.points += pointsFor(rank, field);
      p.firstPlayed = p.firstPlayed === null ? row.time : Math.min(p.firstPlayed, row.time);
      p.lastPlayed = p.lastPlayed === null ? row.time : Math.max(p.lastPlayed, row.time);
      p.results.push({ time: row.time, game: row.game, mode: row.mode, rank, won: rank === 1, field });

      const game = row.game || 'Untitled';
      const g = p.byGame.get(game) || { game, wins: 0, played: 0 };
      g.played += 1;
      const mode = row.mode || 'unknown';
      const m = p.byMode.get(mode) || { mode, wins: 0, played: 0 };
      m.played += 1;

      if (rank === 1) {
        p.wins += 1;
        p.lastWin = row.time;
        p.bestField = Math.max(p.bestField, field);
        g.wins += 1;
        m.wins += 1;
        if (row.runner_up) p.beat.set(row.runner_up, (p.beat.get(row.runner_up) || 0) + 1);
      }
      if (rank === 2 && row.winner) {
        p.runnerUps += 1;
        p.lostTo.set(row.winner, (p.lostTo.get(row.winner) || 0) + 1);
      }
      p.byGame.set(game, g);
      p.byMode.set(mode, m);
    }
  }

  const best = (map, key) => {
    const rows2 = [...map.values()].filter((x) => x.played > 0);
    if (!rows2.length) return null;
    return rows2.map((x) => ({ ...x, rate: x.wins / x.played }))
      .sort((a, b) => b.rate - a.rate || b.played - a.played || String(a[key]).localeCompare(String(b[key])))[0];
  };
  const worst = (map, key) => {
    const rows2 = [...map.values()].filter((x) => x.played > 1);
    if (!rows2.length) return null;
    return rows2.map((x) => ({ ...x, rate: x.wins / x.played }))
      .sort((a, b) => a.rate - b.rate || b.played - a.played || String(a[key]).localeCompare(String(b[key])))[0];
  };
  const topOf = (map) => {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.length ? { name: entries[0][0], count: entries[0][1] } : null;
  };

  const out = [...table.values()].map((p) => {
    const results = p.results.sort((a, b) => a.time - b.time);
    return {
      ...p,
      winRate: p.appearances ? p.wins / p.appearances : 0,
      rating: ratings[p.name] ?? ELO_START,
      form: results.slice(-5).map((r) => r.won),
      streak: currentStreak(results),
      longestStreak: longestStreak(results),
      bestGame: best(p.byGame, 'game'),
      worstGame: worst(p.byGame, 'game'),
      byGame: [...p.byGame.values()].sort((a, b) => b.wins - a.wins || b.played - a.played),
      byMode: [...p.byMode.values()].sort((a, b) => b.wins - a.wins || b.played - a.played),
      nemesis: topOf(p.lostTo),
      favouriteVictim: topOf(p.beat),
    };
  });

  const sorters = {
    wins: (a, b) => b.wins - a.wins || b.winRate - a.winRate || a.name.localeCompare(b.name),
    rate: (a, b) => b.winRate - a.winRate || b.wins - a.wins || a.name.localeCompare(b.name),
    points: (a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name),
    rating: (a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name),
  };
  return out.sort(sorters[opts.sort] || sorters.wins);
}

function currentStreak(results) {
  let wins = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (!results[i].won) break;
    wins += 1;
  }
  if (wins) return { kind: 'wins', count: wins };
  let since = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].won) break;
    since += 1;
  }
  return { kind: 'drought', count: since };
}

function longestStreak(results) {
  let best = 0, run = 0;
  for (const r of results) {
    run = r.won ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/* -------------------------------------------------------------- seasons */
export function seasons(rows) {
  const live = realRows(rows);
  const years = [...new Set(live.map(seasonOf).filter((y) => y !== null))].sort((a, b) => b - a);
  return years.map((year) => {
    const table = leaderboard(live, { season: year, sort: 'points' });
    const events = live.filter((r) => seasonOf(r) === year);
    return {
      year,
      events: events.length,
      table,
      champion: table[0] || null,
      games: [...new Set(events.map((r) => r.game || 'Untitled'))].sort(),
    };
  });
}

/* --------------------------------------------------------- head to head */
/*
 * Who has beaten whom in a final. Only the top two of an event are a real
 * meeting — everyone else may never have played each other.
 */
export function headToHead(rows) {
  const names = new Set();
  const pairs = new Map();
  const key = (a, b) => `${a}\u0000${b}`;

  for (const row of realRows(rows)) {
    if (!row.winner || !row.runner_up) continue;
    names.add(row.winner);
    names.add(row.runner_up);
    pairs.set(key(row.winner, row.runner_up), (pairs.get(key(row.winner, row.runner_up)) || 0) + 1);
  }
  const list = [...names].sort((a, b) => a.localeCompare(b));
  return {
    players: list,
    wins: (a, b) => pairs.get(key(a, b)) || 0,
    meetings: (a, b) => (pairs.get(key(a, b)) || 0) + (pairs.get(key(b, a)) || 0),
  };
}

export function rivalries(rows, { min = 2 } = {}) {
  const h2h = headToHead(rows);
  const out = [];
  for (let i = 0; i < h2h.players.length; i++) {
    for (let j = i + 1; j < h2h.players.length; j++) {
      const a = h2h.players[i], b = h2h.players[j];
      const meetings = h2h.meetings(a, b);
      if (meetings < min) continue;
      const aWins = h2h.wins(a, b), bWins = h2h.wins(b, a);
      const leader = aWins === bWins ? null : aWins > bWins ? a : b;
      out.push({ a, b, meetings, aWins, bWins, leader });
    }
  }
  return out.sort((x, y) => y.meetings - x.meetings
    || Math.abs(x.aWins - x.bWins) - Math.abs(y.aWins - y.bWins)
    || x.a.localeCompare(y.a));
}

/* ---------------------------------------------------------- on this day */
/*
 * The same date in an earlier year. Anything from the last few days counts
 * as "this week" so a board isn't blank for 364 days of the year.
 */
export function onThisDay(rows, now = new Date(), { window = 3 } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (const row of realRows(rows)) {
    const d = rowDate(row);
    if (!d || d.getFullYear() >= today.getFullYear()) continue;
    const anniversary = new Date(today.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((anniversary - today) / 86400000);
    if (Math.abs(days) > window) continue;
    out.push({ ...row, yearsAgo: today.getFullYear() - d.getFullYear(), daysOff: days });
  }
  return out.sort((a, b) => Math.abs(a.daysOff) - Math.abs(b.daysOff) || a.yearsAgo - b.yearsAgo);
}

/* -------------------------------------------------------------- formats */
export function byFormat(rows) {
  const modes = new Map();
  for (const row of realRows(rows)) {
    const mode = row.mode || 'unknown';
    const m = modes.get(mode) || { mode, events: 0, winners: new Map() };
    m.events += 1;
    m.winners.set(row.winner, (m.winners.get(row.winner) || 0) + 1);
    modes.set(mode, m);
  }
  return [...modes.values()]
    .map((m) => ({
      mode: m.mode,
      events: m.events,
      winners: [...m.winners.entries()]
        .map(([name, wins]) => ({ name, wins }))
        .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.events - a.events || a.mode.localeCompare(b.mode));
}

/* ------------------------------------------------------------ overviews */
export function biggestWins(rows, { limit = 5 } = {}) {
  return realRows(rows)
    .map((r) => ({ ...r, field: Math.max(Number(r.player_count) || 0, participants(r).length) }))
    .sort((a, b) => b.field - a.field || b.time - a.time)
    .slice(0, limit);
}
