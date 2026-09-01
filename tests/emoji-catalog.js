'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../emoji-catalog');

const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const rows = [
  {id:1,title:'party',slug:'1000_party',image:'https://cdn3.emoji.gg/emojis/1000_party.png',description:'celebrate happy',category:1,license:'0',faves:10,submitted_by:'A'},
  {id:2,title:'party_dance',slug:'1001_party_dance',image:'https://cdn3.emoji.gg/emojis/1001_party_dance.gif',description:'dancing celebration',category:2,license:'0',faves:100,submitted_by:'B'},
  {id:3,title:'laughing_cat',slug:'1002_laughing_cat',image:'https://cdn3.emoji.gg/emojis/1002_laughing_cat.png',description:'lol kitty',category:3,license:'0',faves:20,submitted_by:'C'},
  {id:4,title:'smiling_face',slug:'1003_smiling_face',image:'https://cdn3.emoji.gg/emojis/1003_smiling_face.webp',description:'happy smile',category:4,license:'0',faves:0,submitted_by:'D'},
  {id:5,title:'blocked_host',slug:'blocked',image:'https://example.com/emojis/no.png',description:'must be rejected',category:4,license:'0',faves:999,submitted_by:'E'},
];

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'knot-emoji-api-')),originalFetch=global.fetch;
  let metadataFetches=0,assetFetches=0;
  global.fetch=async url=>{
    if(String(url)==='https://emoji.gg/api'){metadataFetches++;return new Response(JSON.stringify(rows),{status:200,headers:{'content-type':'application/json'}})}
    if(String(url)==='https://cdn3.emoji.gg/emojis/1000_party.png'){assetFetches++;return new Response(PNG,{status:200,headers:{'content-type':'image/png','content-length':String(PNG.length)}})}
    throw new Error('unexpected fetch '+url);
  };
  try{
    assert(catalog.init(null,{cacheRoot:root}));
    const refreshed=await catalog.refresh({force:true});
    assert.strictEqual(refreshed.total,4,'unsafe API rows were not rejected');
    assert.strictEqual(metadataFetches,1);
    assert.strictEqual(catalog.search({q:'party'}).items[0].name,'party','exact match lost to a popular prefix');
    assert(catalog.search({q:'lol'}).items.some(item=>item.name==='laughing_cat'),'synonym search failed');
    assert(catalog.search({q:'smilng'}).items.some(item=>item.name==='smiling_face'),'bounded typo search failed');
    assert(catalog.search({type:'animated'}).items.every(item=>item.animated),'animated filter failed');
    assert(catalog.search({type:'static'}).items.every(item=>!item.animated),'static filter failed');
    const first=catalog.search({limit:2}),second=catalog.search({cursor:first.nextCursor,limit:2});
    assert.strictEqual(first.items.length,2);assert(second.items.every(item=>!first.items.some(previous=>previous.id===item.id)),'pagination overlapped');
    assert.strictEqual(catalog.safeImageUrl('https://example.com/emojis/x.png'),null,'arbitrary asset host accepted');
    assert.strictEqual(catalog.safeImageUrl('http://cdn3.emoji.gg/emojis/x.png'),null,'insecure asset URL accepted');
    const asset=await catalog.assetForRequest('emoji://api/1.png');
    assert(asset?.buffer.equals(PNG)&&asset.mime==='image/png','on-demand asset validation failed');
    const cached=await catalog.assetForRequest('emoji://api/1.png');
    assert(cached?.cached&&assetFetches===1,'asset was not reused from bounded disk cache');
    assert.strictEqual(await catalog.assetForRequest('emoji://api/1.gif'),null,'extension confusion accepted');
    global.fetch=async()=>{throw new Error('offline')};
    await assert.rejects(catalog.refresh({force:true}),/offline/);
    assert(catalog.search({q:'party'}).items.length,'cached metadata disappeared after refresh failure');
    console.log('PASS keyless Emoji.gg API index, local search, validation, offline metadata, and on-demand cache');
  }finally{catalog.close();global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
