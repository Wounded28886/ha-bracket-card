# Bracket Card for Home Assistant

A reusable **game-night tournament board**. Pick a format, type in the players,
tap the winner of each match, and it keeps score. One button starts a fresh
tournament next time.

Run it either way — the board itself is the same code in both:

- **In Home Assistant** as a Lovelace card, installed through HACS.
- **On its own** as a Docker container (a NAS, a Pi, anything), with no Home
  Assistant at all — see [Standalone (Docker)](#standalone-docker).

![Preview](docs/preview.png)

- **Six formats** — double elimination (with the grand-final "bracket reset"),
  single elimination, round robin, Swiss system, king of the hill and
  free-for-all (points race). See [Formats](#formats).
- **Any number of players (2–64)** — as many real first-round matches as
  possible; only the leftover player (if any) gets a bye.
- **Random draw** — the entered names are shuffled when the bracket is created.
- **Connected bracket view** — winners and losers brackets with connector lines,
  later rounds centred between their feeders, and the grand final on the right.
- **Reusable** — nothing is hard-coded. New game night = new bracket in seconds.
- **No custom integration, no Python** — a single frontend card. State lives in
  one `input_text` helper (or, standalone, one JSON file), so it survives
  restarts and is shared across every device looking at it.
- **Tap to advance / re-pick** — mis-tapped? Tap the other name; anything
  downstream that depended on it is cleared automatically.
- **Game name** — type what you're playing (Mario Kart, UNO…) when you set up
  the bracket; it's shown next to the title.
- **Optional result tracking** — record every result and the companion
  `bracket-history-card` turns them into a Hall of Fame: a title per game,
  season tables, ratings, head-to-head and a page per player. See
  [The Hall of Fame](#the-hall-of-fame).
- Follows your Home Assistant theme (light and dark).

---

## Installation (HACS)

This is distributed as a **HACS custom repository** (dashboard/plugin type).

1. In Home Assistant, open **HACS**.
2. Top-right **⋮ menu → Custom repositories**.
3. Add the repository:
   - **Repository:** `https://github.com/Wounded28886/ha-bracket-card`
   - **Type:** `Dashboard`
4. Find **Bracket Card** in the HACS list, open it, and click **Download**.
5. **Restart Home Assistant** (or reload resources) when prompted.

> HACS registers the Lovelace resource for you at
> `/hacsfiles/ha-bracket-card/ha-bracket-card.js`. If you ever add it by hand
> (Settings → Dashboards → ⋮ → Resources), use that URL with type
> **JavaScript Module**.

### Manual install (no HACS)

Copy `dist/ha-bracket-card.js` to `<config>/www/ha-bracket-card.js`, then add a
dashboard resource pointing at `/local/ha-bracket-card.js` (JavaScript Module).

---

## Setup

### 1. Create a text helper to hold the bracket state

**UI:** Settings → Devices & Services → **Helpers** → **＋ Create Helper** →
**Text** → name it e.g. `Game Night Bracket`, set **Maximum length** to `255`.

**or YAML** (`configuration.yaml`):

```yaml
input_text:
  game_night_bracket:
    name: Game Night Bracket
    max: 255
```

One helper per bracket you want to run at once. Want a permanent "board games"
bracket and a separate "Mario Kart" one? Make two helpers and two cards.

### 2. Add the card to a dashboard

Edit your dashboard → **＋ Add Card** → search **Bracket Card** (or use the YAML
editor):

```yaml
type: custom:bracket-card
entity: input_text.game_night_bracket
title: Friday Game Night
```

### 3. Play

1. Enter the game you're playing, choose a **Format**, type the player names one
   per line, and hit **Start**. The draw is randomised, so the order you type
   them in doesn't matter.
2. Tap the winner of each match — the card fills in what comes next.
3. When it's done, the 🏆 champion banner appears.
4. **New game** clears it for the next one.

---

## Formats

| Format | How it plays | Champion |
| --- | --- | --- |
| **Double elimination** | Lose twice and you're out. Winners bracket, losers bracket, grand final on the right, with a reset game if the losers-bracket player wins game 1 (`reset_bracket: false` to skip that). Byes are kept to a minimum: 5 players → 2 first-round matches and 1 bye. | Grand final winner |
| **Single elimination** | Lose once and you're out. Fastest. | Final winner |
| **Round robin** | Everyone plays everyone once; rounds are laid out as columns next to a live standings table. Odd counts sit one player out per round. | Most wins, then head-to-head. A dead tie gets a single-elimination **decider** among the tied players. |
| **Swiss system** | A fixed number of rounds (default log₂ of the players, or set it on the setup screen). Each round pairs players on the same record, avoiding rematches; the next round only appears once the current one is done. Odd counts give the lowest-ranked player a bye (counts as a win). | Most wins, then head-to-head, then strength of opposition (SOS). Dead ties get a decider. |
| **King of the hill** | **Nobody starts as king:** the first two players play for the hill and the winner is crowned (that win doesn't count as a win *on* the hill). After that the winner stays on; the challenger defaults to whoever has waited longest, but tap any waiting name to send them up instead, and the loser goes to the back of the queue. **Undo** takes a game back, **Finish session** records it. **Wins on top** — games won while holding the hill — are tracked per player. See [Ongoing king of the hill](#ongoing-king-of-the-hill). | Whoever holds the hill |
| **Free-for-all** | Everyone plays at once — a Mario Kart race, a hand of UNO. Each round, tap the players in finishing order and **Save round**; points default to *n* … 1 for 1st … last (`ffa_points` to override, e.g. `[10, 7, 5, 3, 2, 1]`); anyone not placed scores 0. **Finish** ends it. | Most points, then most 1sts. If the top is tied, Finish waits for one more round. |

Every format records the same things when tracking is on: the game, format,
winner, runner-up, **every player who took part**, and a standings summary
(W–L, points, or wins on top).

### Ongoing king of the hill

With tracking on, each game name keeps **one ongoing king-of-the-hill title** —
the Table tennis hill, the UNO hill — and the setup screen tells you who holds
it. What happens when you press **Start** depends on who's in the player list:

| Who's playing | What happens |
| --- | --- |
| No title recorded for this game yet | This becomes the game's ongoing title. |
| The reigning champion **is** in the list | You're asked whether to carry that game on. **Continue it** → confirm the roster (drop anyone who isn't here, add newcomers; returning players keep their record, the champion stays) and play on with the same king, queue and running totals. **No — one-off game** → see below. |
| The champion **isn't** playing | It's a **one-off** automatically: a normal game that crowns its own king for the evening, recorded to the history tagged `one-off`, leaving the real title untouched. |

A continued title updates its single history entry rather than adding a row per
evening, so the Hall of Fame always shows the current king and how long they've
held it. Pressing **New game** over a live title offers **Record & clear** so the
session is saved before it's cleared.

---

## Card options

| Option          | Type    | Default              | Description                                                        |
| --------------- | ------- | -------------------- | ------------------------------------------------------------------ |
| `type`          | string  | —                    | `custom:bracket-card` (required)                                   |
| `entity`        | string  | —                    | An `input_text` (or `text`) helper that stores the bracket (required) |
| `title`         | string  | `Tournament Bracket` | Heading shown on the card                                          |
| `reset_bracket` | boolean | `true`               | Double elimination: if `true`, the grand final is best-of-two when the losers-bracket player wins game 1 (a true "bracket reset"). Set `false` for a single decisive grand final. |
| `default_game`  | string  | —                    | Pre-fills the Game box on the setup screen                          |
| `default_mode`  | string  | `double`             | Pre-selects the format: `double`, `single`, `round_robin`, `swiss`, `king_of_the_hill` or `free_for_all` |
| `ffa_points`    | list    | *n* … 1              | Free-for-all points per finishing place                             |
| `tracking`      | boolean / object | `false`     | Record results in InfluxDB — see [Result tracking](#result-tracking-influxdb) |

---

## Result tracking (InfluxDB)

With tracking on, the card writes one point to InfluxDB the moment a champion is
decided (game, format, winner, runner-up, players, standings), and the **Bracket
History Card** reads them back to show the current champion, every past winner
and a wins leaderboard, filterable by game.

A dashboard card can't talk to InfluxDB directly, so both directions go through
two small `rest_command`s in Home Assistant. One-time setup:

### 1. Create a database and user in InfluxDB

In the InfluxDB add-on (Chronograf UI) → **InfluxDB Admin**:

- **Databases → Create Database**: `game_night`
- **Users → Create User**: e.g. `game_night` with a password, and grant it
  **read + write** on `game_night`.

(InfluxDB 1.x. For 2.x you'd point the URLs at `/api/v2/write` and `/api/v2/query`
with a token header instead — the card doesn't care, it only calls the services.)

### 2. Add the rest_commands to `configuration.yaml`

```yaml
rest_command:
  game_night_write:
    url: "http://a0d7b954-influxdb:8086/write?db=game_night&precision=s"
    method: POST
    username: !secret influx_game_user
    password: !secret influx_game_password
    content_type: "text/plain; charset=utf-8"
    payload: "{{ line }}"
  game_night_query:
    url: "http://a0d7b954-influxdb:8086/query?db=game_night&epoch=s&q={{ q | urlencode }}"
    method: GET
    username: !secret influx_game_user
    password: !secret influx_game_password
```

and in `secrets.yaml`:

```yaml
influx_game_user: game_night
influx_game_password: your-password
```

`a0d7b954-influxdb` is the add-on's hostname as seen from Home Assistant; use
your server's IP or hostname if InfluxDB runs elsewhere. Then **Developer tools
→ YAML → Rest commands** (reload) — no restart needed.

### 3. Turn it on in the cards

```yaml
type: custom:bracket-card
entity: input_text.game_night_bracket
title: Friday Game Night
tracking: true
```

```yaml
type: custom:bracket-history-card
title: Hall of Fame
entity: input_text.game_night_bracket   # optional: refresh as soon as a result is recorded
```

`tracking: true` uses the service names above. If you named them differently,
or want a different measurement, pass an object instead (same shape on both
cards):

```yaml
tracking:
  write_service: rest_command.game_night_write
  query_service: rest_command.game_night_query
  measurement: result
```

### History card options

| Option     | Type    | Default        | Description                                              |
| ---------- | ------- | -------------- | -------------------------------------------------------- |
| `title`    | string  | `Past Winners` | Heading                                                  |
| `tracking` | boolean / object | `true` | Same as the bracket card's option                        |
| `entity`   | string  | —              | The bracket helper; the card reloads whenever it changes |
| `limit`    | number  | `100`          | Most recent results to fetch                             |
| `game`     | string  | —              | Preselect the game filter                                |
| `view`     | string  | `champions`    | Which tab opens first: `champions`, `league`, `h2h` or `history` |
| `sort`     | string  | `wins`         | Leaderboard order: `wins`, `rate`, `points` or `rating`  |

## The Hall of Fame

Every recorded result feeds four views, and every name in any of them opens
that player's own page.

**Champions.** A **title per game** across the top — whoever won UNO last
holds the UNO belt until somebody takes it off them, with how many times
they've defended it and who they took it from. Then the current season's
leader, and the leaderboard: wins, runner-up finishes, how often each player
turned up, **win rate**, points and rating. A run of wins earns a 🔥 badge;
four events without one earns a dry spell. Five dots show recent form at a
glance. Finally, **on this day** — what happened a year ago tonight.

**League.** A table per season, ordered by points, so last year's dominance
doesn't sit on top of this year's board for ever. Below it, a breakdown **by
format** (who wins knockouts, who wins points races) and the **biggest
fields** anyone has won.

**Head to head.** A grid of who has beaten whom in a final, green where
you're ahead and red where you're behind, plus a **rivalries** list ordered by
how often each pair has met.

**History.** Every result, newest first, with the full finishing order.

**A player's page** collects it all for one person: wins and win rate, points,
rating, best field, form and streak, their record **by game** and **by
format**, who beats them most and who they beat most, and their recent
placings.

### How points and ratings work

**Points** reward beating more people: a placing in a field of *n* is worth
*n − place + 1*, so winning a six-player night is six points and winning a
two-player one is two. Season tables are ordered by points.

**Ratings** start at 1000 and move only with who you beat. One tournament is
treated as every pair of its players at once — finishing above someone counts
as a win against them — and each pair can move a rating by at most a fixed
step, so a big field doesn't swing ratings harder than a small one, it just
settles them faster. Turning up and losing doesn't cost you much; losing to
people you should beat does.

Both are computed from the rows at display time, so **they apply to results
you have already recorded** — nothing needs re-entering.

### What gets stored

Measurement `result` (configurable) with:

| | Name | Example |
| --- | --- | --- |
| tag | `game` | `Mario Kart` |
| tag | `mode` | `double_elimination`, `single_elimination`, `round_robin`, `swiss`, `king_of_the_hill`, `free_for_all` |
| field | `winner` | `Dad` |
| field | `runner_up` | `Mum` |
| field | `players` | `Mum, Dad, Atlas, Miles` — everyone who took part |
| field | `player_count` | `4` |
| field | `standings` | `Dad=3-1, Mum=2-2, …` (round robin / Swiss W–L), `Dad=21, Mum=17` (free-for-all points), `Dad=5, Mum=2` (king of the hill wins on top). Absent for brackets. |
| field | `placings` | The full finishing order, best first — what the season points and ratings are built from. A bracket ranks by how long you lasted; every other format uses its own final standings. |
| field | `top_wins` | King of the hill only: the king's wins while holding the hill |
| field | `games`, `sessions`, `last_played` | King of the hill only: running totals for the title and when it was last played |
| field | `state` | King of the hill only: the snapshot the card uses to continue the title (players, king, queue, totals) |
| field | `temp` | `true` on a one-off king-of-the-hill game — it never becomes the game's ongoing title |

Results recorded before `placings` existed still count everywhere: the card
treats them as "winner first, runner-up second, everyone else level", which is
all those rows actually knew.

The point's timestamp is when the tournament was started. That means correcting
a mis-tap after the champion was decided re-records over the same point rather
than adding a duplicate — and a continued king-of-the-hill title keeps
updating its one point (`last_played` says when), so the history shows the
current king rather than a row per evening. Because it's plain InfluxDB data, Grafana can chart it
too: query `SELECT "winner", "runner_up", "game", "mode" FROM "result"` as a
table and use a *Group by* transform on `winner`, or count one player at a time
with `SELECT count("winner") FROM "result" WHERE "winner" = 'Eve'`. (Winner is a
field rather than a tag so that a corrected result overwrites the original.)

If a write fails (InfluxDB down, wrong password…) the champion banner says so
with a **Retry** button; nothing is lost, the bracket just isn't flagged as
recorded yet.

---

## How state is stored (and the 255-character note)

The card never stores the whole bracket tree. It stores only the player list,
the game name, the format and the decisions (one character per match, or the
finishing order per free-for-all round), as a compact JSON string in the helper
— everything else is regenerated deterministically from that. This keeps the
payload small: **8 players fit comfortably** inside an `input_text` (max 255
chars). A long king-of-the-hill or free-for-all session (dozens of games) can
also get there; the card tells you if it won't fit.

For **large brackets with long names** (roughly 16+ players) the payload can
approach the 255-character `input_text` limit. If the card warns you it won't
fit, either use shorter display names, run fewer players, or point `entity` at a
`text` helper configured with a higher `max`.

---

## Standalone (Docker)

The board also runs **completely on its own** — a single container on a NAS or
any Docker host, with its own address and its own storage. No Home Assistant,
no database, no helpers, no `rest_command`s; once built it needs no internet
either. Every format, the result history and the ongoing king-of-the-hill
titles work exactly the same.

```bash
docker run -d -p 8099:8099 -v ./data:/data \
  ghcr.io/wounded28886/bracket-board:latest      # -> http://<host>:8099
```

**[server/README.md](server/README.md) is the whole story for that deployment** —
a Synology Container Manager walkthrough, the settings, the API and how to back
it up. It doesn't mention Home Assistant, because the deployment doesn't
involve it.

Under the hood it is the *same card bundle*, byte for byte: the cards only ever
ask their host for a text entity and two service calls, so the standalone
server provides those three things and they run unchanged. One codebase, one
set of tests, two ways to run it.

## Development

```bash
npm run serve     # http://localhost:8099, data in ./data
npm test          # includes the server's own tests
```

## Development

```bash
npm test          # logic unit tests + jsdom card smoke test
npm run build     # bundle src/ -> dist/ha-bracket-card.js
```

- `src/bracket.js` — pure double/single-elimination engine (no DOM). Unit-tested
  in `test/bracket.test.mjs`.
- `src/formats.js` — round robin, Swiss, king of the hill, free-for-all logic.
  Unit-tested in `test/formats.test.mjs`.
- `src/stats.js` — what the recorded results add up to: belts, seasons,
  leaderboards, points, ratings, head-to-head, streaks. Pure functions over
  the rows, unit-tested in `test/stats.test.mjs`.
- `src/card.js` — the Lovelace custom elements (both cards).
- `dist/ha-bracket-card.js` — the bundled file HACS serves. **Generated** — run
  `npm run build` after editing `src/`.
- `server/` — the standalone server (see [server/README.md](server/README.md)):
  `lib/influx.mjs` is the storage engine (line protocol + the InfluxQL subset
  the cards use, tested in `test/server.test.mjs`), `public/app.js` is the shim
  that stands in for Home Assistant so the unmodified cards run against it.

## License

MIT
