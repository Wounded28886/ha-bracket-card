/*
 * Durable state for the standalone server: one JSON file on disk holding
 * every board's current tournament plus the recorded results.
 *
 * Writes are atomic (temp file + rename) and coalesced, so a burst of taps
 * during a game doesn't hammer the NAS's disk. Everything is kept in memory;
 * a game night is a few kilobytes.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyPoint, runQuery, parseLine } from './influx.mjs';

const EMPTY = { version: 1, boards: {}, points: [] };

export class Store {
  constructor(dir, { flushMs = 250 } = {}) {
    this.dir = dir;
    this.file = join(dir, 'store.json');
    this.tmp = join(dir, 'store.json.tmp');
    this.flushMs = flushMs;
    this.timer = null;
    this.waiters = new Map();     // board -> Set of resolve callbacks
    this.data = this.#load();
  }

  #load() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      return {
        version: 1,
        boards: raw.boards && typeof raw.boards === 'object' ? raw.boards : {},
        points: Array.isArray(raw.points) ? raw.points : [],
      };
    } catch (e) {
      // Never lose data to a parse error: keep the bad file for inspection.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, backup); } catch (_) { /* best effort */ }
      console.error(`[store] ${this.file} unreadable (${e.message}); moved to ${backup}`);
      return structuredClone(EMPTY);
    }
  }

  #touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    writeFileSync(this.tmp, JSON.stringify(this.data));
    renameSync(this.tmp, this.file);
  }

  /* ---- board state (what the card reads and writes) ---- */

  board(name) {
    return this.data.boards[name] || { value: '', rev: 0, updated: 0 };
  }

  setBoard(name, value) {
    const cur = this.board(name);
    if (cur.value === value) return cur;
    const next = { value, rev: cur.rev + 1, updated: Math.floor(Date.now() / 1000) };
    this.data.boards[name] = next;
    this.#touch();
    this.#wake(name, next);
    return next;
  }

  /*
   * Long poll: resolve as soon as the board moves past `rev`, or on timeout
   * with whatever is current. Keeps every device in step without websockets.
   */
  watch(name, rev, timeoutMs) {
    const cur = this.board(name);
    if (cur.rev !== rev) return Promise.resolve(cur);
    return new Promise((resolve) => {
      let set = this.waiters.get(name);
      if (!set) { set = new Set(); this.waiters.set(name, set); }
      const done = (v) => { clearTimeout(t); set.delete(done); resolve(v); };
      // Deliberately not unref'd: a request that is already waiting deserves
      // its answer, even if nothing else is keeping the loop alive.
      const t = setTimeout(() => done(this.board(name)), timeoutMs);
      set.add(done);
    });
  }

  #wake(name, value) {
    const set = this.waiters.get(name);
    if (!set) return;
    for (const fn of [...set]) fn(value);
    set.clear();
  }

  /* ---- results (the InfluxDB stand-in) ---- */

  write(body) {
    const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
    let n = 0;
    for (const line of lines) {
      const point = parseLine(line);
      if (!point) continue;
      applyPoint(this.data.points, point);
      n++;
    }
    if (n) this.#touch();
    return n;
  }

  query(q) {
    return runQuery(this.data.points, q, () => this.#touch());
  }

  stats() {
    return {
      boards: Object.keys(this.data.boards).length,
      points: this.data.points.length,
      file: this.file,
    };
  }
}
