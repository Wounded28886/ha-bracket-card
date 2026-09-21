// Bundle src/bracket.js + src/card.js into a single dist file for HACS.
import { readFileSync, writeFileSync } from 'node:fs';

const header = `/*! ha-bracket-card — bundled build. Do not edit dist/ directly; edit src/ and run "node build.mjs". */\n`;

let bracket = readFileSync(new URL('./src/bracket.js', import.meta.url), 'utf8');
let card = readFileSync(new URL('./src/card.js', import.meta.url), 'utf8');

// Strip `export ` from the logic module so its symbols are module-local.
bracket = bracket.replace(/^export\s+function/gm, 'function');

// Remove the import block from the card (functions are now in scope).
card = card.replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/bracket\.js['"];\s*/m, '');

const out = header + bracket + '\n' + card;
writeFileSync(new URL('./dist/ha-bracket-card.js', import.meta.url), out);
console.log('wrote dist/ha-bracket-card.js (' + out.length + ' bytes)');
