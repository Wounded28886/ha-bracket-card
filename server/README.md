# Tournament board — standalone server

A game-night tournament board that runs on its own: one container, one folder,
its own address. Type in the players, tap the winner of each game, and it keeps
score on every screen at once.

**Nothing else is required.** No Home Assistant, no database, no message
broker, no cloud account — and no internet at all once the image is built. The
container talks to nobody; every phone, tablet and TV just opens its URL.

- **Six formats** — double elimination, single elimination, round robin, Swiss
  system, king of the hill and free-for-all (points race).
- **Ongoing titles** — each game (UNO, Mario Kart…) keeps one king-of-the-hill
  champion that carries across evenings.
- **A Hall of Fame** — a belt per game, season tables with points and ratings,
  a head-to-head grid, rivalries, form and streaks, and a page per player.
- **Everything in one file** — `/data/store.json` holds the tournament in
  progress and every result. Copy it and you have a backup; delete it and you
  start fresh.

---

## Synology (Container Manager)

Nothing is built on the NAS — it pulls a ready-made image.

1. **Container Manager → Project → Create.**
   - **Project name:** `bracket`
   - **Path:** a new folder, e.g. `/volume1/docker/bracket`
   - **Source:** *Create docker-compose.yml* and paste:

   ```yaml
   services:
     bracket:
       image: ghcr.io/wounded28886/bracket-board:latest
       container_name: bracket
       restart: unless-stopped
       ports:
         - "8099:8099"
       volumes:
         - ./data:/data
       environment:
         TITLE: "Game Night"
   ```

2. Click through; it downloads the image (about 60 MB) and starts in seconds.
3. Open **`http://<nas-ip>:8099`**.

The project folder grows a `data/` directory holding `store.json` — the
tournament in progress and every result. Add it to Hyper Backup and your game
history is covered.

**Updating:** Container Manager → the project → **Action → Reset** (or
*Image → pull* then restart) picks up the newest image. Your `data/` folder is
untouched. Pin a version instead of tracking `latest` by using, say,
`ghcr.io/wounded28886/bracket-board:1.6`.

The image is public, multi-arch (`linux/amd64` and `linux/arm64`) and built by
GitHub Actions straight from this repository, so there's no account to set up
and nothing to log in to.

## Anywhere else

```bash
docker run -d --name bracket -p 8099:8099 \
  -v /volume1/docker/bracket/data:/data \
  -e TITLE="Game Night" --restart unless-stopped \
  ghcr.io/wounded28886/bracket-board:latest
```

### Building it yourself instead

```bash
git clone https://github.com/Wounded28886/ha-bracket-card
cd ha-bracket-card
docker build -t bracket-board .
docker run -d --name bracket -p 8099:8099 -v "$PWD/data:/data" bracket-board
```

or, if you'd rather not use Docker at all — it's plain Node with no
dependencies:

```bash
node build.mjs && DATA_DIR=./data node server/server.mjs
```

## Settings

All optional, set as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8099` | Port inside the container |
| `DATA_DIR` | `/data` | Where `store.json` lives — mount this |
| `TITLE` | `Game Night` | Heading on the page |
| `BOARD` | `default` | Board used when the URL doesn't name one |
| `POLL_MS` | `25000` | How long a sync request may wait before answering |

## Using it

Every device pointed at the URL stays in step: a tap on one phone shows up on
the others in about a second, no refreshing. Leave it open on a TV and it
follows along by itself.

**More than one board at a time** — add `?board=` to the URL:
`http://<nas-ip>:8099/?board=kids` runs a completely separate tournament
alongside the default one. `?title=` overrides the heading for that link.
Handy as a bookmark per room or per group.

> **There is no login.** Anyone who can reach the address can tap winners.
> That's usually right for a house; if you want it reachable from outside,
> put it behind a reverse proxy that handles authentication.

## Under the hood

The board stores results the way a time-series database does — a measurement
called `result`, tagged by `game` and `mode`, with the winner, runner-up,
players and standings as fields. That's an implementation detail, but it means
you can read and clear the history without the UI:

```bash
# every result, newest first
curl -s localhost:8099/api/query --json \
  '{"q":"SELECT \"winner\",\"game\",\"mode\" FROM \"result\" ORDER BY time DESC LIMIT 20"}'

# the current tournament, as stored
curl -s localhost:8099/api/state

# wipe the history (the tournament in progress is left alone)
curl -s localhost:8099/api/query --json '{"q":"DELETE FROM \"result\""}'

# liveness, for a monitor
curl -s localhost:8099/healthz
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | The current tournament. Add `?rev=<n>` and the request waits until it changes — that's how devices stay in sync. |
| `PUT /api/state` | `{"value": "<state>"}` — replace it. |
| `POST /api/write` | `{"line": "<line protocol>"}` — record a result. |
| `GET\|POST /api/query` | `SELECT` / `DELETE` / `SHOW MEASUREMENTS`. |
| `GET /healthz` | `{ok:true}` plus board and point counts. |

## Files

| Path | What it is |
| --- | --- |
| `server.mjs` | The whole server: static files plus the API above. |
| `lib/store.mjs` | The JSON store — atomic writes, several boards, the long poll. |
| `lib/influx.mjs` | The storage engine: line protocol in, queries out. |
| `public/index.html` | The page, and every colour it uses. |
| `public/app.js` | Wires the board to this server's API. |
| `public/board.js` | The board itself, built from `src/` (generated). |

Tested by `test/server.test.mjs` in the repository root — `npm test` runs it.
