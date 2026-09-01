'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..'),pkg=require('../package.json');
assert(!Array.isArray(pkg.build.extraResources)||!pkg.build.extraResources.some(item=>/emoji/i.test(String(item?.from||''))),'installer still bundles an emoji mirror');
assert(!Object.keys(pkg.scripts).some(name=>name==='emoji:collect'||name==='emoji:verify'),'collector scripts remain enabled');
const packagedFiles=Array.isArray(pkg.build.files)?pkg.build.files:[];
assert(!packagedFiles.some(item=>/dist-emoji-catalog|emoji-catalog\/originals/.test(String(item))),'packaged files still include Emoji.gg originals');
const beforePack=fs.readFileSync(path.join(root,'scripts','before-pack.js'),'utf8');
assert(!/stageEmojiCatalog|catalog-v1|emoji-catalog\.tar\.gz/.test(beforePack),'packaging still downloads or stages the mirrored catalog');
const source=fs.readFileSync(path.join(root,'emoji-catalog.js'),'utf8');
assert(source.includes("const MAX_CACHE_BYTES = 64 * 1024 * 1024")&&source.includes("const MAX_CACHE_FILES = 512"),'on-demand disk cache is not explicitly bounded');
console.log('PASS installers contain no Emoji.gg originals and runtime caching is bounded');
