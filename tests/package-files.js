'use strict';

// Every file the app loads at startup must be in the package (package.json build.files), or the installed app dies the moment it needs one.
// A new main-process module that was only ever run from source is the classic way to ship a broken release.
// Follows main.js, preload.js and every <script src> in index.html through their local require()s, and checks each is listed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const listed = new Set(pkg.build.files.filter(entry => typeof entry === 'string' && !entry.includes('*') && !entry.startsWith('!')));
const globs = pkg.build.files.filter(entry => typeof entry === 'string' && entry.includes('*') && !entry.startsWith('!'));
const inPackage = file => listed.has(file) || globs.some(pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '(.+/)?').replace(/\*/g, '[^/]*') + '$').test(file));

const start = ['main.js', 'preload.js'];
for (const match of fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)) start.push(match[1]);
const seen = new Set(), queue = start.filter(file => !/^https?:/.test(file));
const missing = [];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue; seen.add(file);
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { missing.push(file + ' (does not exist)'); continue; }
  if (!inPackage(file)) missing.push(file);
  if (!file.endsWith('.js')) continue;
  for (const match of fs.readFileSync(full, 'utf8').matchAll(/require\(\s*['"]\.\/([\w./-]+?)(\.js)?['"]\s*\)/g)) {
    const candidate = match[1] + (fs.existsSync(path.join(root, match[1] + '.js')) ? '.js' : '');
    if (fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()) queue.push(candidate);
  }
}
assert.deepStrictEqual(missing, [], 'these files are loaded at startup but are not in package.json build.files, so an installed app would not have them: ' + missing.join(', '));
console.log(`PASS all ${seen.size} files the app loads at startup are in the package`);
