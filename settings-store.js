const fs = require('fs');
const path = require('path');
const SETTINGS_COMPANION_FILES = ['settings.json', 'settings.json.bak', 'settings.key', 'settings.key.bak', 'history.db', 'history.db-wal', 'history.db-shm', 'profile-avatar', 'profile-avatar.bak'];
function settingsObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function migrateSettingsCompanions(stableDir, candidateDirs) {
  if (!stableDir) return [];
  fs.mkdirSync(stableDir, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const dir of [...new Set((candidateDirs || []).filter(Boolean))]) {
    if (path.resolve(dir) === path.resolve(stableDir)) continue;
    for (const name of SETTINGS_COMPANION_FILES) {
      const from = path.join(dir, name), to = path.join(stableDir, name);
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          if (name === 'settings.key' || name === 'settings.key.bak') try { fs.chmodSync(to, 0o600); } catch {}
          copied.push(name);
        }
      } catch {}
    }
  }
  return copied;
}

function validDirectoryUserId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
function validDirectoryToken(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validDirectoryAccountName(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{2,23}$/.test(value); }
function storedDirectoryToken(value) {
  if (validDirectoryToken(value)) return value;
  if (value && typeof value === 'object' && typeof value.format === 'string' && value.format && (value.data || value.tag)) return value;
  return null;
}

// Pair→Knot kept the new settings.json (theme, sidecar photo) and refused to
// clobber it, so a still-valid session in ~/.config/pair-p2p was left behind
// and Knot minted a blank identity. Copy only missing account fields.
function durableReplace(target, contents) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } catch (error) {
    try { if (fd != null) fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try { fs.closeSync(fd); } catch {}
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}

function mergeMissingAccountIdentity(stableDir, candidateDirs) {
  if (!stableDir) return [];
  const target = path.join(stableDir, 'settings.json');
  let current;
  try { current = parseSettings(fs.readFileSync(target, 'utf8')); } catch { return []; }
  const needId = !validDirectoryUserId(current.directoryUserId);
  const needToken = !storedDirectoryToken(current.directoryToken);
  const needName = !validDirectoryAccountName(current.directoryAccountName);
  if (!needId && !needToken && !needName) return [];
  const merged = [];
  for (const dir of [...new Set((candidateDirs || []).filter(Boolean))]) {
    if (path.resolve(dir) === path.resolve(stableDir)) continue;
    let older;
    try { older = parseSettings(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { continue; }
    if (needId && validDirectoryUserId(older.directoryUserId)) {
      current.directoryUserId = older.directoryUserId;
      merged.push('directoryUserId');
    }
    if (needToken) {
      const token = storedDirectoryToken(older.directoryToken);
      const leftoverId = validDirectoryUserId(older.directoryUserId) ? older.directoryUserId : '';
      const currentId = validDirectoryUserId(current.directoryUserId) ? current.directoryUserId : '';
      if (token && (!currentId || !leftoverId || leftoverId === currentId)) {
        current.directoryToken = token;
        merged.push('directoryToken');
      }
    }
    if (needName && validDirectoryAccountName(older.directoryAccountName)) {
      current.directoryAccountName = older.directoryAccountName;
      merged.push('directoryAccountName');
    }
    if (merged.includes('directoryToken') && current.rememberAccount === 'no') current.rememberAccount = 'yes';
    if ((!needId || validDirectoryUserId(current.directoryUserId)) && (!needToken || storedDirectoryToken(current.directoryToken))) break;
  }
  if (!merged.length) return [];
  try {
    durableReplace(target, JSON.stringify(current));
  } catch {
    return [];
  }
  return merged;
}

function looksLikeProfileAvatar(value) {
  return value === 'file:v1' || (typeof value === 'string' && value.length > 32 && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value));
}

function restoreMissingProfileAvatarSidecar(stableDir, candidateDirs) {
  if (!stableDir) return false;
  const dest = path.join(stableDir, 'profile-avatar');
  try {
    const st = fs.statSync(dest);
    if (st.isFile() && st.size > 16) return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  for (const dir of [...new Set((candidateDirs || []).filter(Boolean))]) {
    if (path.resolve(dir) === path.resolve(stableDir)) continue;
    const fromFile = path.join(dir, 'profile-avatar');
    try {
      const st = fs.statSync(fromFile);
      if (st.isFile() && st.size > 16) {
        fs.copyFileSync(fromFile, dest);
        try { fs.chmodSync(dest, 0o600); } catch {}
        return true;
      }
    } catch {}
    try {
      const older = parseSettings(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      if (typeof older.profileAvatar === 'string' && older.profileAvatar.startsWith('data:image/') && decodeProfileAvatarSidecar(Buffer.from(older.profileAvatar, 'utf8'))) {
        durableReplace(dest, older.profileAvatar);
        return true;
      }
    } catch {}
  }
  return false;
}

function decodeProfileAvatarSidecar(buf) {
  if (!buf || !buf.length) return null;
  const head = buf.toString('utf8', 0, Math.min(buf.length, 64));
  if (head.startsWith('data:image/')) {
    const text = buf.toString('utf8');
    const comma = text.indexOf(',');
    if (comma < 0) return null;
    const header = text.slice(0, comma).toLowerCase().replace(/\s+/g, '');
    const mimeMatch = header.match(/^data:(image\/(?:png|jpeg|gif|webp))(?:;charset=[^;]+)?;base64$/);
    if (!mimeMatch) return null;
    try {
      const buffer = Buffer.from(text.slice(comma + 1).replace(/\s+/g, ''), 'base64');
      if (!buffer.length) return null;
      return { mime: mimeMatch[1], buffer };
    } catch {
      return null;
    }
  }
  if (buf[0] === 0x89 && buf[1] === 0x50) return { mime: 'image/png', buffer: buf };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', buffer: buf };
  const gif = buf.slice(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return { mime: 'image/gif', buffer: buf };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', buffer: buf };
  return null;
}
function parseSettings(contents) { const parsed=JSON.parse(contents);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new SyntaxError('settings root must be an object');return parsed; }
async function readSettings(file) { return parseSettings(await fs.promises.readFile(file,'utf8')); }
async function syncDirectory(directory) { let handle;try{handle=await fs.promises.open(directory,'r');await handle.sync()}catch{}finally{await handle?.close().catch(()=>{})} }
async function durableWrite(file,contents){const handle=await fs.promises.open(file,'wx',0o600);try{await handle.writeFile(contents,'utf8');await handle.sync()}finally{await handle.close()}}
class SettingsStore {
  constructor(resolvePath,{writeDelayMs=8}={}){if(typeof resolvePath!=='function')throw new TypeError('resolvePath must be a function');this.resolvePath=resolvePath;this.writeDelayMs=Math.max(0,Math.min(1000,Number(writeDelayMs)||0));this.data=null;this.loadPromise=null;this.loadError=null;this.version=0;this.persistedVersion=0;this.attemptedVersion=0;this.writeTimer=null;this.writePromise=null;this.waiters=[]}
  async load(){if(this.data)return this.data;if(!this.loadPromise)this.loadPromise=(async()=>{const target=this.resolvePath(),backup=`${target}.bak`;try{this.data=await readSettings(target);return this.data}catch(primaryError){if(primaryError?.code!=='ENOENT'&&!(primaryError instanceof SyntaxError)){this.loadError=new Error('settings are unreadable',{cause:primaryError});this.data={};return this.data}try{this.data=await readSettings(backup);return this.data}catch(backupError){if(primaryError?.code==='ENOENT'&&backupError?.code==='ENOENT'){this.data={};return this.data}this.loadError=new Error('settings are unreadable or corrupt',{cause:primaryError});this.data={};return this.data}}})();return this.loadPromise}
  async get(key){const data=await this.load();return data[key]}
  async set(key,value){const data=await this.load();if(this.loadError)return false;if(value===undefined){if(!Object.hasOwn(data,key))return true;delete data[key]}else{if(data[key]===value)return true;data[key]=value}const version=++this.version,result=new Promise(resolve=>this.waiters.push({version,resolve}));this.scheduleWrite();return result}
  scheduleWrite(delay=this.writeDelayMs){if(this.writeTimer||this.writePromise)return;this.writeTimer=setTimeout(()=>{this.writeTimer=null;void this.flush()},delay)}
  async flush(){await this.load();if(this.loadError){this.resolveWaiters(this.version,false);return false}if(this.writeTimer){clearTimeout(this.writeTimer);this.writeTimer=null}if(this.writePromise){const requestedVersion=this.version;await this.writePromise;if(this.attemptedVersion<requestedVersion)return this.flush();return this.persistedVersion>=requestedVersion}if(this.persistedVersion>=this.version)return true;const version=this.version;this.attemptedVersion=version;const target=this.resolvePath(),directory=path.dirname(target),backup=`${target}.bak`,nonce=`${process.pid}.${Date.now()}`,temporary=`${target}.${nonce}.tmp`,backupTemporary=`${backup}.${nonce}.tmp`;let serialized;try{serialized=JSON.stringify(this.data)}catch{this.resolveWaiters(version,false);return false}this.writePromise=(async()=>{try{await fs.promises.mkdir(directory,{recursive:true,mode:0o700});await durableWrite(temporary,serialized);try{const previous=await fs.promises.readFile(target,'utf8');parseSettings(previous);await durableWrite(backupTemporary,previous);await fs.promises.rename(backupTemporary,backup)}catch(error){if(error?.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error}await fs.promises.rename(temporary,target);await fs.promises.chmod(target,0o600);await syncDirectory(directory);this.persistedVersion=Math.max(this.persistedVersion,version);this.resolveWaiters(version,true);return true}catch{await fs.promises.unlink(temporary).catch(()=>{});await fs.promises.unlink(backupTemporary).catch(()=>{});this.resolveWaiters(version,false);return false}finally{this.writePromise=null}})();const ok=await this.writePromise;if(this.version>version)this.scheduleWrite(0);return ok}
  resolveWaiters(version,result){const pending=[];for(const waiter of this.waiters){if(waiter.version<=version)waiter.resolve(result);else pending.push(waiter)}this.waiters=pending}
}
module.exports={SettingsStore,settingsObject,migrateSettingsCompanions,mergeMissingAccountIdentity,restoreMissingProfileAvatarSidecar,decodeProfileAvatarSidecar,looksLikeProfileAvatar,SETTINGS_COMPANION_FILES};
