// Bundle the logic modules and the card into one dist file for HACS.
import { readFileSync, writeFileSync } from 'node:fs';

const LIBS = ['bracket.js', 'formats.js', 'stats.js'];

const header = `/*! ha-bracket-card — bundled build. Do not edit dist/ directly; edit src/ and run "node build.mjs". */\n`;

const read = (f) => readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
// Strip `export ` from the logic modules so their symbols are module-local —
// declarations as well as functions.
const lib = (f) => read(f).replace(/^export\s+(?=(function|const|let|class)\s)/gm, '');
// Remove the import blocks from the card (everything is now in scope).
const names = LIBS.map((f) => f.replace(/\.js$/, '')).join('|');
const card = read('card.js')
  .replace(new RegExp(`import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*['"]\\./(${names})\\.js['"];\\s*`, 'gm'), '');

const out = header + LIBS.map(lib).join('\n') + '\n' + card;
writeFileSync(new URL('./dist/ha-bracket-card.js', import.meta.url), out);
console.log('wrote dist/ha-bracket-card.js (' + out.length + ' bytes)');
