const crypto = require('crypto');
const { put, del } = require('@vercel/blob');
const RU = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL, RT = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const fresh = () => ({ users: {}, tokens: {}, friends: [], reqs: [], msgs: [], stories: [], posts: [], follows: [], media: {}, fails: {}, codes: {}, secrets: [] });
let db = fresh(), ver = '0', dirty = false, pendDel = [], pendMail = [], pre = null, wantNews = '';
const save = () => { dirty = true; };
// ---- Redis (Upstash REST): the whole db lives in one key, with a version number to avoid lost updates ----
const FB_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyD0RHTyMNl9wQ3AzXCjyRfWVFmt9GKSKl8';
async function fbPhone(idToken) {
  let r, j;
  try { r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }); j = await r.json(); }
  catch (e) { throw Object.assign(new Error('ما كدرت أتصل بـ Firebase للتحقق من الكود: ' + e.message), { user: 1 }); }
  const u = r.ok && j.users && j.users[0];
  if (!u) throw Object.assign(new Error('كود التحقق غير صالح أو منتهي، اطلب كود جديد'), { user: 1, code: 401 });
  if (!u.phoneNumber) throw Object.assign(new Error('التحقق ما كان برقم هاتف'), { user: 1, code: 403 });
  if (Date.now() - Number(u.lastLoginAt || 0) > 6e5) throw Object.assign(new Error('انتهت صلاحية الكود، اطلب كود جديد'), { user: 1, code: 401 });
  return u.phoneNumber;
}
const dbErr = m => Object.assign(new Error(m), { user: 1 });
// ---- verified accounts: OFFICIAL_USER (the NONO account) + VERIFIED_USERS (comma separated usernames) ----
const VER = new Set([process.env.OFFICIAL_USER, ...String(process.env.VERIFIED_USERS || '').split(',')].map(x => String(x || '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
const isV = u => VER.has(u);
// ---- story text styling ----
const FONTS = ['Cairo', 'Tajawal', 'Amiri', 'Lalezar', 'Reem Kufi', 'Aref Ruqaa', 'Pacifico', 'Bebas Neue', 'Lobster', 'Playfair Display', 'Oswald'];
const stIn = o => {
  if (!o || typeof o !== 'object') return null;
  const n = (v, a, b, d) => { v = +v; return isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
  return { x: n(o.x, 0, 100, 50), y: n(o.y, 0, 100, 50), sz: n(o.sz, 3, 20, 8), c: /^#[0-9a-f]{6}$/i.test(String(o.c)) ? String(o.c) : '#ffffff', f: FONTS.includes(String(o.f)) ? String(o.f) : '', bg: o.bg === 1 ? 1 : 0 };
};
// ---- regional news (NewsData.io: NEWS_API_KEY) cached 30 min per country ----
const NEWS_TTL = 30 * 60 * 1000;
const ARAB = new Set(['iq', 'sa', 'ae', 'eg', 'kw', 'qa', 'bh', 'om', 'jo', 'lb', 'sy', 'ye', 'ly', 'tn', 'dz', 'ma', 'sd', 'ps']);
async function fetchNews(cc) {
  const key = process.env.NEWS_API_KEY;
  if (!key) throw dbErr('الأخبار غير مفعّلة بعد: أضف NEWS_API_KEY بإعدادات فيرسل ثم Redeploy');
  let r, j;
  try {
    r = await fetch('https://newsdata.io/api/1/latest?apikey=' + encodeURIComponent(key) + '&country=' + cc + (ARAB.has(cc) ? '&language=ar' : '') + '&removeduplicate=1');
    j = await r.json();
  } catch (e) { throw dbErr('ما كدرت أتصل بمزود الأخبار: ' + e.message); }
  if (!r.ok || !Array.isArray(j.results)) throw dbErr('مزود الأخبار رفض الطلب: ' + ((j && j.results && j.results.message) || (j && j.message) || r.status));
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  return j.results.map(x => {
    const url = /^https?:\/\//.test(x.link || '') ? x.link : '', title = clean(x.title).slice(0, 160);
    let sum = clean(x.description); if (/ONLY AVAILABLE/i.test(sum)) sum = '';
    const t = Date.parse(String(x.pubDate || '').replace(' ', 'T') + 'Z');
    return { id: crypto.createHash('sha1').update(url || title).digest('hex').slice(0, 12), title, summary: sum.slice(0, 220), src: clean(x.source_name || x.source_id).slice(0, 40), url, time: isFinite(t) ? t : Date.now() };
  }).filter(a => a.title && a.url);
}
// ---- email codes (Brevo transactional API: BREVO_API_KEY + MAIL_FROM = a sender you verified in Brevo) ----
async function sendMail(m) {
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) throw dbErr('إرسال البريد غير مفعّل بالسيرفر: أضف BREVO_API_KEY و MAIL_FROM بإعدادات فيرسل ثم Redeploy');
  let r;
  try {
    r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: 'NONO', email: from }, to: [{ email: m.to }], subject: m.subject, htmlContent: '<div dir="rtl" style="font-family:Arial,sans-serif;text-align:center;padding:20px"><h2>NONO</h2><p>' + m.subject + '</p><p style="font-size:34px;letter-spacing:8px;font-weight:bold;margin:18px 0">' + m.code + '</p><p style="color:#666">الكود صالح 10 دقايق. إذا ما طلبته أنت تجاهل هالرسالة.</p></div>' }) });
  } catch (e) { throw dbErr('ما كدرت أتصل بخدمة البريد: ' + e.message); }
  if (!r.ok) { let t = ''; try { t = (await r.json()).message; } catch {} throw dbErr('فشل إرسال البريد: ' + (t || r.status)); }
}
async function rcmd(p, body) {
  let r, j;
  try { r = await fetch(RU + p, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(body) }); }
  catch (e) { throw dbErr('ما كدرت أتصل بقاعدة البيانات (Upstash Redis): ' + e.message); }
  try { j = await r.json(); } catch { throw dbErr('قاعدة البيانات رجعت رد غير مفهوم (كود ' + r.status + ')'); }
  if (r.status === 401 || r.status === 403) throw dbErr('مفتاح قاعدة البيانات غلط أو منتهي (Upstash token). أعد ربط Redis من Storage بفيرسل ثم Redeploy');
  if (!r.ok || j.error) throw dbErr('خطأ من قاعدة البيانات: ' + (j.error || r.status));
  return j;
}
async function load() { const j = await rcmd('/pipeline', [['GET', 'nono:db'], ['GET', 'nono:ver']]); db = Object.assign(fresh(), j[0].result ? JSON.parse(j[0].result) : {}); if (j[0].error || j[1].error) throw dbErr('خطأ من قاعدة البيانات: ' + (j[0].error || j[1].error)); ver = j[1].result || '0'; dirty = false; }
async function commit() { const v = ver, d = JSON.stringify(db); const j = await rcmd('', ['EVAL', "if (redis.call('GET',KEYS[2]) or '0')==ARGV[2] then redis.call('SET',KEYS[1],ARGV[1]) redis.call('INCR',KEYS[2]) return 1 end return 0", '2', 'nono:db', 'nono:ver', d, v]); return j.result === 1; }
const mkRes = () => { const r = { statusCode: 200, h: {}, body: '', headersSent: false, setHeader(k, v) { r.h[k] = v; }, writeHead(c, h) { r.statusCode = c; Object.assign(r.h, h); }, end(b) { r.body = b === undefined ? '' : b; } }; return r; };
const fin = (res, r) => { res.statusCode = r.statusCode; for (const k in r.h) res.setHeader(k, r.h[k]); res.end(r.body); };
const rbuf = async req => { if (Buffer.isBuffer(req.body)) return req.body; if (typeof req.body === 'string') return Buffer.from(req.body); if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body)); const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const S = s => String(s == null ? '' : s).trim();
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const live = s => Date.now() - s.time < 864e5;
const MT = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video', 'audio/mp4': 'audio', 'audio/x-m4a': 'audio', 'audio/aac': 'audio', 'audio/mpeg': 'audio', 'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/wav': 'audio', 'application/pdf': 'file', 'application/msword': 'file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file', 'application/vnd.ms-excel': 'file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file', 'application/vnd.ms-powerpoint': 'file', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'file', 'text/plain': 'file', 'application/zip': 'file' };
const owned = (me, id) => { const m = db.media[S(id)]; return m && m.un === me ? m : null; };
const rmMedia = id => { const m = db.media[id]; if (!m) return; delete db.media[id]; if (m.url) pendDel.push(m.url); };
const prune = () => { db.stories.filter(s => !live(s)).forEach(s => s.m && rmMedia(s.m)); db.stories = db.stories.filter(live); save(); };
const send = (res, c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
const err = (res, m, c = 400) => send(res, c, { error: m });
const phoneOf = s => {
  let d = S(s).replace(/[\s\-()]/g, '');
  if (!/^\+?\d{8,15}$/.test(d)) return null;
  if (d[0] === '+') return d;
  if (/^964\d{9,10}$/.test(d)) return '+' + d;
  return '+964' + d.replace(/^0+/, '');
};
const maskE = e => { const [a, d] = String(e).split('@'); return a.slice(0, 2) + '***@' + d; };
function issueCode(key, to, subject) {
  db.codes = db.codes || {}; const now = Date.now();
  for (const k in db.codes) if (db.codes[k].exp < now) delete db.codes[k];
  const c = db.codes[key]; if (c && now - c.t < 6e4) return false;
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  db.codes[key] = { h: hash(code, key), exp: now + 6e5, n: 0, t: now };
  pendMail.push({ to, subject, code }); save(); return true;
}
function checkCode(key, code) {
  const c = db.codes && db.codes[key];
  if (!c || c.exp < Date.now()) return 'الكود منتهي أو ما انطلب، اطلب كود جديد';
  if (c.n >= 5) { delete db.codes[key]; save(); return 'محاولات كثيرة، اطلب كود جديد'; }
  if (hash(S(code), key) !== c.h) { c.n++; save(); return 'الكود غلط'; }
  delete db.codes[key]; save(); return '';
}
const find = id => {
  id = S(id).toLowerCase().replace(/^@/, '');
  if (/^\S+@\S+\.\S+$/.test(id)) { const l = Object.values(db.users).filter(u => String(u.email || '').toLowerCase() === id); return l.find(u => u.emailV) || l[0]; }
  if (!/[a-z]/.test(id)) { const p = phoneOf(id); return p && Object.values(db.users).find(u => u.phone === p); }
  return db.users[id];
};
const isF = (a, b) => db.friends.some(f => (f[0] === a && f[1] === b) || (f[0] === b && f[1] === a));
const hasReq = (a, b) => db.reqs.findIndex(r => r.from === a && r.to === b);
const rel = (a, b) => isF(a, b) ? 'friend' : hasReq(a, b) >= 0 ? 'sent' : hasReq(b, a) >= 0 ? 'got' : 'none';
const nm = u => (db.users[u] || {}).name || u;
const av = u => (db.users[u] || {}).avt || 0;
const setg = u => { const s = (db.users[u] || {}).set || {}; return { n: Object.assign({ msg: 1, post: 1, story: 1, req: 1 }, s.n || {}), priv: s.priv ? 1 : 0, noreq: s.noreq ? 1 : 0 }; };
const canSee = (v, o) => v === o || !setg(o).priv || isF(v, o);
const isFol = (a, b) => db.follows.some(f => f[0] === a && f[1] === b);
// ---- صندوق الأسرار: الهوية تتخزن سراً بالسيرفر (s.un) وما تنرسل لأي مستخدم أبداً ----
const SEC_LIMIT = +process.env.SECRET_REPORT_LIMIT || 5;
const secLive = s => !s.hidden && (!s.exp || Date.now() < s.exp);
const secOK = (v, s) => s.un === v || s.aud === 'public' || (s.aud === 'friends' && isF(v, s.un)) || (s.aud === 'followers' && (isFol(v, s.un) || isF(v, s.un)));
const secOut = (s, me) => ({ id: s.id, time: s.time, exp: s.exp || 0, aud: s.aud, text: s.text, m: s.m || '', k: s.k || '', likes: s.likes.length, liked: s.likes.includes(me), cc: s.cm.filter(c => !c.hidden).length, mine: s.un === me });
const storyOK = (s, v) => {
  if (s.un === v) return true; if (!canSee(v, s.un)) return false;
  if (s.vis === 'friends') return isF(v, s.un);
  if (s.vis === 'only') return (s.to || []).includes(v);
  if (s.vis === 'followers') return isFol(v, s.un) || isF(v, s.un);
  return true;
};
const cnt = u => ({ posts: db.posts.filter(p => p.un === u).length, friends: db.friends.filter(f => f[0] === u || f[1] === u).length, followers: db.follows.filter(f => f[1] === u).length, following: db.follows.filter(f => f[0] === u).length });
const pv = (p, me) => ({ id: p.id, un: p.un, name: nm(p.un), av: av(p.un), v: isV(p.un) ? 1 : 0, text: p.text, img: !!(p.img || p.m), time: p.time, likes: p.likes.length, liked: p.likes.includes(me), cc: p.cm.length, saved: ((db.users[me] || {}).saves || []).includes(p.id), me: p.un === me, cat: p.cat || 'pub' });
const person = (u, me) => ({ un: u, name: nm(u), av: av(u), v: isV(u) ? 1 : 0, rel: rel(me, u), following: isFol(me, u) });
const imgOK = s => /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 5e5;
const sv = (s, me) => ({ id: s.id, un: s.un, name: nm(s.un), av: av(s.un), v: isV(s.un) ? 1 : 0, st: s.st || null, text: s.text || (s.m ? (s.k === 'video' ? '🎥 فيديو' : '📷 صورة') : ''), cap: s.text, m: s.m || '', k: s.k || '', color: s.color, time: s.time, me: s.un === me, likes: (s.likes || []).length, liked: (s.likes || []).includes(me), views: s.un === me ? (s.views || []).length : 0 });
const notify = (to, type, from, text) => {
  if (to === from || !db.users[to] || !setg(to).n[type]) return;
  db.notifs = db.notifs || [];
  db.notifs.push({ id: crypto.randomBytes(4).toString('hex'), to, type, from, text, time: Date.now(), r: 0 });
  if (db.notifs.length > 2000) db.notifs = db.notifs.slice(-1500);
};
function rename(o, n) {
  const u = db.users[o]; delete db.users[o]; u.un = n; db.users[n] = u;
  for (const t in db.tokens) if (db.tokens[t] === o) db.tokens[t] = n;
  const pair = f => { if (f[0] === o) f[0] = n; if (f[1] === o) f[1] = n; };
  db.friends.forEach(pair); db.follows.forEach(pair);
  db.reqs.forEach(r => { if (r.from === o) r.from = n; if (r.to === o) r.to = n; });
  db.msgs.forEach(x => { if (x.from === o) x.from = n; if (x.to === o) x.to = n; });
  const lk = a => (a || []).map(x => x === o ? n : x);
  db.stories.forEach(s => { if (s.un === o) s.un = n; s.likes = lk(s.likes); });
  db.posts.forEach(p => { if (p.un === o) p.un = n; p.likes = lk(p.likes); p.cm.forEach(c => { if (c.un === o) c.un = n; }); });
  (db.notifs || []).forEach(x => { if (x.to === o) x.to = n; if (x.from === o) x.from = n; });
  db.secrets.forEach(s => { if (s.un === o) s.un = n; s.likes = lk(s.likes); s.rep = lk(s.rep); s.cm.forEach(c => { if (c.un === o) c.un = n; c.rep = lk(c.rep); }); if (s.anon[o]) { s.anon[n] = s.anon[o]; delete s.anon[o]; } });
}
const login = (res, un) => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = un; save(); send(res, 200, { token: t }); };

function serveMedia(req, res, id) {
  const md = db.media[S(id)];
  if (!md || !md.url) { res.statusCode = 404; return res.end(); }
  res.writeHead(302, { Location: md.url, 'Cache-Control': 'private, max-age=3600' }); res.end();
}
async function upload(req, res) {
  const r = mkRes();
  await load();
  const tk = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1], m = tk && db.users[db.tokens[tk]];
  if (!m) { err(r, 'سجّل دخول', 401); return fin(res, r); }
  const mime = S(req.headers['content-type']).split(';')[0].toLowerCase(), kind = MT[mime];
  if (!kind) { err(r, 'نوع الملف غير مدعوم'); return fin(res, r); }
  const buf = await rbuf(req);
  if (!buf.length) { err(r, 'ملف فارغ'); return fin(res, r); }
  if (buf.length > 4.4e6) { err(r, 'الملف كبير، الحد 4 ميغا', 413); return fin(res, r); }
  const id = crypto.randomBytes(12).toString('hex');
  if (!process.env.BLOB_READ_WRITE_TOKEN) { err(r, 'مخزن الملفات (Blob) غير مربوط. أضفه من Storage بفيرسل ثم Redeploy', 503); return fin(res, r); }
  let url;
  try { url = (await put('m/' + id, buf, { access: 'public', contentType: mime, addRandomSuffix: false })).url; }
  catch (e) { err(r, 'فشل حفظ الملف بمخزن Blob: ' + e.message, 502); return fin(res, r); }
  for (let i = 0; i < 6; i++) { await load(); db.media[id] = { un: m.un, mime, kind, name: (() => { try { return decodeURIComponent(S(req.headers['x-filename'])).slice(0, 80); } catch (e) { return ''; } })(), time: Date.now(), size: buf.length, url }; if (await commit()) break; }
  send(r, 200, { id, kind, mime }); fin(res, r);
}

function route(req, res, P, u, b) {
  const K = req.method + ' ' + P;
  if (K === 'POST /api/check') return send(res, 200, { exists: !!find(b.id), phone: !/[a-z]/i.test(S(b.id)) });
  if (K === 'POST /api/signup') {
    const raw = S(b.contact || b.phone), isE = raw.includes('@'), un = S(b.username).toLowerCase().replace(/^@/, ''), pw = S(b.password);
    if (!/^(?=.*[a-z])[a-z0-9_.]{3,20}$/.test(un)) return err(res, 'اليوزر: 3 إلى 20 خانة، حروف إنجليزية وأرقام و _ و .');
    if (pw.length < 6) return err(res, 'كلمة السر لازم 6 خانات على الأقل');
    if (!isE) return err(res, 'التسجيل بالبريد الإلكتروني فقط');
    if (db.users[un]) return err(res, 'هذا اليوزر مأخوذ، اختر غيره', 409);
    const salt = crypto.randomBytes(16).toString('hex'), name = S(b.name).slice(0, 40) || un;
    if (isE) {
      const em = raw.toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(em)) return err(res, 'البريد الإلكتروني غير صحيح');
      if (Object.values(db.users).some(x => x.emailV && String(x.email).toLowerCase() === em)) return err(res, 'هذا البريد مسجل من قبل', 409);
      const key = 'signup:' + em;
      if (!b.emailCode) {
        if (!issueCode(key, em, 'كود تأكيد حسابك في NONO')) return err(res, 'انتظر دقيقة قبل ما تطلب كود جديد', 429);
        return send(res, 200, { ecode: 1, email: em });
      }
      const bad = checkCode(key, b.emailCode); if (bad) return err(res, bad, 401);
      db.users[un] = { un, name, phone: '', email: em, emailV: 1, salt, hash: hash(pw, salt), created: Date.now() };
      return login(res, un);
    }
    const ph = phoneOf(raw), em = S(b.email).toLowerCase();
    if (!ph) return err(res, 'رقم الهاتف غير صحيح');
    if (em && !/^\S+@\S+\.\S+$/.test(em)) return err(res, 'البريد الإلكتروني غير صحيح');
    if (Object.values(db.users).some(x => x.phone === ph)) return err(res, 'هذا الرقم مسجل من قبل', 409);
    if (b.fbPhone !== ph) return b.fbPhone ? err(res, 'الرقم اللي تحققت منه غير الرقم المكتوب', 403) : send(res, 200, { otp: 1, phone: ph });
    db.users[un] = { un, name, phone: ph, email: em, emailV: 0, salt, hash: hash(pw, salt), created: Date.now() };
    return login(res, un);
  }
  if (K === 'POST /api/forgot') {
    const raw = S(b.id), f = find(raw);
    if (!f) return err(res, 'ما في حساب بهذا اليوزر أو الرقم أو البريد', 404);
    const typedPhone = !/[a-z@]/i.test(raw);
    const via = typedPhone ? (f.phone ? 'phone' : null) : raw.includes('@') ? 'email' : f.email ? 'email' : f.phone ? 'phone' : null;
    if (!via) return err(res, 'هذا الحساب ما عنده رقم أو بريد للاستعادة');
    if (via === 'phone') return send(res, 200, { via, phone: f.phone });
    if (!issueCode('reset:' + f.un, f.email, 'كود استعادة كلمة السر')) return err(res, 'انتظر دقيقة قبل ما تطلب كود جديد', 429);
    return send(res, 200, { via, to: maskE(f.email) });
  }
  if (K === 'POST /api/reset') {
    const f = find(b.id), pw = S(b.password);
    if (!f) return err(res, 'ما في حساب بهذا اليوزر أو الرقم أو البريد', 404);
    if (pw.length < 6) return err(res, 'كلمة السر لازم 6 خانات على الأقل');
    if (b.fbPhone) { if (!f.phone || b.fbPhone !== f.phone) return err(res, 'الرقم اللي تحققت منه غير رقم الحساب', 403); }
    else { if (!S(b.code)) return err(res, 'اكتب كود التحقق'); const bad = f.email ? checkCode('reset:' + f.un, b.code) : 'ما في بريد لهذا الحساب'; if (bad) return err(res, bad, 401); }
    f.salt = crypto.randomBytes(16).toString('hex'); f.hash = hash(pw, f.salt);
    for (const t in db.tokens) if (db.tokens[t] === f.un) delete db.tokens[t];
    delete db.fails[S(b.id).toLowerCase()]; delete db.fails[f.un];
    return login(res, f.un);
  }
  if (K === 'POST /api/login') {
    const f = find(b.id), k = S(b.id).toLowerCase(), x = db.fails[k] || { n: 0, t: 0 };
    if (x.n >= 5 && Date.now() - x.t < 6e5) return err(res, 'محاولات كثيرة، جرّب بعد 10 دقايق', 429);
    if (!f) { db.fails[k] = { n: x.n + 1, t: Date.now() }; save(); return err(res, 'ما في حساب بهذا اليوزر أو البريد', 404); }
    if (hash(S(b.password), f.salt) !== f.hash) { db.fails[k] = { n: x.n + 1, t: Date.now() }; save(); return err(res, 'كلمة السر غلط', 401); }
    delete db.fails[k]; return login(res, f.un);
  }
  if (K === 'GET /api/avatar') {
    const x = db.users[S(u.searchParams.get('u'))];
    if (!x || !x.avatar) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(x.avatar.split(',')[1], 'base64'));
  }
  if (K === 'GET /api/img') {
    const p = db.posts.find(x => x.id === S(u.searchParams.get('id')));
    if (p && p.m) return serveMedia(req, res, p.m);
    if (!p || !p.img) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(p.img.split(',')[1], 'base64'));
  }
  if (K === 'GET /api/m') return serveMedia(req, res, S(u.searchParams.get('id')));
  const tk = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const m = tk && db.users[db.tokens[tk]];
  if (!m) return err(res, 'سجّل دخول', 401);
  const me = m.un;
  if (K === 'GET /api/me') return send(res, 200, { un: me, name: m.name, phone: m.phone || '', email: m.email || '', emailV: m.emailV ? 1 : 0, bio: m.bio || '', av: m.avt || 0, set: setg(me), counts: cnt(me) });
  if (K === 'POST /api/me') {
    let nu = me;
    if (b.username !== undefined) {
      const x = S(b.username).toLowerCase().replace(/^@/, '');
      if (x !== me) {
        if (!/^(?=.*[a-z])[a-z0-9_.]{3,20}$/.test(x)) return err(res, 'اليوزر: 3 إلى 20 خانة، حروف إنجليزية وأرقام و _ و .');
        if (db.users[x]) return err(res, 'هذا اليوزر غير متاح أو محجوز', 409);
        nu = x;
      }
    }
    const em = b.email !== undefined ? S(b.email) : m.email;
    if (em && !/^\S+@\S+\.\S+$/.test(em)) return err(res, 'البريد الإلكتروني غير صحيح');
    if (b.avatar && !imgOK(b.avatar)) return err(res, 'الصورة غير صالحة');
    if (b.name !== undefined) m.name = S(b.name).slice(0, 40) || nu;
    if (b.bio !== undefined) m.bio = S(b.bio).slice(0, 150);
    if (em.toLowerCase() !== String(m.email || '').toLowerCase()) m.emailV = 0;
    m.email = em.toLowerCase();
    if (b.avatar) { m.avatar = b.avatar; m.avt = Date.now(); }
    if (b.removeAvatar) { delete m.avatar; m.avt = 0; }
    if (nu !== me) rename(me, nu);
    save(); return send(res, 200, { ok: 1, un: nu });
  }
  if (K === 'POST /api/logout') { delete db.tokens[tk]; save(); return send(res, 200, { ok: 1 }); }
  if (K === 'GET /api/search') {
    const q = S(u.searchParams.get('q')).toLowerCase().replace(/^@/, '');
    if (!q) return send(res, 200, { users: [], stories: [] });
    const ph = /[a-z]/.test(q) ? null : phoneOf(q);
    const users = Object.values(db.users).filter(x => x.un !== me && (x.un.includes(q) || x.name.toLowerCase().includes(q) || (ph && x.phone === ph))).slice(0, 20).map(x => person(x.un, me));
    const stories = db.stories.filter(s => live(s) && canSee(me, s.un) && s.text.toLowerCase().includes(q)).slice(-20).reverse().map(s => sv(s, me));
    const posts = db.posts.filter(p => canSee(me, p.un) && p.text.toLowerCase().includes(q)).slice(-20).reverse().map(p => ({ id: p.id, un: p.un, name: nm(p.un), av: av(p.un), text: p.text }));
    return send(res, 200, { users, stories, posts });
  }
  if (K === 'GET /api/stories') return send(res, 200, db.stories.filter(s => live(s) && storyOK(s, me)).reverse().map(s => sv(s, me)));
  if (K === 'POST /api/stories') {
    const text = S(b.text).slice(0, 200);
    const md = b.media && owned(me, b.media);
    if (b.media && !md) return err(res, 'الملف غير صالح');
    if (!text && !md) return err(res, 'اكتب شي أو أضف صورة');
    const color = /^#[0-9a-f]{6}$/i.test(S(b.color)) ? S(b.color) : '#E11D32';
    const vis = ['followers', 'friends', 'only'].includes(S(b.vis)) ? S(b.vis) : 'followers';
    const to = vis === 'only' ? (Array.isArray(b.to) ? b.to : []).map(S).filter(x => db.users[x] && x !== me).slice(0, 100) : [];
    if (vis === 'only' && !to.length) return err(res, 'اختر شخص واحد على الأقل');
    db.stories.push({ id: crypto.randomBytes(6).toString('hex'), un: me, text, color, st: text ? stIn(b.st) : null, m: md ? b.media : '', k: md ? md.kind : '', time: Date.now(), vis, to });
    prune(); return send(res, 200, { ok: 1 });
  }
  if (K === 'POST /api/stories/delete') { const dx = db.stories.find(s => s.id === b.id && s.un === me); if (dx && dx.m) rmMedia(dx.m); db.stories = db.stories.filter(s => !(s.id === b.id && s.un === me)); save(); return send(res, 200, { ok: 1 }); }
  if (K === 'GET /api/reqs') return send(res, 200, {
    in: db.reqs.filter(r => r.to === me).map(r => ({ un: r.from, name: nm(r.from), av: av(r.from) })),
    out: db.reqs.filter(r => r.from === me).map(r => ({ un: r.to, name: nm(r.to), av: av(r.to) }))
  });
  if (K === 'POST /api/req') {
    const f = find(b.to);
    if (!f) return err(res, 'ما لقينا هذا الحساب');
    if (f.un === me) return err(res, 'هذا حسابك أنت 😄');
    if (setg(f.un).noreq && hasReq(f.un, me) < 0) return err(res, 'هذا الحساب لا يستقبل طلبات صداقة');
    if (isF(me, f.un)) return err(res, 'هو صديقك من قبل');
    if (hasReq(me, f.un) >= 0) return err(res, 'أرسلت له طلب من قبل');
    const i = hasReq(f.un, me);
    if (i >= 0) { db.reqs.splice(i, 1); db.friends.push([f.un, me]); }
    else { db.reqs.push({ from: me, to: f.un }); notify(f.un, 'req', me, 'أرسل لك طلب صداقة'); }
    save(); return send(res, 200, { ok: 1 });
  }
  if (K === 'POST /api/req/accept') {
    const i = hasReq(S(b.from), me);
    if (i < 0) return err(res, 'الطلب غير موجود');
    db.reqs.splice(i, 1); db.friends.push([S(b.from), me]); notify(S(b.from), 'req', me, 'قبل طلب صداقتك'); save(); return send(res, 200, { ok: 1 });
  }
  if (K === 'POST /api/req/reject') { const i = hasReq(S(b.from), me); if (i >= 0) db.reqs.splice(i, 1); save(); return send(res, 200, { ok: 1 }); }
  if (K === 'POST /api/req/cancel') { const i = hasReq(me, S(b.to)); if (i >= 0) db.reqs.splice(i, 1); save(); return send(res, 200, { ok: 1 }); }
  if (K === 'GET /api/chats') {
    const out = db.friends.filter(f => f[0] === me || f[1] === me).map(f => {
      const o = f[0] === me ? f[1] : f[0];
      const ms = db.msgs.filter(x => ((x.from === me && x.to === o) || (x.from === o && x.to === me)) && !(x.hid && x.hid.includes(me)));
      const l = ms[ms.length - 1];
      return { un: o, name: nm(o), av: av(o), last: l ? (l.text || (l.st ? 'ملصق' : l.k === 'video' ? '🎥 فيديو' : l.k === 'audio' ? '🎤 رسالة صوتية' : l.k === 'file' ? '📎 ' + (l.fn || 'ملف') : '📷 صورة')).slice(0, 60) : '', time: l ? l.time : 0, unread: ms.filter(x => x.from === o && !x.r).length, blocked: (db.blocks || []).some(x => x[0] === me && x[1] === o) ? 1 : 0 };
    });
    return send(res, 200, out.sort((a, c) => c.time - a.time));
  }
  if (K === 'GET /api/msgs') {
    const o = S(u.searchParams.get('with'));
    if (!isF(me, o)) return err(res, 'ما بينكم صداقة', 403);
    let ch = false;
    const ms = db.msgs.filter(x => ((x.from === me && x.to === o) || (x.from === o && x.to === me)) && !(x.hid && x.hid.includes(me)));
    ms.forEach(x => { if (x.to === me && !x.r) { x.r = 1; ch = true; } });
    if (ch) save();
    return send(res, 200, ms.slice(-200).map(x => ({ from: x.from, text: x.text, m: x.m || '', k: x.k || '', st: x.st || '', fn: x.fn || '', r: x.r ? 1 : 0, time: x.time })));
  }
  if (K === 'POST /api/send') {
    const to = S(b.to), text = S(b.text).slice(0, 500);
    const md = b.media && owned(me, b.media), stk = /^\d{1,2}$/.test(S(b.sticker)) && +b.sticker < 12 ? S(b.sticker) : '';
    if (b.media && !md) return err(res, 'الملف غير صالح');
    if (!text && !md && !stk) return err(res, 'الرسالة فارغة');
    if (!isF(me, to)) return err(res, 'لازم يوافق على طلبك أول', 403);
    if ((db.blocks || []).some(x => (x[0] === me && x[1] === to) || (x[0] === to && x[1] === me))) return err(res, 'ما تكدر ترسل لهذا الشخص', 403);
    db.msgs.push({ from: me, to, text, fn: md ? (md.name || '') : '', m: md ? b.media : '', k: md ? md.kind : '', st: stk, time: Date.now(), r: 0 }); save(); return send(res, 200, { ok: 1 });
  }
  const ok = () => send(res, 200, { ok: 1 });
  const vp = id => { const p = db.posts.find(x => x.id === S(id)); return p && canSee(me, p.un) ? p : null; };
  const rid = () => crypto.randomBytes(6).toString('hex');
  if (K === 'GET /api/avail') {
    const x = S(u.searchParams.get('u')).toLowerCase().replace(/^@/, '');
    if (x === me) return send(res, 200, { ok: true });
    if (!/^(?=.*[a-z])[a-z0-9_.]{3,20}$/.test(x)) return send(res, 200, { ok: false, why: 'format' });
    return send(res, 200, db.users[x] ? { ok: false, why: 'taken' } : { ok: true });
  }
  if (K === 'POST /api/me/phone') {
    const ph = phoneOf(b.phone);
    if (!ph) return err(res, 'رقم الهاتف غير صحيح');
    if (hash(S(b.password), m.salt) !== m.hash) return err(res, 'كلمة السر غير صحيحة', 401);
    if (Object.values(db.users).some(x => x.phone === ph && x.un !== me)) return err(res, 'هذا الرقم مسجل بحساب ثاني', 409);
    m.phone = ph; save(); return ok();
  }
  if (K === 'POST /api/me/password') {
    if (hash(S(b.old), m.salt) !== m.hash) return err(res, 'كلمة السر الحالية غير صحيحة', 401);
    if (S(b.new).length < 6) return err(res, 'كلمة السر الجديدة لازم 6 خانات على الأقل');
    m.salt = crypto.randomBytes(16).toString('hex'); m.hash = hash(S(b.new), m.salt); save(); return ok();
  }
  if (K === 'POST /api/me/settings') {
    const s = setg(me);
    ['msg', 'post', 'story', 'req'].forEach(k => { if (b.n && k in b.n) s.n[k] = b.n[k] ? 1 : 0; });
    if ('priv' in b) s.priv = b.priv ? 1 : 0;
    if ('noreq' in b) s.noreq = b.noreq ? 1 : 0;
    m.set = s; save(); return ok();
  }
  if (K === 'POST /api/logout/all') { for (const t in db.tokens) if (db.tokens[t] === me && t !== tk) delete db.tokens[t]; save(); return ok(); }
  if (K === 'GET /api/user') {
    const x = db.users[S(u.searchParams.get('u')).toLowerCase()];
    if (!x) return err(res, 'ما لقينا الحساب', 404);
    const see = canSee(me, x.un);
    return send(res, 200, Object.assign(person(x.un, me), { bio: x.bio || '', priv: !see, counts: cnt(x.un), posts: see ? db.posts.filter(p => p.un === x.un).reverse().map(p => pv(p, me)) : [] }));
  }
  if (K === 'GET /api/people') {
    const t = S(u.searchParams.get('type'));
    const l = t === 'friends' ? db.friends.filter(f => f[0] === me || f[1] === me).map(f => f[0] === me ? f[1] : f[0])
      : t === 'followers' ? db.follows.filter(f => f[1] === me).map(f => f[0])
      : db.follows.filter(f => f[0] === me).map(f => f[1]);
    return send(res, 200, l.filter(x => db.users[x]).map(x => person(x, me)));
  }
  if (K === 'POST /api/follow') {
    const t = S(b.to).toLowerCase();
    if (!db.users[t] || t === me) return err(res, 'حساب غير صحيح');
    const i = db.follows.findIndex(f => f[0] === me && f[1] === t);
    if (i >= 0) db.follows.splice(i, 1); else db.follows.push([me, t]);
    if (i < 0) notify(t, 'req', me, 'بدأ يتابعك');
    save(); return send(res, 200, { following: i < 0 });
  }
  if (K === 'POST /api/followers/remove') { db.follows = db.follows.filter(f => !(f[0] === S(b.from) && f[1] === me)); save(); return ok(); }
  if (K === 'POST /api/block') { const t = S(b.to); db.blocks = (db.blocks || []).filter(x => !(x[0] === me && x[1] === t)); if (b.on) db.blocks.push([me, t]); save(); return ok(); }
  if (K === 'POST /api/chat/delete') { const o = S(b.with); db.msgs.forEach(x => { if (((x.from === me && x.to === o) || (x.from === o && x.to === me)) && !(x.hid && x.hid.includes(me))) x.hid = (x.hid || []).concat(me); }); save(); return ok(); }
  if (K === 'POST /api/unfriend') { const t = S(b.to); db.friends = db.friends.filter(f => !((f[0] === me && f[1] === t) || (f[0] === t && f[1] === me))); save(); return ok(); }
  if (K === 'GET /api/trend') {
    const n = Date.now(), bl = db.blocks || [];
    const l = db.posts.filter(p => p.cat !== 'local' && n - p.time < 12096e5 && canSee(me, p.un) && !bl.some(x => (x[0] === me && x[1] === p.un) || (x[0] === p.un && x[1] === me)))
      .map(p => [p, p.likes.length * 2 + p.cm.length * 3 + (n - p.time < 864e5 ? 3 : 0)]).sort((a, b) => b[1] - a[1] || b[0].time - a[0].time).slice(0, 30);
    return send(res, 200, l.map(x => pv(x[0], me)));
  }
  if (K === 'GET /api/local') {
    const lq = S(u.searchParams.get('cc')).toLowerCase(), n = Date.now(), bl = db.blocks || [];
    const lcc = /^[a-z]{2}$/.test(lq) ? lq : (/^[a-z]{2}$/i.test(S(req.headers['x-vercel-ip-country'])) ? S(req.headers['x-vercel-ip-country']).toLowerCase() : 'iq');
    const l = db.posts.filter(p => p.cat === 'local' && p.cc === lcc && n - p.time < 6048e5 && canSee(me, p.un) && !bl.some(x => (x[0] === me && x[1] === p.un) || (x[0] === p.un && x[1] === me)))
      .sort((a, b) => b.time - a.time).slice(0, 30);
    return send(res, 200, { cc: lcc, items: l.map(p => pv(p, me)) });
  }
  if (K === 'GET /api/posts') {
    const okSet = new Set([me, ...db.friends.filter(f => f[0] === me || f[1] === me).map(f => f[0] === me ? f[1] : f[0]), ...db.follows.filter(f => f[0] === me).map(f => f[1])]);
    return send(res, 200, db.posts.filter(p => okSet.has(p.un) && canSee(me, p.un)).slice(-60).reverse().map(p => pv(p, me)));
  }
  if (K === 'POST /api/posts') {
    const text = S(b.text).slice(0, 500), img = S(b.image);
    const pm = b.media && owned(me, b.media);
    if (b.media && (!pm || pm.kind !== 'image')) return err(res, 'الصورة غير صالحة');
    if (!text && !img && !pm) return err(res, 'اكتب شي أو أضف صورة');
    if (img && !imgOK(img)) return err(res, 'الصورة غير صالحة');
    const pcat = b.cat === 'local' ? 'local' : 'pub', pq = S(b.cc).toLowerCase();
    const pcc = pcat === 'local' ? (/^[a-z]{2}$/.test(pq) ? pq : (/^[a-z]{2}$/i.test(S(req.headers['x-vercel-ip-country'])) ? S(req.headers['x-vercel-ip-country']).toLowerCase() : 'iq')) : '';
    db.posts.push({ id: rid(), un: me, text, img, m: pm ? b.media : '', time: Date.now(), likes: [], cm: [], cat: pcat, cc: pcc });
    save(); return ok();
  }
  if (K === 'POST /api/posts/delete') { const dp = db.posts.find(p => p.id === S(b.id) && p.un === me); if (dp && dp.m) rmMedia(dp.m); db.posts = db.posts.filter(p => !(p.id === S(b.id) && p.un === me)); save(); return ok(); }
  if (K === 'POST /api/posts/like') {
    const p = vp(b.id); if (!p) return err(res, 'المنشور غير موجود', 404);
    const i = p.likes.indexOf(me); if (i >= 0) p.likes.splice(i, 1); else p.likes.push(me);
    if (i < 0) notify(p.un, 'post', me, 'أعجبه منشورك');
    save(); return send(res, 200, { liked: i < 0, likes: p.likes.length });
  }
  if (K === 'POST /api/posts/save') {
    const p = vp(b.id); if (!p) return err(res, 'المنشور غير موجود', 404);
    m.saves = m.saves || []; const i = m.saves.indexOf(p.id);
    if (i >= 0) m.saves.splice(i, 1); else m.saves.push(p.id);
    save(); return send(res, 200, { saved: i < 0 });
  }
  if (K === 'GET /api/saved') return send(res, 200, (m.saves || []).map(id => db.posts.find(p => p.id === id)).filter(p => p && canSee(me, p.un)).reverse().map(p => pv(p, me)));
  if (K === 'GET /api/comments') {
    const p = vp(u.searchParams.get('id')); if (!p) return err(res, 'المنشور غير موجود', 404);
    return send(res, 200, p.cm.map(c => ({ id: c.id, un: c.un, name: nm(c.un), av: av(c.un), v: isV(c.un) ? 1 : 0, text: c.text, time: c.time, del: c.un === me || p.un === me })));
  }
  if (K === 'POST /api/comments') {
    const p = vp(b.id), text = S(b.text).slice(0, 300);
    if (!p) return err(res, 'المنشور غير موجود', 404);
    if (!text) return err(res, 'اكتب تعليق');
    p.cm.push({ id: rid(), un: me, text, time: Date.now() }); notify(p.un, 'post', me, 'علّق على منشورك: ' + text.slice(0, 40)); save(); return ok();
  }
  if (K === 'POST /api/comments/delete') {
    const p = vp(b.id); if (!p) return err(res, 'المنشور غير موجود', 404);
    p.cm = p.cm.filter(c => !(c.id === S(b.cid) && (c.un === me || p.un === me))); save(); return ok();
  }
  if (K === 'POST /api/stories/view') { const s = db.stories.find(x => x.id === S(b.id) && live(x) && storyOK(x, me)); if (s && s.un !== me) { s.views = s.views || []; if (!s.views.includes(me)) { s.views.push(me); save(); } } return send(res, 200, { ok: 1 }); }
    if (K === 'POST /api/stories/like') {
    const s = db.stories.find(x => x.id === S(b.id) && live(x) && storyOK(x, me)); if (!s) return err(res, 'القصة غير موجودة', 404);
    s.likes = s.likes || []; const i = s.likes.indexOf(me);
    if (i >= 0) s.likes.splice(i, 1); else s.likes.push(me);
    if (i < 0) notify(s.un, 'story', me, 'أعجبته قصتك');
    save(); return send(res, 200, { liked: i < 0, likes: s.likes.length });
  }
  if (K === 'POST /api/stories/reply') {
    const s = db.stories.find(x => x.id === S(b.id) && live(x)), text = S(b.text).slice(0, 400);
    if (!s) return err(res, 'القصة غير موجودة', 404);
    if (!text) return err(res, 'اكتب ردك');
    if (s.un === me) return err(res, 'هذي قصتك أنت 😄');
    if (!isF(me, s.un)) return err(res, 'أضفه صديق أول حتى تكدر ترد على قصته', 403);
    db.msgs.push({ from: me, to: s.un, text: '↩ ردّ على قصتك «' + s.text.slice(0, 30) + '»: ' + text, time: Date.now(), r: 0 });
    notify(s.un, 'story', me, 'ردّ على قصتك: ' + text.slice(0, 40));
    save(); return ok();
  }
  if (K === 'GET /api/notifs') {
    const l = (db.notifs || []).filter(x => x.to === me).slice(-50).reverse();
    return send(res, 200, { unread: l.filter(x => !x.r).length, list: l.map(x => ({ id: x.id, type: x.type, un: x.from, name: nm(x.from), av: av(x.from), text: x.text, time: x.time, r: x.r })) });
  }
  if (K === 'POST /api/notifs/read') { (db.notifs || []).forEach(x => { if (x.to === me) x.r = 1; }); save(); return ok(); }
  // ===== صندوق الأسرار =====
  const secGet = id => db.secrets.find(x => x.id === S(id) && secLive(x) && secOK(me, x));
  if (K === 'GET /api/secrets') {
    const now = Date.now(), dead = db.secrets.filter(s => s.exp && now > s.exp);
    if (dead.length) { dead.forEach(s => s.m && rmMedia(s.m)); db.secrets = db.secrets.filter(s => !(s.exp && now > s.exp)); save(); }
    return send(res, 200, db.secrets.filter(s => secLive(s) && secOK(me, s)).reverse().slice(0, 60).map(s => secOut(s, me)));
  }
  if (K === 'POST /api/secrets') {
    const text = S(b.text).slice(0, 500), md = b.media && owned(me, b.media);
    const aud = ['friends', 'followers', 'public'].includes(b.aud) ? b.aud : 'friends', hrs = [6, 12, 24, 0].includes(+b.hrs) ? +b.hrs : 24;
    if (b.media && !md) return err(res, 'الملف غير صالح');
    if (!text && !md) return err(res, 'اكتب سر أو أضف ملف');
    if (db.secrets.some(s => s.un === me && Date.now() - s.time < 6e4)) return err(res, 'انتظر دقيقة قبل ما تنشر سر ثاني', 429);
    db.secrets.push({ id: rid(), un: me, text, m: md ? S(b.media) : '', k: md ? md.kind : '', time: Date.now(), exp: hrs ? Date.now() + hrs * 36e5 : 0, aud, likes: [], cm: [], rep: [], anon: {}, nn: 0 });
    save(); return ok();
  }
  if (K === 'POST /api/secrets/delete') {
    const s = db.secrets.find(x => x.id === S(b.id) && x.un === me);
    if (s) { if (s.m) rmMedia(s.m); db.secrets = db.secrets.filter(x => x !== s); save(); }
    return ok();
  }
  if (K === 'POST /api/secrets/like') {
    const s = secGet(b.id); if (!s) return err(res, 'السر غير موجود', 404);
    const i = s.likes.indexOf(me); if (i < 0) s.likes.push(me); else s.likes.splice(i, 1);
    save(); return send(res, 200, { liked: i < 0, likes: s.likes.length });
  }
  if (K === 'GET /api/secrets/comments') {
    const s = secGet(u.searchParams.get('id')); if (!s) return err(res, 'السر غير موجود', 404);
    return send(res, 200, s.cm.filter(c => !c.hidden).map(c => ({ id: c.id, parent: c.parent || '', who: c.un === s.un ? 'صاحب السر' : 'مستخدم ' + s.anon[c.un], op: c.un === s.un, text: c.text, time: c.time, mine: c.un === me, del: c.un === me || s.un === me })));
  }
  if (K === 'POST /api/secrets/comments') {
    const s = secGet(b.id), text = S(b.text).slice(0, 300);
    if (!s) return err(res, 'السر غير موجود', 404);
    if (!text) return err(res, 'اكتب تعليق');
    if (s.cm.length >= 500) return err(res, 'التعليقات وصلت للحد الأعلى');
    let parent = '';
    if (b.parent) { const pc = s.cm.find(c => c.id === S(b.parent) && !c.hidden); if (!pc) return err(res, 'التعليق غير موجود', 404); parent = pc.parent || pc.id; }
    if (me !== s.un && !s.anon[me]) s.anon[me] = ++s.nn;
    s.cm.push({ id: rid(), un: me, text, time: Date.now(), parent, rep: [] });
    save(); return ok();
  }
  if (K === 'POST /api/secrets/comments/delete') {
    const s = secGet(b.id); if (!s) return err(res, 'السر غير موجود', 404);
    const c = s.cm.find(x => x.id === S(b.cid));
    if (c && (c.un === me || s.un === me)) { s.cm = s.cm.filter(x => x !== c && x.parent !== c.id); save(); }
    return ok();
  }
  if (K === 'POST /api/secrets/report') {
    const s = secGet(b.id); if (!s) return err(res, 'السر غير موجود', 404);
    if (b.cid) {
      const c = s.cm.find(x => x.id === S(b.cid)); if (!c) return err(res, 'التعليق غير موجود', 404);
      if (c.un === me) return err(res, 'هذا تعليقك أنت');
      c.rep = c.rep || []; if (!c.rep.includes(me)) c.rep.push(me); if (c.rep.length >= SEC_LIMIT) c.hidden = 1;
    } else {
      if (s.un === me) return err(res, 'هذا سرك أنت');
      if (!s.rep.includes(me)) s.rep.push(me); if (s.rep.length >= SEC_LIMIT) s.hidden = 1;
    }
    save(); return ok();
  }

  // ===== عنصر مفرد: منشور / سر =====
  if (K === 'GET /api/post') { const p = vp(u.searchParams.get('id')); return p ? send(res, 200, pv(p, me)) : err(res, 'المنشور غير موجود', 404); }
  if (K === 'GET /api/secret') { const s = secGet(u.searchParams.get('id')); return s ? send(res, 200, secOut(s, me)) : err(res, 'السر غير موجود', 404); }
  // ===== أخبار منطقتي =====
  const nwOut = (n, me) => ({ id: n.id, title: n.title, summary: n.summary, src: n.src, url: n.url, time: n.time, likes: n.likes.length, liked: n.likes.includes(me), cc: n.cm.length });
  const nwGet = id => (db.news || {})[S(id)];
  if (K === 'GET /api/news') {
    const q = S(u.searchParams.get('cc')).toLowerCase();
    const cc = /^[a-z]{2}$/.test(q) ? q : (/^[a-z]{2}$/i.test(S(req.headers['x-vercel-ip-country'])) ? S(req.headers['x-vercel-ip-country']).toLowerCase() : 'iq');
    db.news = db.news || {}; db.newsCache = db.newsCache || {};
    const now = Date.now(); let c = db.newsCache[cc];
    if (!c || (now - c.t > NEWS_TTL && (!c.ft || now - c.ft > 3e5))) {
      if (!pre || pre.cc !== cc) { wantNews = cc; return send(res, 200, { cc, items: [] }); }
      if (pre.items) {
        const ids = [];
        pre.items.forEach(a => { const o = db.news[a.id]; db.news[a.id] = Object.assign(a, { likes: o ? o.likes : [], cm: o ? o.cm : [] }); ids.push(a.id); });
        (c ? c.ids : []).forEach(id => { if (!ids.includes(id) && db.news[id] && now - db.news[id].time < 2592e5) ids.push(id); });
        c = db.newsCache[cc] = { t: now, ids: ids.slice(0, 40) };
        for (const k in db.news) if (now - db.news[k].time > 12096e5 && !db.news[k].cm.length) delete db.news[k];
        save();
      } else if (c) { c.ft = now; save(); }
      else return err(res, pre.error || 'تعذر جلب الأخبار', 503);
    }
    let city = ''; try { city = decodeURIComponent(S(req.headers['x-vercel-ip-city'])); } catch {}
    return send(res, 200, { cc, city, items: c.ids.map(id => db.news[id]).filter(Boolean).sort((a, b) => b.time - a.time).map(n => nwOut(n, me)) });
  }
  if (K === 'GET /api/news/item') { const n = nwGet(u.searchParams.get('id')); return n ? send(res, 200, nwOut(n, me)) : err(res, 'الخبر غير موجود', 404); }
  if (K === 'POST /api/news/like') {
    const n = nwGet(b.id); if (!n) return err(res, 'الخبر غير موجود', 404);
    const i = n.likes.indexOf(me); if (i >= 0) n.likes.splice(i, 1); else n.likes.push(me);
    save(); return send(res, 200, { liked: i < 0, likes: n.likes.length });
  }
  if (K === 'GET /api/news/comments') {
    const n = nwGet(u.searchParams.get('id')); if (!n) return err(res, 'الخبر غير موجود', 404);
    return send(res, 200, n.cm.map(c => ({ id: c.id, un: c.un, name: nm(c.un), av: av(c.un), v: isV(c.un) ? 1 : 0, text: c.text, time: c.time, del: c.un === me })));
  }
  if (K === 'POST /api/news/comments') {
    const n = nwGet(b.id), text = S(b.text).slice(0, 300);
    if (!n) return err(res, 'الخبر غير موجود', 404);
    if (!text) return err(res, 'اكتب تعليق');
    if (n.cm.length >= 300) return err(res, 'التعليقات وصلت للحد الأعلى');
    n.cm.push({ id: rid(), un: me, text, time: Date.now() }); save(); return ok();
  }
  if (K === 'POST /api/news/comments/delete') {
    const n = nwGet(b.id); if (!n) return err(res, 'الخبر غير موجود', 404);
    n.cm = n.cm.filter(c => !(c.id === S(b.cid) && c.un === me)); save(); return ok();
  }  err(res, 'not found', 404);
}

module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (!RU || !RT) { const r = mkRes(); err(r, 'قاعدة البيانات غير مربوطة. افتح Storage بفيرسل، أضف Upstash Redis، ثم سوّي Redeploy', 503); return fin(res, r); }
    if (req.method === 'POST' && u.pathname === '/api/media') return await upload(req, res);
    let b = {};
    if (req.method === 'POST') { try { const t = (await rbuf(req)).toString('utf8'); b = t ? JSON.parse(t) : {}; } catch { const r = mkRes(); err(r, 'الطلب وصل للسيرفر بشكل غير صالح (JSON)'); return fin(res, r); } }
    delete b.fbPhone;
    if (b.idToken && (u.pathname === '/api/signup' || u.pathname === '/api/reset')) {
      try { b.fbPhone = await fbPhone(String(b.idToken)); }
      catch (e) { const r = mkRes(); err(r, e.message, e.code || 503); return fin(res, r); }
    }
    pre = null;
    for (let i = 0; i < 6; i++) {
      await load();
      const r = mkRes(); pendDel = []; pendMail = []; wantNews = '';
      try { route(req, r, u.pathname, u, b); } catch (e) { console.error(e); r.h = {}; err(r, 'خطأ داخلي بالسيرفر: ' + (e && e.message || e), 500); dirty = false; }
      if (wantNews) { const cc = wantNews; wantNews = ''; try { pre = { cc, items: await fetchNews(cc) }; } catch (e) { pre = { cc, error: e.message }; } continue; }
      const pd = pendDel, pm = pendMail;
      if (dirty && !(await commit())) continue;
      if (pm.length) { try { await Promise.all(pm.map(sendMail)); } catch (e) { const r2 = mkRes(); err(r2, e.message, 502); return fin(res, r2); } }
      await Promise.all(pd.map(x => del(x).catch(() => {})));
      return fin(res, r);
    }
    const r = mkRes(); err(r, 'السيرفر مشغول (أكثر من شخص يكتب بنفس الوقت)، جرّب مرة ثانية', 503); fin(res, r);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = e.user ? 503 : 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: e.user ? e.message : 'خطأ داخلي بالسيرفر: ' + (e && e.message || e) })); }
  }
};
