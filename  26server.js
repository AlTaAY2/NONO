const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const DBF = path.join(__dirname, 'db.json'), PAGE = path.join(__dirname, 'index.html');
let db = { users: {}, tokens: {}, friends: [], reqs: [], msgs: [], stories: [], posts: [], follows: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF, 'utf8'))); } catch {}
let tm = null;
const save = () => { clearTimeout(tm); tm = setTimeout(() => { try { fs.writeFileSync(DBF, JSON.stringify(db)); } catch {} }, 300); };
const fails = {};
const S = s => String(s == null ? '' : s).trim();
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const live = s => Date.now() - s.time < 864e5;
const send = (res, c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
const err = (res, m, c = 400) => send(res, c, { error: m });
const phoneOf = s => {
  let d = S(s).replace(/[\s\-()]/g, '');
  if (!/^\+?\d{8,15}$/.test(d)) return null;
  if (d[0] === '+') return d;
  if (/^964\d{9,10}$/.test(d)) return '+' + d;
  return '+964' + d.replace(/^0+/, '');
};
const find = id => {
  id = S(id).toLowerCase().replace(/^@/, '');
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
const cnt = u => ({ posts: db.posts.filter(p => p.un === u).length, friends: db.friends.filter(f => f[0] === u || f[1] === u).length, followers: db.follows.filter(f => f[1] === u).length, following: db.follows.filter(f => f[0] === u).length });
const pv = (p, me) => ({ id: p.id, un: p.un, name: nm(p.un), av: av(p.un), text: p.text, img: !!p.img, time: p.time, likes: p.likes.length, liked: p.likes.includes(me), cc: p.cm.length, saved: ((db.users[me] || {}).saves || []).includes(p.id), me: p.un === me });
const person = (u, me) => ({ un: u, name: nm(u), av: av(u), rel: rel(me, u), following: isFol(me, u) });
const imgOK = s => /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 5e5;
const sv = (s, me) => ({ id: s.id, un: s.un, name: nm(s.un), av: av(s.un), text: s.text, color: s.color, time: s.time, me: s.un === me, likes: (s.likes || []).length, liked: (s.likes || []).includes(me) });
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
}
const login = (res, un) => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = un; save(); send(res, 200, { token: t }); };

function route(req, res, P, u, b) {
  const K = req.method + ' ' + P;
  if (K === 'POST /api/check') return send(res, 200, { exists: !!find(b.id), phone: !/[a-z]/i.test(S(b.id)) });
  if (K === 'POST /api/signup') {
    const ph = phoneOf(b.phone), un = S(b.username).toLowerCase().replace(/^@/, ''), em = S(b.email), pw = S(b.password);
    if (!ph) return err(res, 'رقم الهاتف غير صحيح');
    if (!/^(?=.*[a-z])[a-z0-9_.]{3,20}$/.test(un)) return err(res, 'اليوزر: 3 إلى 20 خانة، حروف إنجليزية وأرقام و _ و .');
    if (pw.length < 6) return err(res, 'كلمة السر لازم 6 خانات على الأقل');
    if (em && !/^\S+@\S+\.\S+$/.test(em)) return err(res, 'البريد الإلكتروني غير صحيح');
    if (db.users[un]) return err(res, 'هذا اليوزر مأخوذ، اختر غيره', 409);
    if (Object.values(db.users).some(x => x.phone === ph)) return err(res, 'هذا الرقم مسجل من قبل', 409);
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[un] = { un, name: un, phone: ph, email: em, salt, hash: hash(pw, salt), created: Date.now() };
    return login(res, un);
  }
  if (K === 'POST /api/login') {
    const f = find(b.id), k = S(b.id).toLowerCase(), x = fails[k] || { n: 0, t: 0 };
    if (x.n >= 5 && Date.now() - x.t < 6e5) return err(res, 'محاولات كثيرة، جرّب بعد 10 دقايق', 429);
    if (!f || hash(S(b.password), f.salt) !== f.hash) { fails[k] = { n: x.n + 1, t: Date.now() }; return err(res, 'معلومات الدخول غلط', 401); }
    delete fails[k]; return login(res, f.un);
  }
  if (K === 'GET /api/avatar') {
    const x = db.users[S(u.searchParams.get('u'))];
    if (!x || !x.avatar) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(x.avatar.split(',')[1], 'base64'));
  }
  if (K === 'GET /api/img') {
    const p = db.posts.find(x => x.id === S(u.searchParams.get('id')));
    if (!p || !p.img) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(p.img.split(',')[1], 'base64'));
  }
  const tk = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const m = tk && db.users[db.tokens[tk]];
  if (!m) return err(res, 'سجّل دخول', 401);
  const me = m.un;
  if (K === 'GET /api/me') return send(res, 200, { un: me, name: m.name, phone: m.phone, email: m.email, bio: m.bio || '', av: m.avt || 0, set: setg(me), counts: cnt(me) });
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
    m.email = em;
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
  if (K === 'GET /api/stories') return send(res, 200, db.stories.filter(s => live(s) && canSee(me, s.un)).reverse().map(s => sv(s, me)));
  if (K === 'POST /api/stories') {
    const text = S(b.text).slice(0, 200);
    if (!text) return err(res, 'اكتب شي أول');
    const color = /^#[0-9a-f]{6}$/i.test(S(b.color)) ? S(b.color) : '#E11D32';
    db.stories.push({ id: crypto.randomBytes(6).toString('hex'), un: me, text, color, time: Date.now() });
    db.stories = db.stories.filter(live); save(); return send(res, 200, { ok: 1 });
  }
  if (K === 'POST /api/stories/delete') { db.stories = db.stories.filter(s => !(s.id === b.id && s.un === me)); save(); return send(res, 200, { ok: 1 }); }
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
      const ms = db.msgs.filter(x => (x.from === me && x.to === o) || (x.from === o && x.to === me));
      const l = ms[ms.length - 1];
      return { un: o, name: nm(o), av: av(o), last: l ? l.text.slice(0, 60) : '', time: l ? l.time : 0, unread: ms.filter(x => x.from === o && !x.r).length };
    });
    return send(res, 200, out.sort((a, c) => c.time - a.time));
  }
  if (K === 'GET /api/msgs') {
    const o = S(u.searchParams.get('with'));
    if (!isF(me, o)) return err(res, 'ما بينكم صداقة', 403);
    let ch = false;
    const ms = db.msgs.filter(x => (x.from === me && x.to === o) || (x.from === o && x.to === me));
    ms.forEach(x => { if (x.to === me && !x.r) { x.r = 1; ch = true; } });
    if (ch) save();
    return send(res, 200, ms.slice(-200).map(x => ({ from: x.from, text: x.text, time: x.time })));
  }
  if (K === 'POST /api/send') {
    const to = S(b.to), text = S(b.text).slice(0, 500);
    if (!text) return err(res, 'الرسالة فارغة');
    if (!isF(me, to)) return err(res, 'لازم يوافق على طلبك أول', 403);
    db.msgs.push({ from: me, to, text, time: Date.now(), r: 0 }); save(); return send(res, 200, { ok: 1 });
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
  if (K === 'POST /api/unfriend') { const t = S(b.to); db.friends = db.friends.filter(f => !((f[0] === me && f[1] === t) || (f[0] === t && f[1] === me))); save(); return ok(); }
  if (K === 'GET /api/posts') {
    const okSet = new Set([me, ...db.friends.filter(f => f[0] === me || f[1] === me).map(f => f[0] === me ? f[1] : f[0]), ...db.follows.filter(f => f[0] === me).map(f => f[1])]);
    return send(res, 200, db.posts.filter(p => okSet.has(p.un) && canSee(me, p.un)).slice(-60).reverse().map(p => pv(p, me)));
  }
  if (K === 'POST /api/posts') {
    const text = S(b.text).slice(0, 500), img = S(b.image);
    if (!text && !img) return err(res, 'اكتب شي أو أضف صورة');
    if (img && !imgOK(img)) return err(res, 'الصورة غير صالحة');
    db.posts.push({ id: rid(), un: me, text, img, time: Date.now(), likes: [], cm: [] });
    save(); return ok();
  }
  if (K === 'POST /api/posts/delete') { db.posts = db.posts.filter(p => !(p.id === S(b.id) && p.un === me)); save(); return ok(); }
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
    return send(res, 200, p.cm.map(c => ({ id: c.id, un: c.un, name: nm(c.un), av: av(c.un), text: c.text, time: c.time, del: c.un === me || p.un === me })));
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
  if (K === 'POST /api/stories/like') {
    const s = db.stories.find(x => x.id === S(b.id) && live(x) && canSee(me, x.un)); if (!s) return err(res, 'القصة غير موجودة', 404);
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
  err(res, 'not found', 404);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/') {
    try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(PAGE)); }
    catch { res.statusCode = 404; return res.end('index.html not found'); }
  }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 7e5) req.destroy(); });
  req.on('end', () => {
    let b = {};
    try { b = raw ? JSON.parse(raw) : {}; } catch { return err(res, 'bad json'); }
    try { route(req, res, u.pathname, u, b); } catch (e) { err(res, 'server error', 500); }
  });
}).listen(3000, () => console.log('NONO server on 3000'));
