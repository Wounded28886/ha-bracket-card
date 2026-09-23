import {
  ranked, belts, leaderboard, seasons, headToHead, rivalries, onThisDay,
  byFormat, elo, pointsFor, biggestWins, splitNames, ELO_START,
} from '../src/stats.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

const DAY = 86400;
const at = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);

// A history to reason about: three games, four players, two seasons.
const ROWS = [
  { time: at(2026, 9, 20), game: 'UNO', mode: 'double_elimination',
    winner: 'Dad', runner_up: 'Mum', players: 'Dad, Mum, Atlas, Miles',
    player_count: 4, placings: 'Dad, Mum, Atlas, Miles' },
  { time: at(2026, 9, 13), game: 'UNO', mode: 'double_elimination',
    winner: 'Dad', runner_up: 'Atlas', players: 'Dad, Mum, Atlas',
    player_count: 3, placings: 'Dad, Atlas, Mum' },
  { time: at(2026, 9, 6), game: 'UNO', mode: 'round_robin',
    winner: 'Mum', runner_up: 'Dad', players: 'Dad, Mum, Atlas',
    player_count: 3, placings: 'Mum, Dad, Atlas' },
  { time: at(2026, 8, 30), game: 'Mario Kart', mode: 'free_for_all',
    winner: 'Atlas', runner_up: 'Miles', players: 'Atlas, Miles, Dad, Mum',
    player_count: 4, placings: 'Atlas, Miles, Dad, Mum' },
  { time: at(2026, 7, 4), game: 'Table tennis', mode: 'king_of_the_hill',
    winner: 'Mum', runner_up: 'Dad', players: 'Mum, Dad, Atlas, Miles, Phoenix',
    player_count: 5, placings: 'Mum, Dad, Atlas, Miles, Phoenix', top_wins: 4 },
  // A one-off: no title, no win, ignored everywhere.
  { time: at(2026, 7, 10), game: 'Table tennis', mode: 'king_of_the_hill',
    winner: 'Phoenix', runner_up: 'Miles', players: 'Phoenix, Miles',
    player_count: 2, temp: true },
  // Last season, and an old row with no placings recorded.
  { time: at(2025, 9, 21), game: 'UNO', mode: 'double_elimination',
    winner: 'Miles', runner_up: 'Dad', players: 'Miles, Dad, Mum, Atlas',
    player_count: 4 },
];

// ---- parsing ----
section('reading a row');
{
  assert(splitNames('Dad, Mum,Atlas ').join('|') === 'Dad|Mum|Atlas', 'names split and trimmed');
  assert(splitNames('').length === 0 && splitNames(undefined).length === 0, 'empty is empty');

  const full = ranked(ROWS[0]);
  assert(full.map((r) => `${r.name}:${r.rank}`).join() === 'Dad:1,Mum:2,Atlas:3,Miles:4',
    `a recorded finishing order is used as-is (${JSON.stringify(full)})`);

  // The old row knows only its top two; the rest are level, not invented.
  const old = ranked(ROWS[6]);
  assert(old.find((r) => r.name === 'Miles').rank === 1 && old.find((r) => r.name === 'Dad').rank === 2,
    'older rows still rank the top two');
  assert(old.filter((r) => r.rank === 3).map((r) => r.name).sort().join() === 'Atlas,Mum',
    `everyone else is joint third, not ordered (${JSON.stringify(old)})`);
  assert(old.length === 4, 'every player is placed');
}

// ---- belts ----
section('belts');
{
  const held = belts(ROWS);
  assert(held.length === 3, `one belt per game (${held.map((b) => b.game)})`);
  const uno = held.find((b) => b.game === 'UNO');
  assert(uno.holder === 'Dad', `most recent winner holds it (${uno.holder})`);
  assert(uno.defences === 1, `and defended it once (${uno.defences})`);
  assert(uno.previous === 'Mum', `the belt was taken from Mum (${uno.previous})`);
  assert(uno.wonAt === at(2026, 9, 20) && uno.since === at(2026, 9, 13),
    'wonAt is the latest win; since is when the reign started');
  const tt = held.find((b) => b.game === 'Table tennis');
  assert(tt.holder === 'Mum', `a one-off game doesn't take a belt (${tt.holder})`);
  assert(belts([]).length === 0, 'no results, no belts');
}

// ---- points and ratings ----
section('points and ratings');
{
  assert(pointsFor(1, 6) === 6 && pointsFor(6, 6) === 1, 'winning a bigger field is worth more');
  assert(pointsFor(1, 2) === 2, 'winning two players is worth two');
  assert(pointsFor(9, 4) === 1, 'never below one');

  const table = leaderboard(ROWS, { sort: 'points' });
  const dad = table.find((p) => p.name === 'Dad');
  // 1st of 4 = 4, 1st of 3 = 3, 2nd of 3 = 2, 3rd of 4 = 2, 2nd of 5 = 4,
  // and 2nd of 4 in the row with no placings = 3.
  assert(dad.points === 4 + 3 + 2 + 2 + 4 + 3, `points add up per placing (${dad.points})`);
  assert(dad.appearances === 6 && dad.wins === 2, `appearances and wins (${dad.appearances}/${dad.wins})`);

  const ratings = elo(ROWS).ratings;
  assert(Object.keys(ratings).length === 5, `everyone is rated (${Object.keys(ratings)})`);
  const total = Object.values(ratings).reduce((a, b) => a + b, 0);
  assert(Math.abs(total - ELO_START * 5) <= 5, `ratings are zero-sum around the start (${total})`);
  assert(ratings.Dad > ELO_START && ratings.Phoenix < ELO_START,
    `winners rise, the player who came last falls (Dad ${ratings.Dad}, Phoenix ${ratings.Phoenix})`);
  assert(elo([]).history.length === 0 && Object.keys(elo([]).ratings).length === 0, 'no results, no ratings');

  // A one-off doesn't move anyone's rating.
  const withTemp = elo(ROWS).ratings;
  const withoutTemp = elo(ROWS.filter((r) => !r.temp)).ratings;
  assert(JSON.stringify(withTemp) === JSON.stringify(withoutTemp), 'one-off games are not rated');
}

// ---- leaderboard ----
section('leaderboard');
{
  const wins = leaderboard(ROWS);
  assert(wins[0].name === 'Dad' && wins[0].wins === 2, `sorted by wins (${wins.map((p) => p.name)})`);
  assert(wins.find((p) => p.name === 'Phoenix').wins === 0, 'a player who never won is still listed');

  const rate = leaderboard(ROWS, { sort: 'rate' });
  assert(rate[0].winRate >= rate[1].winRate, 'sorted by win rate');
  const mum = wins.find((p) => p.name === 'Mum');
  assert(Math.abs(mum.winRate - 2 / 6) < 1e-9, `win rate is wins over appearances (${mum.winRate})`);
  assert(mum.runnerUps === 1, `runner-up finishes counted (${mum.runnerUps})`);
  assert(mum.bestField === 5, `biggest field won (${mum.bestField})`);

  const dad = wins.find((p) => p.name === 'Dad');
  assert(dad.form.length === 5 && dad.form[4] === true, `form is the last five, newest last (${dad.form})`);
  assert(dad.streak.kind === 'wins' && dad.streak.count === 2, `a current run of wins (${JSON.stringify(dad.streak)})`);
  assert(dad.bestGame.game === 'UNO', `best game by rate (${dad.bestGame && dad.bestGame.game})`);
  assert(dad.favouriteVictim.name === 'Mum' || dad.favouriteVictim.name === 'Atlas',
    `beats someone most often (${JSON.stringify(dad.favouriteVictim)})`);
  assert(dad.nemesis && dad.nemesis.count >= 1, `loses finals to someone (${JSON.stringify(dad.nemesis)})`);

  const phoenix = wins.find((p) => p.name === 'Phoenix');
  assert(phoenix.streak.kind === 'drought' && phoenix.streak.count === 1,
    `a drought is counted in events since a win (${JSON.stringify(phoenix.streak)})`);
  assert(phoenix.lastWin === null, 'never won, so no last win');

  const atlas = wins.find((p) => p.name === 'Atlas');
  assert(atlas.longestStreak >= 1, 'longest streak recorded');
  assert(atlas.byMode.some((m) => m.mode === 'free_for_all' && m.wins === 1), 'wins broken down by format');
}

// ---- seasons ----
section('seasons');
{
  const list = seasons(ROWS);
  assert(list.length === 2 && list[0].year === 2026, `newest season first (${list.map((s) => s.year)})`);
  assert(list[0].events === 5, `one-off games don't count as events (${list[0].events})`);
  assert(list[1].year === 2025 && list[1].champion.name === 'Miles',
    `last season has its own champion (${list[1].champion && list[1].champion.name})`);
  assert(list[0].champion.name === 'Dad', `this season's leader (${list[0].champion.name})`);
  assert(list[0].games.includes('UNO') && list[0].games.length === 3, 'games played that season');
  // A season table only counts that season's results.
  assert(list[1].table.find((p) => p.name === 'Miles').wins === 1, 'season wins are scoped');
  assert(!list[1].table.some((p) => p.name === 'Phoenix'), 'players who did not play are absent');
}

// ---- head to head ----
section('head to head');
{
  const h = headToHead(ROWS);
  assert(h.players.join() === 'Atlas,Dad,Miles,Mum', `only finalists appear (${h.players})`);
  assert(h.wins('Dad', 'Mum') === 1 && h.wins('Mum', 'Dad') === 2,
    `wins counted each way (Dad ${h.wins('Dad', 'Mum')} / Mum ${h.wins('Mum', 'Dad')})`);
  assert(h.meetings('Dad', 'Mum') === 3, `meetings are the sum (${h.meetings('Dad', 'Mum')})`);
  assert(h.wins('Dad', 'Phoenix') === 0, 'never met is zero');

  const r = rivalries(ROWS);
  assert(r.length >= 1 && r[0].meetings === 3, `most-met pair first (${JSON.stringify(r[0])})`);
  assert(r[0].leader === 'Mum', `the pair's leader (${r[0].leader})`);
  assert(rivalries(ROWS, { min: 4 }).length === 0, 'a minimum can exclude one-offs');
}

// ---- on this day ----
section('on this day');
{
  const hits = onThisDay(ROWS, new Date(Date.UTC(2026, 8, 21, 12)));
  assert(hits.length === 1 && hits[0].winner === 'Miles', `a year-ago result surfaces (${JSON.stringify(hits.map((h) => h.winner))})`);
  assert(hits[0].yearsAgo === 1, 'and says how long ago');
  assert(onThisDay(ROWS, new Date(Date.UTC(2026, 0, 15, 12))).length === 0, 'nothing on an unrelated day');
  assert(onThisDay(ROWS, new Date(Date.UTC(2025, 8, 21, 12))).length === 0,
    'the current year is never its own anniversary');
}

// ---- formats and overviews ----
section('formats and overviews');
{
  const modes = byFormat(ROWS);
  assert(modes[0].mode === 'double_elimination' && modes[0].events === 3,
    `most-played format first (${JSON.stringify(modes.map((m) => [m.mode, m.events]))})`);
  assert(modes.find((m) => m.mode === 'free_for_all').winners[0].name === 'Atlas',
    'each format lists its winners');
  assert(!modes.some((m) => m.events === 0), 'no empty formats');

  const big = biggestWins(ROWS, { limit: 2 });
  assert(big[0].field === 5 && big[0].winner === 'Mum', `biggest field first (${big[0].field})`);
  assert(big.length === 2, 'limit respected');
}

// ---- degrading gracefully ----
section('empty and partial data');
{
  for (const fn of [belts, leaderboard, seasons, rivalries, byFormat, biggestWins]) {
    let threw = false;
    try { fn([]); } catch (e) { threw = true; }
    assert(!threw, `${fn.name} copes with no rows`);
  }
  const odd = [{ time: at(2026, 1, 1), game: '', winner: 'Solo', players: 'Solo', player_count: 1 }];
  assert(leaderboard(odd)[0].wins === 1, 'a single-player row still counts a win');
  assert(belts(odd)[0].game === 'Untitled', 'a missing game name becomes Untitled');
  assert(headToHead(odd).players.length === 0, 'no runner-up, no head-to-head entry');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
