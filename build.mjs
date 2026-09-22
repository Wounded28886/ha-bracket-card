// Bundle src/bracket.js + src/formats.js + src/card.js into a single dist file for HACS.
import { readFileSync, writeFileSync } from 'node:fs';

const header = `/*! ha-bracket-card — bundled build. Do not edit dist/ directly; edit src/ and run "node build.mjs". */\n`;

const read = (f) => readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
// Strip `export ` from the logic modules so their symbols are module-local.
const lib = (f) => read(f).replace(/^export\s+function/gm, 'function');
// Remove the import blocks from the card (functions are now in scope).
const card = read('card.js').replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/(bracket|formats)\.js['"];\s*/gm, '');

const out = header + lib('bracket.js') + '\n' + lib('formats.js') + '\n' + card;
writeFileSync(new URL('./dist/ha-bracket-card.js', import.meta.url), out);
console.log('wrote dist/ha-bracket-card.js (' + out.length + ' bytes)');
