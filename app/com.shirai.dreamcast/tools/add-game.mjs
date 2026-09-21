#!/usr/bin/env node
// Zips one or more disc-image files into games/<name>.zip and registers it in games/games.json.
// Usage: node tools/add-game.mjs <file> [file...]   (e.g. game.gdi track01.bin track02.raw ...)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from '../lib/fflate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gamesDir = join(here, '..', 'games');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/add-game.mjs <file> [file...]'); process.exit(1); }

const entries = {};
for (const f of files) entries[basename(f)] = [readFileSync(f), { level: 0 }];   // store (no compression): fast to unzip on the Switch
const primary = files.map((f) => basename(f)).find((n) => /\.(cue|gdi|chd|cdi|elf|iso)$/i.test(n)) || basename(files[0]);
const zipName = primary.replace(/\.[^.]+$/, '') + '.zip';
writeFileSync(join(gamesDir, zipName), zipSync(entries));

const listPath = join(gamesDir, 'games.json');
const list = existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : { games: [] };
list.games = (list.games || []).filter((g) => g.file !== zipName);
list.games.push({ title: primary.replace(/\.[^.]+$/, ''), file: zipName, launch: primary });
writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');
console.log(`added ${zipName} (launch: ${primary})`);
