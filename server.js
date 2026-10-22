// Tashtibati licence server: accounts (username + password, Google or Apple), 7-day trial tied to the device,
// one device per account (moving to a new device only after purchase; the old device is then blocked),
// Google Play one-time purchase, a help / support assistant, an admin page, and the privacy / deletion pages.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = +process.env.PORT || 3000;
const TRIAL_DAYS = +process.env.TRIAL_DAYS || 7;
const PACKAGE = process.env.PACKAGE_NAME || 'com.efahmy.finishingprojects';
const PRODUCT_ID = process.env.PRODUCT_ID || 'tashtibati_full';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';   // OAuth "Web application" client id (same Google Cloud project as the Android client)
const CONTACT = process.env.CONTACT_EMAIL || 'fahmy.ehab2@gmail.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'fahmy.ehab2@gmail.com';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';     // Apple "Services ID" used for Sign in with Apple on Android / web
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tashtibati.onrender.com').replace(/\/$/, '');
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.SUPPORT_MODEL || 'claude-haiku-5-5';
const HELP = require('./help.js');
const LATEST_VERSION = process.env.LATEST_VERSION || '';           // newest app version, e.g. 2.2.0
const UPDATE_URL = process.env.UPDATE_URL || 'https://play.google.com/store/apps/details?id=' + (process.env.PACKAGE_NAME || 'com.efahmy.finishingprojects');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false, max: 5 });
const q = (sql, args) => pool.query(sql, args).then(r => r.rows);

async function migrate() {
  await pool.query(`
    create table if not exists accounts (
      id serial primary key, public_id uuid not null unique, username text not null unique,
      pass_hash text not null, created_at timestamptz not null default now(), trial_ends timestamptz not null,
      paid boolean not null default false, paid_at timestamptz, paid_via text, note text default '');
    create table if not exists devices (
      id serial primary key, account_id int not null references accounts(id) on delete cascade,
      device_id text not null, kind text not null, model text default '', first_seen timestamptz not null default now(),
      last_seen timestamptz not null default now(), active boolean not null default true);
    create unique index if not exists devices_one_per_kind on devices(account_id, kind) where active;
    create table if not exists trial_devices (device_id text primary key, account_id int, used_at timestamptz not null default now());
    create table if not exists sessions (
      token_hash text primary key, account_id int not null references accounts(id) on delete cascade,
      device_row int references devices(id) on delete cascade, created_at timestamptz not null default now(), last_seen timestamptz not null default now());
    alter table accounts add column if not exists google_sub text unique;
    alter table accounts add column if not exists email text;
    alter table accounts add column if not exists display_name text;
    alter table accounts add column if not exists apple_sub text unique;
    alter table devices add column if not exists revoked boolean not null default false;
    alter table devices add column if not exists revoked_at timestamptz;
    drop index if exists devices_one_per_kind;
    update devices d set active=false where active and exists (select 1 from devices d2 where d2.account_id=d.account_id and d2.active and (d2.last_seen, d2.id) > (d.last_seen, d.id));
    create unique index if not exists devices_one_active on devices(account_id) where active;
    create table if not exists support_tickets (
      id serial primary key, account_id int references accounts(id) on delete set null, username text, contact text,
      subject text, message text, transcript jsonb, lang text, device text, status text not null default 'open', created_at timestamptz not null default now());
    create table if not exists purchases (
      id serial primary key, account_id int references accounts(id) on delete set null, token text not null unique,
      order_id text, product_id text, state text not null, detail jsonb, created_at timestamptz not null default now());
  `);
}

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const k = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(k, Buffer.from(key, 'hex'));
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const normUser = u => String(u || '').trim().toLowerCase().normalize('NFKC');
const validUser = u => /^[\p{L}\p{N}._-]{3,32}$/u.test(u);
class HttpErr extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; } }

// very small rate limiter (per key, sliding window)
const hits = new Map();
function limit(key, max, ms) {
  const now = Date.now(); const h = hits.get(key) || { n: 0, until: now + ms };
  if (now > h.until) { h.n = 0; h.until = now + ms; }
  h.n++; hits.set(key, h);
  if (h.n > max) throw new HttpErr(429, 'tooMany');
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.until) hits.delete(k); }, 60000).unref();

function stateOf(acc) { if (acc.paid) return 'paid'; return new Date(acc.trial_ends) > new Date() ? 'trial' : 'expired'; }
async function statusPayload(acc, deviceRow) {
  const devs = await q('select id, kind, model, last_seen from devices where account_id=$1 and active order by kind', [acc.id]);
  return { ok: true, username: acc.username, displayName: acc.display_name || '', email: acc.email || '', google: !!acc.google_sub, apple: !!acc.apple_sub, social: ['google', 'apple'].includes(acc.pass_hash) ? acc.pass_hash : '', accountId: acc.public_id, state: stateOf(acc), trialEnds: acc.trial_ends, paidAt: acc.paid_at,
    serverTime: new Date().toISOString(), productId: PRODUCT_ID, trialDays: TRIAL_DAYS,
    updates: stateOf(acc) === 'paid', latestVersion: LATEST_VERSION, updateUrl: UPDATE_URL,
    devices: devs.map(d => ({ kind: d.kind, model: d.model, lastSeen: d.last_seen, current: d.id === deviceRow })) };
}
function readDevice(b) {
  const id = String(b.deviceId || '').slice(0, 128);
  if (id.length < 8) throw new HttpErr(400, 'badDevice');
  return { id, kind: b.kind === 'tablet' ? 'tablet' : 'phone', model: String(b.model || '').slice(0, 80) };
}
// one device per account. A paid account can move to a new device (transfer=true); the old device is then blocked for good.
async function attachDevice(acc, dev, transfer) {
  const [rev] = await q('select 1 from devices where account_id=$1 and device_id=$2 and revoked', [acc.id, dev.id]);
  if (rev) throw new HttpErr(403, 'deviceRevoked');
  const cur = await q('select * from devices where account_id=$1 and active', [acc.id]);
  const same = cur.find(d => d.device_id === dev.id);
  if (same) { await q('update devices set last_seen=now(), model=$2, kind=$3 where id=$1', [same.id, dev.model || same.model, dev.kind]); return same.id; }
  const other = cur[0];
  if (other) {
    const info = { model: other.model, kind: other.kind, lastSeen: other.last_seen, canTransfer: !!acc.paid };
    if (!acc.paid || !transfer) throw new HttpErr(409, 'otherDevice', info);
    await q('update devices set active=false, revoked=true, revoked_at=now() where account_id=$1 and active', [acc.id]);
  }
  const [row] = await q('insert into devices(account_id, device_id, kind, model) values($1,$2,$3,$4) returning id', [acc.id, dev.id, dev.kind, dev.model]);
  return row.id;
}
// Google / Apple: find the account for this identity, or create it (trial only if the device never had one)
async function socialAccount(provider, sub, email, name, dev) {
  const col = provider === 'apple' ? 'apple_sub' : 'google_sub';
  let [acc] = await q(`select * from accounts where ${col}=$1`, [sub]);
  if (acc) { if (name && name !== acc.display_name) { await q('update accounts set display_name=$2 where id=$1', [acc.id, String(name).slice(0, 80)]); acc.display_name = name; } return { acc, created: false, usedTrial: false }; }
  const base = (String(email || provider).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || provider).slice(0, 24).padEnd(3, '0');
  let username = base;
  for (let i = 0; i < 50; i++) { const [x] = await q('select 1 from accounts where username=$1', [username]); if (!x) break; username = base + (Math.floor(Math.random() * 9000) + 1000); }
  const [usedTrial] = await q('select 1 from trial_devices where device_id=$1', [dev.id]);
  const trialEnds = usedTrial ? new Date() : new Date(Date.now() + TRIAL_DAYS * 864e5);
  [acc] = await q(`insert into accounts(public_id, username, pass_hash, trial_ends, ${col}, email, display_name) values($1,$2,$3,$4,$5,$6,$7) returning *`,
    [crypto.randomUUID(), username, provider, trialEnds, sub, email || null, String(name || '').slice(0, 80)]);
  if (!usedTrial) await q('insert into trial_devices(device_id, account_id) values($1,$2) on conflict do nothing', [dev.id, acc.id]);
  return { acc, created: true, usedTrial: !!usedTrial };
}
// Apple ID token check (RS256 with Apple's published keys)
let appleKeys = null;
async function verifyAppleToken(idToken, nonce) {
  const [h, p, sig] = String(idToken || '').split('.');
  if (!h || !p || !sig) throw new HttpErr(401, 'badApple');
  const head = JSON.parse(Buffer.from(h, 'base64url').toString()), claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (!appleKeys || appleKeys.at < Date.now() - 3600e3 || !appleKeys.keys.some(k => k.kid === head.kid)) {
    const r = await fetch('https://appleid.apple.com/auth/keys').catch(() => { throw new HttpErr(502, 'appleUnreachable'); });
    appleKeys = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = appleKeys.keys.find(k => k.kid === head.kid);
  if (!jwk || head.alg !== 'RS256') throw new HttpErr(401, 'badApple');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok || claims.iss !== 'https://appleid.apple.com' || claims.aud !== APPLE_CLIENT_ID || claims.exp * 1000 < Date.now() || !claims.sub) throw new HttpErr(401, 'badApple');
  if (nonce && claims.nonce && claims.nonce !== nonce) throw new HttpErr(401, 'badApple');
  return claims;
}
const applePending = new Map();     // state -> { dev, nonce, at, identity }
setInterval(() => { const old = Date.now() - 15 * 60e3; for (const [k, v] of applePending) if (v.at < old) applePending.delete(k); }, 60000).unref();
async function newSession(acc, deviceRow) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('insert into sessions(token_hash, account_id, device_row) values($1,$2,$3)', [sha(token), acc.id, deviceRow]);
  return token;
}
async function auth(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!m) throw new HttpErr(401, 'noSession');
  const [s] = await q(`select s.token_hash, s.device_row, d.active as dev_active, a.* from sessions s join accounts a on a.id=s.account_id
                       left join devices d on d.id=s.device_row where s.token_hash=$1`, [sha(m[1])]);
  if (!s) throw new HttpErr(401, 'noSession');
  if (s.device_row && s.dev_active === false) throw new HttpErr(401, 'deviceRemoved');
  await q('update sessions set last_seen=now() where token_hash=$1', [s.token_hash]);
  if (s.device_row) await q('update devices set last_seen=now() where id=$1', [s.device_row]);
  return s;
}

// ---------- Google Play verification (needs a service account with access in Play Console) ----------
let gTok = null;
async function googleToken(sa) {
  if (gTok && gTok.exp > Date.now() + 60000) return gTok.token;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
  const j = await r.json(); if (!r.ok) throw new Error('google token: ' + (j.error_description || j.error || r.status));
  gTok = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gTok.token;
}
async function verifyPlay(token, productId) {
  let sa = null; try { sa = process.env.GOOGLE_SERVICE_ACCOUNT ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT) : null; } catch (e) { sa = null; }
  if (!sa) return { configured: false };
  const at = await googleToken(sa);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + at } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { configured: true, error: (j.error && j.error.message) || String(r.status) };
  if (j.purchaseState === 0 && j.acknowledgementState === 0) {
    await fetch(url + ':acknowledge', { method: 'POST', headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  }
  return { configured: true, data: j };
}

// ---------- API ----------
const routes = {
  'GET /health': async () => ({ ok: true, db: dbReady }),
  'GET /api/config': async () => ({ ok: true, productId: PRODUCT_ID, trialDays: TRIAL_DAYS, googleClientId: GOOGLE_CLIENT_ID, apple: !!APPLE_CLIENT_ID, support: SUPPORT_EMAIL, ai: !!AI_KEY, latestVersion: LATEST_VERSION, updateUrl: UPDATE_URL }),

  // Sign in with Google: the app sends the Google ID token; Google confirms it; first sign-in creates the account
  'POST /api/google': async (req, b) => {
    limit('google:' + req.ip, 30, 600e3);
    if (!GOOGLE_CLIENT_ID) throw new HttpErr(503, 'googleNotConfigured');
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(b.idToken || ''))).catch(() => { throw new HttpErr(502, 'googleUnreachable'); });
    const g = await r.json().catch(() => ({}));
    if (!r.ok || g.aud !== GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(g.iss || '') || +g.exp * 1000 < Date.now() || !g.sub) throw new HttpErr(401, 'badGoogle');
    const dev = readDevice(b);
    const { acc, created, usedTrial } = await socialAccount('google', g.sub, g.email_verified === 'true' || g.email_verified === true ? g.email : null, g.name || b.name || '', dev);
    const row = await attachDevice(acc, dev, !!b.transfer);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), created, trialUsedOnDevice: usedTrial };
  },

  // Sign in with Apple (works on Android through Apple's web page): start -> Apple -> callback -> app deep link -> finish
  'POST /api/apple/start': async (req, b) => {
    limit('apple:' + req.ip, 30, 600e3);
    if (!APPLE_CLIENT_ID) throw new HttpErr(503, 'appleNotConfigured');
    const dev = readDevice(b), state = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
    applePending.set(state, { dev, nonce, at: Date.now() });
    const u = new URL('https://appleid.apple.com/auth/authorize');
    u.search = new URLSearchParams({ client_id: APPLE_CLIENT_ID, redirect_uri: PUBLIC_URL + '/auth/apple/callback', response_type: 'code id_token', response_mode: 'form_post', scope: 'name email', state, nonce }).toString();
    return { ok: true, url: u.toString(), state };
  },
  'POST /auth/apple/callback': async (req, b) => {
    const p = applePending.get(String(b.state || ''));
    let ok = false;
    if (p) { try { const c = await verifyAppleToken(b.id_token, p.nonce); let name = '';
        try { const u = JSON.parse(b.user || '{}'); name = [u.name && u.name.firstName, u.name && u.name.lastName].filter(Boolean).join(' '); } catch (e) {}
        p.identity = { sub: c.sub, email: c.email || null, name }; ok = true; } catch (e) { p.error = e.code || 'badApple'; } }
    const link = 'tashtibati://auth?provider=apple&state=' + encodeURIComponent(String(b.state || ''));
    return { __html: page('Tashtibati', `<div class="card" style="text-align:center"><h1>${ok ? 'تم تسجيل الدخول بحساب Apple' : 'تعذر تسجيل الدخول بحساب Apple'}</h1>
      <p><a href="${link}"><button>العودة إلى تطبيق تشطيباتى</button></a></p><p class="muted">${ok ? 'Signed in with Apple — return to the app.' : 'Apple sign-in failed — return to the app and try again.'}</p></div>
      <script>setTimeout(function(){location.href=${JSON.stringify(link)}},300)</script>`) };
  },
  'POST /api/apple/finish': async (req, b) => {
    const p = applePending.get(String(b.state || ''));
    if (!p) throw new HttpErr(410, 'appleExpired');
    if (p.error) throw new HttpErr(401, p.error);
    if (!p.identity) throw new HttpErr(409, 'appleNotDone');
    const { acc, created, usedTrial } = await socialAccount('apple', p.identity.sub, p.identity.email, p.identity.name, p.dev);
    const row = await attachDevice(acc, p.dev, !!b.transfer);
    applePending.delete(String(b.state));
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), created, trialUsedOnDevice: usedTrial };
  },

  // ---------- help and support ----------
  'GET /api/help': async () => ({ ok: true, articles: HELP, email: SUPPORT_EMAIL }),
  'POST /api/support': async (req, b) => {
    limit('ai:' + req.ip, 40, 3600e3);
    let who = null; try { who = await auth(req); } catch (e) {}
    const lang = b.lang === 'en' ? 'en' : 'ar';
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })).filter(m => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length) throw new HttpErr(400, 'empty');
    const last = msgs[msgs.length - 1].content;
    if (AI_KEY) {
      const kb = HELP.map(a => `## ${a.en.t} / ${a.ar.t}\n${a.en.b}\n${a.ar.b}`).join('\n\n');
      const acct = who ? `The user is signed in as "${who.username}"; account state: ${stateOf(who)}${stateOf(who) === 'trial' ? ' (trial ends ' + new Date(who.trial_ends).toISOString().slice(0, 10) + ')' : ''}.` : 'The user is not signed in.';
      const system = `You are the customer-support assistant inside the Tashtibati (تشطيباتى) Android app, used by finishing/fit-out site engineers in Egypt to track project accounts, WhatsApp groups, agreements, files and Excel reports.
Answer only questions about using this app, using the help articles below as the source of truth. Never invent features, prices or policies. Never ask for passwords or payment details.
Reply in ${lang === 'ar' ? 'Arabic (clear, simple Modern Standard Arabic that Egyptians use)' : 'English'} unless the user writes in the other language. Keep answers short (under 120 words), with numbered steps when useful.
${acct}
If the problem needs a person — payment or refund problems, an account the user cannot get into, a forgotten password, a blocked or lost device, lost data, a crash or bug, anything the articles do not cover, or the user asks for a human — say that you will pass it to the support team at ${SUPPORT_EMAIL}, and end your reply with the exact token [[ESCALATE]].

Help articles:
${kb}`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages: msgs }) });
        const j = await r.json();
        if (r.ok) { let text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
          const escalate = text.includes('[[ESCALATE]]'); text = text.replace(/\[\[ESCALATE\]\]/g, '').trim();
          return { ok: true, reply: text, escalate, ai: true }; }
        console.error('support ai', r.status, j.error && j.error.message);
      } catch (e) { console.error('support ai', e.message); }
    }
    // no assistant configured (or it failed): answer from the closest help article
    const words = s2 => String(s2).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
    const want = new Set(words(last)); let best = null, score = 0;
    for (const a of HELP) { const t = words(a[lang].t + ' ' + a[lang].b + ' ' + a.en.t + ' ' + a.ar.t); const sc = t.filter(w => want.has(w)).length; if (sc > score) { score = sc; best = a; } }
    const reply = best && score >= 1 ? `${best[lang].t}\n${best[lang].b}` : (lang === 'ar' ? 'لم أجد إجابة مناسبة في المساعدة. يمكنك إرسال المشكلة لفريق الدعم.' : 'I could not find an answer in the help. You can send this to the support team.');
    return { ok: true, reply, escalate: !best || score < 2, ai: false };
  },
  'POST /api/support/ticket': async (req, b) => {
    limit('ticket:' + req.ip, 10, 3600e3);
    let who = null; try { who = await auth(req); } catch (e) {}
    const [t] = await q(`insert into support_tickets(account_id, username, contact, subject, message, transcript, lang, device) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [who ? who.id : null, who ? who.username : String(b.username || '').slice(0, 64), String(b.contact || '').slice(0, 120), String(b.subject || '').slice(0, 200), String(b.message || '').slice(0, 4000),
       JSON.stringify((Array.isArray(b.transcript) ? b.transcript : []).slice(-20)), b.lang === 'en' ? 'en' : 'ar', String(b.device || '').slice(0, 120)]);
    return { ok: true, id: t.id, email: SUPPORT_EMAIL };
  },

  // moving to a new device from the old one: this device is removed and blocked for this account (full version only)
  'POST /api/release-device': async (req) => {
    const s = await auth(req);
    if (!s.paid) throw new HttpErr(403, 'transferNeedsPurchase');
    if (s.device_row) await q('update devices set active=false, revoked=true, revoked_at=now() where id=$1', [s.device_row]);
    return { ok: true };
  },


  'POST /api/register': async (req, b) => {
    limit('reg:' + req.ip, 10, 3600e3);
    const username = normUser(b.username), pw = String(b.password || '');
    if (!validUser(username)) throw new HttpErr(400, 'badUsername');
    if (pw.length < 8 || pw.length > 128) throw new HttpErr(400, 'weakPassword');
    const dev = readDevice(b);
    const [exists] = await q('select 1 from accounts where username=$1', [username]);
    if (exists) throw new HttpErr(409, 'usernameTaken');
    const [usedTrial] = await q('select 1 from trial_devices where device_id=$1', [dev.id]);
    const trialEnds = usedTrial ? new Date() : new Date(Date.now() + TRIAL_DAYS * 864e5);
    const [acc] = await q('insert into accounts(public_id, username, pass_hash, trial_ends) values($1,$2,$3,$4) returning *', [crypto.randomUUID(), username, hashPassword(pw), trialEnds]);
    if (!usedTrial) await q('insert into trial_devices(device_id, account_id) values($1,$2) on conflict do nothing', [dev.id, acc.id]);
    const row = await attachDevice(acc, dev, false);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), trialUsedOnDevice: !!usedTrial };
  },

  'POST /api/login': async (req, b) => {
    const username = normUser(b.username);
    limit('login:' + req.ip, 30, 600e3); limit('user:' + username, 10, 900e3);
    const [acc] = await q('select * from accounts where username=$1', [username]);
    if (!acc || !checkPassword(String(b.password || ''), acc.pass_hash)) throw new HttpErr(401, 'badLogin');
    const row = await attachDevice(acc, readDevice(b), !!b.transfer);
    hits.delete('user:' + username);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row) };
  },

  'GET /api/status': async (req) => { const s = await auth(req); return statusPayload(s, s.device_row); },

  'POST /api/purchase': async (req, b) => {
    const s = await auth(req);
    const token = String(b.purchaseToken || ''); const productId = String(b.productId || PRODUCT_ID);
    if (token.length < 10) throw new HttpErr(400, 'badPurchase');
    const [old] = await q('select * from purchases where token=$1', [token]);
    if (old && old.account_id && old.account_id !== s.id) throw new HttpErr(409, 'purchaseOtherAccount');
    const v = await verifyPlay(token, productId).catch(e => ({ configured: true, error: e.message }));
    let state = 'review';
    if (v.configured && v.data) {
      const d = v.data;
      if (d.obfuscatedExternalAccountId && d.obfuscatedExternalAccountId !== s.public_id) state = 'wrongAccount';
      else state = d.purchaseState === 0 ? 'purchased' : d.purchaseState === 2 ? 'pending' : 'cancelled';
    } else if (v.configured && v.error) state = 'error';
    await q(`insert into purchases(account_id, token, order_id, product_id, state, detail) values($1,$2,$3,$4,$5,$6)
             on conflict (token) do update set state=excluded.state, detail=excluded.detail, account_id=excluded.account_id`,
      [s.id, token, String(b.orderId || '').slice(0, 64), productId, state, JSON.stringify(v.data || { error: v.error || null, verified: false })]);
    if (state === 'purchased') await q(`update accounts set paid=true, paid_at=coalesce(paid_at, now()), paid_via='google_play' where id=$1`, [s.id]);
    const [acc] = await q('select * from accounts where id=$1', [s.id]);
    return { ...(await statusPayload(acc, s.device_row)), purchase: state };
  },

  'POST /api/logout': async (req) => {
    const s = await auth(req);
    await q('delete from sessions where token_hash=$1', [s.token_hash]);
    return { ok: true };
  },

  'POST /api/password': async (req, b) => {
    const s = await auth(req);
    if (!checkPassword(String(b.oldPassword || ''), s.pass_hash)) throw new HttpErr(401, 'badLogin');
    const pw = String(b.newPassword || ''); if (pw.length < 8 || pw.length > 128) throw new HttpErr(400, 'weakPassword');
    await q('update accounts set pass_hash=$2 where id=$1', [s.id, hashPassword(pw)]);
    await q('delete from sessions where account_id=$1 and token_hash<>$2', [s.id, s.token_hash]);
    return { ok: true };
  },

  'POST /api/delete-account': async (req, b) => {
    const s = await auth(req);
    const ok = ['google', 'apple'].includes(s.pass_hash) ? normUser(b.confirm) === s.username : checkPassword(String(b.password || ''), s.pass_hash);
    if (!ok) throw new HttpErr(401, 'badLogin');
    await q('delete from accounts where id=$1', [s.id]);
    return { ok: true };
  },

  // ---------- admin ----------
  'GET /admin/api/accounts': async (req, b, url) => {
    adminAuth(req);
    const term = '%' + (url.searchParams.get('q') || '').toLowerCase() + '%';
    const rows = await q(`select a.id, a.username, a.email, a.google_sub is not null as google, a.created_at, a.trial_ends, a.paid, a.paid_at, a.paid_via, a.note,
        (select json_agg(json_build_object('id', d.id, 'kind', d.kind, 'model', d.model, 'lastSeen', d.last_seen)) from devices d where d.account_id=a.id and d.active) as devices,
        (select count(*)::int from devices d where d.account_id=a.id and d.revoked) as blocked, a.apple_sub is not null as apple,
        (select json_agg(json_build_object('order', p.order_id, 'state', p.state, 'at', p.created_at)) from purchases p where p.account_id=a.id) as purchases
      from accounts a where a.username like $1 order by a.created_at desc limit 300`, [term]);
    const [tot] = await q(`select count(*)::int as all, count(*) filter (where paid)::int as paid, count(*) filter (where not paid and trial_ends>now())::int as trial from accounts`);
    return { ok: true, totals: tot, accounts: rows.map(r => ({ ...r, state: stateOf(r) })) };
  },
  'POST /admin/api/account': async (req, b) => {
    adminAuth(req);
    const id = +b.id; if (!id) throw new HttpErr(400, 'badId');
    if (b.action === 'markPaid') await q(`update accounts set paid=true, paid_at=now(), paid_via='admin' where id=$1`, [id]);
    else if (b.action === 'markUnpaid') await q(`update accounts set paid=false, paid_at=null, paid_via=null where id=$1`, [id]);
    else if (b.action === 'extendTrial') await q(`update accounts set trial_ends=greatest(trial_ends, now()) + ($2 || ' days')::interval where id=$1`, [id, String(Math.min(365, Math.max(1, +b.days || 7)))]);
    else if (b.action === 'resetDevices') { await q('update devices set active=false where account_id=$1', [id]); await q('delete from sessions where account_id=$1', [id]); }
    else if (b.action === 'removeDevice') { await q('update devices set active=false where id=$1 and account_id=$2', [+b.deviceId, id]); await q('delete from sessions where device_row=$1', [+b.deviceId]); }
    else if (b.action === 'unblockDevices') await q('update devices set revoked=false where account_id=$1 and revoked', [id]);
    else if (b.action === 'note') await q('update accounts set note=$2 where id=$1', [id, String(b.note || '').slice(0, 500)]);
    else if (b.action === 'delete') await q('delete from accounts where id=$1', [id]);
    else throw new HttpErr(400, 'badAction');
    return { ok: true };
  },
  'GET /admin/api/tickets': async (req) => { adminAuth(req);
    return { ok: true, tickets: await q(`select id, username, contact, subject, message, transcript, lang, device, status, created_at from support_tickets order by (status='open') desc, created_at desc limit 200`) }; },
  'POST /admin/api/ticket': async (req, b) => { adminAuth(req); await q('update support_tickets set status=$2 where id=$1', [+b.id, b.status === 'open' ? 'open' : 'closed']); return { ok: true }; },
  'POST /delete-account': async (req, b) => {         // web form for Google Play's account-deletion requirement
    limit('del:' + req.ip, 10, 3600e3);
    const [acc] = await q('select * from accounts where username=$1', [normUser(b.username)]);
    if (!acc || !checkPassword(String(b.password || ''), acc.pass_hash)) throw new HttpErr(401, 'badLogin');
    await q('delete from accounts where id=$1', [acc.id]);
    return { ok: true };
  },
};
function adminAuth(req) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) throw new HttpErr(503, 'adminNotConfigured');
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  const [u, p] = m ? Buffer.from(m[1], 'base64').toString().split(/:(.*)/s) : [];
  if (!m || !safeEq(u, ADMIN_USER) || !safeEq(p || '', ADMIN_PASSWORD)) { limit('admin:' + req.ip, 20, 600e3); throw new HttpErr(401, 'admin', { basic: true }); }
}

// ---------- pages ----------
const page = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.6 system-ui,'Segoe UI',Tahoma,sans-serif;background:#f3f5f2;color:#1b2420}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:22px}h2{font-size:17px;margin-top:24px}.card{background:#fff;border:1px solid #d3d8d1;border-radius:12px;padding:14px;margin:10px 0}
input,button,select{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #c4cbc2}button{background:#1f4e8c;color:#fff;border:0;cursor:pointer;min-height:40px}button.ghost{background:#fff;color:#1b2420;border:1px solid #c4cbc2}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px;border-bottom:1px solid #e3e6e0;text-align:start;vertical-align:top}.wrap{overflow-x:auto}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.paid{background:#dcf0e4;color:#1f7a4d}.trial{background:#dfe8f5;color:#1f4e8c}.expired{background:#f6e1dd;color:#a3301f}.muted{color:#5d6862}
@media (prefers-color-scheme:dark){body{background:#111614;color:#e6ebe7}.card{background:#19201d;border-color:#2b3531}td,th{border-color:#2b3531}button.ghost{background:#19201d;color:#e6ebe7}.muted{color:#9aa59f}}</style></head><body><main>${body}</main></body></html>`;

const PRIVACY = page('سياسة الخصوصية وشروط الاستخدام — تشطيباتى', `<h1>سياسة الخصوصية — تشطيباتى</h1>
<p>تطبيق تشطيباتى يساعد مهندسي التشطيبات على تسجيل حسابات المشاريع. هذه الصفحة تشرح البيانات التي نتعامل معها وشروط الاستخدام.</p>
<h2>بيانات الحساب على خادمنا</h2><p>اسم المستخدم، وكلمة المرور مخزنة بشكل مشفّر (لا يمكن قراءتها)، أو معرّف حساب Google أو Apple وبريده واسمه عند الدخول بهما، وتاريخ الفترة التجريبية، وحالة الشراء من Google Play (رقم الطلب ورمز الشراء)، ومعرّف الجهاز ونوعه وطرازه لتطبيق قاعدة الجهاز الواحد لكل حساب ومنع تكرار الفترة التجريبية على نفس الجهاز.</p>
<h2>بيانات المشاريع والنسخ الاحتياطي</h2><p>بيانات المشاريع (الحسابات والاتفاقات والملفات) تُحفظ على جهازك. النسخ الاحتياطي يكون حسب اختيارك: في مجلد «Tashtibati» داخل Google Drive الخاص بك، أو ملف على جهازك ترسله لأي سحابة، أو iCloud في نسخة الآيفون. لا تُرسل بيانات المشاريع إلى خادمنا.</p>
<h2>واتساب والموقع</h2><p>قراءة إشعارات واتساب (عند تفعيلها بموافقتك) تتم على جهازك فقط، ويُحفظ منها رسائل التحويلات ورسائل جروب فريق العمل الذي تختاره. موقع المشروع يُحفظ على جهازك عند طلبك.</p>
<h2>المساعدة والدعم</h2><p>أسئلتك للمساعد الذكي داخل التطبيق تُرسل إلى خادمنا ومزوّد الذكاء الاصطناعي (Anthropic) لتوليد الرد فقط، ولا تُستخدم لأي غرض آخر. الطلبات المحوّلة للدعم تُحفظ لدينا مع اسم المستخدم لمتابعتها، وتُرسل بالبريد إلى ${SUPPORT_EMAIL}.</p>
<h2>الشراء والتحديثات</h2><p>النسخة الكاملة شراء لمرة واحدة عبر Google Play، وتشمل حق تنزيل التطبيق وجميع تحديثاته المستقبلية لنفس الحساب، وإعادة تثبيته على جهازك. الحساب يعمل على جهاز واحد، ويمكن نقله لجهاز جديد بعد الشراء، وعندها يُزال الجهاز القديم ولا يمكنه الدخول لهذا الحساب مرة أخرى. الفترة التجريبية مرة واحدة لكل جهاز.</p>
<h2>حذف الحساب</h2><p>يمكنك حذف حسابك من داخل التطبيق (الحساب ← حذف الحساب) أو من <a href="/delete-account">صفحة حذف الحساب</a>. يُحذف الحساب وبيانات الأجهزة والجلسات فورًا. بيانات مشاريعك على جهازك ونسخك الاحتياطية تبقى ملكك وتحت تحكمك.</p>
<h2>التواصل</h2><p>${CONTACT}</p>
<hr><h1 dir="ltr" style="text-align:left">Privacy policy and terms — Tashtibati</h1><div dir="ltr" style="text-align:left">
<p>Our server stores your username and a hashed password (or your Google / Apple account id, email and name when you sign in with them), trial dates, Google Play purchase details, and the id, type and model of your device, to apply the one-device-per-account rule and to give each device only one free trial. Project data stays on your device; backups go where you choose: a "Tashtibati" folder in your own Google Drive, a file on your device that you can send to any cloud, or iCloud on the iPhone version. Project data is never sent to our server. WhatsApp notification reading (only with your consent) happens on the device.</p>
<p>Questions to the in-app support assistant are sent to our server and our AI provider (Anthropic) only to produce the reply. Issues passed to support are stored with your username and emailed to ${SUPPORT_EMAIL}.</p>
<p>The full version is a one-time Google Play purchase and includes the right to download the app and all its future updates on the same account, and to reinstall it on your device. An account works on one device; after purchase it can be moved to a new device, and the old device is then removed and cannot sign in to that account again. You can delete your account in the app or at <a href="/delete-account">/delete-account</a>. Contact: ${CONTACT}</p></div>`);

const DELETE_PAGE = page('حذف الحساب — تشطيباتى', `<h1>حذف حساب تشطيباتى</h1><p class="muted">يحذف الحساب وحالة الشراء والأجهزة المسجلة نهائيًا. بيانات المشاريع على جهازك وفي Google Drive لا تتأثر.</p>
<form class="card" id="f"><p><label>اسم المستخدم<br><input name="username" autocomplete="username" required></label></p><p><label>كلمة المرور<br><input name="password" type="password" autocomplete="current-password" required></label></p>
<button>حذف الحساب نهائيًا</button><p id="m" role="status"></p></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('/delete-account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(f))});const j=await r.json();document.getElementById('m').textContent=j.ok?'تم حذف الحساب.':'اسم المستخدم أو كلمة المرور غير صحيحة.';};</script>`);

const ADMIN_PAGE = page('إدارة تشطيباتى', `<h1>إدارة حسابات تشطيباتى</h1>
<div class="card" id="tot">…</div>
<div class="card" style="display:flex;gap:8px;flex-wrap:wrap"><input id="q" placeholder="بحث باسم المستخدم" style="flex:1;min-width:180px"><button id="go">بحث</button></div>
<h2>طلبات الدعم</h2><div class="card wrap" id="tickets">…</div>
<h2>الحسابات</h2><div class="card wrap"><table><thead><tr><th>المستخدم</th><th>الحالة</th><th>الأجهزة</th><th>الشراء</th><th>إجراءات</th></tr></thead><tbody id="rows"></tbody></table></div>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const d=x=>x?new Date(x).toLocaleString('ar-EG-u-nu-latn',{dateStyle:'medium',timeStyle:'short'}):'—';
const st={paid:'مدفوع',trial:'تجريبي',expired:'انتهت التجربة'};
async function load(){const r=await fetch('/admin/api/accounts?q='+encodeURIComponent($('#q').value));const j=await r.json();
 $('#tot').innerHTML='الحسابات: <b>'+j.totals.all+'</b> · مدفوع: <b>'+j.totals.paid+'</b> · في التجربة: <b>'+j.totals.trial+'</b>';
 $('#rows').innerHTML=j.accounts.map(a=>'<tr><td><b>'+esc(a.username)+'</b>'+(a.google?' <span class="pill trial">Google</span>':'')+(a.apple?' <span class="pill trial">Apple</span>':'')+(a.email?'<br><span class="muted">'+esc(a.email)+'</span>':'')+'<br><span class="muted">'+d(a.created_at)+'</span>'+(a.note?'<br><span class="muted">'+esc(a.note)+'</span>':'')+'</td>'+
 '<td><span class="pill '+a.state+'">'+st[a.state]+'</span><br><span class="muted">'+(a.paid?('منذ '+d(a.paid_at)+' · '+esc(a.paid_via||'')):('حتى '+d(a.trial_ends)))+'</span></td>'+
 '<td>'+((a.devices||[]).map(x=>esc(x.kind==='tablet'?'تابلت':'هاتف')+' '+esc(x.model)+' <button class="ghost" data-a="removeDevice" data-id="'+a.id+'" data-dev="'+x.id+'">إزالة</button><br><span class="muted">'+d(x.lastSeen)+'</span>').join('<br>')||'—')+'</td>'+
 '<td>'+((a.purchases||[]).map(p=>esc(p.order||'')+' <b>'+esc(p.state)+'</b>').join('<br>')||'—')+'</td>'+
 '<td style="display:flex;gap:6px;flex-wrap:wrap">'+(a.paid?'<button class="ghost" data-a="markUnpaid" data-id="'+a.id+'">إلغاء التفعيل</button>':'<button data-a="markPaid" data-id="'+a.id+'">تفعيل كمدفوع</button>')+
 (a.blocked?'<button class="ghost" data-a="unblockDevices" data-id="'+a.id+'">إلغاء حظر '+a.blocked+' جهاز قديم</button>':'')+'<button class="ghost" data-a="extendTrial" data-id="'+a.id+'">+7 أيام</button><button class="ghost" data-a="resetDevices" data-id="'+a.id+'">إعادة ضبط الأجهزة</button><button class="ghost" data-a="note" data-id="'+a.id+'">ملاحظة</button></td></tr>').join('');}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b)return;const body={id:+b.dataset.id,action:b.dataset.a,deviceId:+b.dataset.dev||undefined,days:7};
 if(body.action==='note'){const n=prompt('ملاحظة');if(n==null)return;body.note=n;}
 if(['resetDevices','markUnpaid','removeDevice','unblockDevices'].includes(body.action)&&!confirm('تأكيد؟'))return;
 await fetch('/admin/api/account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});load();});
async function loadT(){const j=await (await fetch('/admin/api/tickets')).json();
 $('#tickets').innerHTML=j.tickets.length?'<table><thead><tr><th>#</th><th>المستخدم</th><th>المشكلة</th><th>الحالة</th></tr></thead><tbody>'+j.tickets.map(t=>'<tr><td>'+t.id+'<br><span class="muted">'+d(t.created_at)+'</span></td><td>'+esc(t.username||'—')+'<br><span class="muted">'+esc(t.contact||'')+' '+esc(t.device||'')+'</span></td><td><b>'+esc(t.subject||'')+'</b><br><span style="white-space:pre-wrap">'+esc(t.message||'')+'</span>'+((t.transcript||[]).length?'<details><summary class="muted">المحادثة</summary>'+(t.transcript||[]).map(m=>'<p><b>'+(m.role==='assistant'?'المساعد':'المستخدم')+':</b> '+esc(m.content)+'</p>').join('')+'</details>':'')+'</td><td><span class="pill '+(t.status==='open'?'expired':'paid')+'">'+(t.status==='open'?'مفتوح':'مغلق')+'</span><br><button class="ghost" data-t="'+t.id+'" data-s="'+(t.status==='open'?'closed':'open')+'">'+(t.status==='open'?'إغلاق':'إعادة فتح')+'</button></td></tr>').join('')+'</tbody></table>':'<p class="muted">لا توجد طلبات.</p>';}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-t]');if(!b)return;await fetch('/admin/api/ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+b.dataset.t,status:b.dataset.s})});loadT();});
loadT();$('#go').onclick=load;$('#q').onkeydown=e=>{if(e.key==='Enter')load();};load();
</script>`);

// ---------- server ----------
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'x-content-type-options': 'nosniff', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  req.ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return send(res, 200, PRIVACY, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/delete-account') return send(res, 200, DELETE_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/admin') { adminAuth(req); return send(res, 200, ADMIN_PAGE, 'text/html; charset=utf-8'); }
    const h = routes[`${req.method} ${url.pathname}`];
    if (h && !dbReady && url.pathname !== '/health') throw new HttpErr(503, 'starting');
    if (!h) return send(res, 404, { ok: false, error: 'notFound' });
    let body = {};
    if (req.method === 'POST') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 65536) throw new HttpErr(413, 'tooLarge'); }
      if (/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) body = Object.fromEntries(new URLSearchParams(raw));
      else { try { body = raw ? JSON.parse(raw) : {}; } catch (e) { throw new HttpErr(400, 'badJson'); } }
    }
    const out = await h(req, body, url);
    if (out && out.__html) return send(res, 200, out.__html, 'text/html; charset=utf-8');
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.status, { ok: false, error: e.code, ...e.extra }, 'application/json; charset=utf-8', e.extra.basic ? { 'www-authenticate': 'Basic realm="Tashtibati admin", charset="UTF-8"' } : {});
    console.error(e); send(res, 500, { ok: false, error: 'server' });
  }
});

let dbReady = false;
// optional: SEED_USER / SEED_PASSWORD create (or reset) one activated account at start-up, for testing
async function seedTestUser() {
  const u = normUser(process.env.SEED_USER || ''), pw = process.env.SEED_PASSWORD || '';
  if (!u || pw.length < 8) return;
  const [acc] = await q('select id from accounts where username=$1', [u]);
  if (acc) await q(`update accounts set pass_hash=$2, paid=true, paid_at=coalesce(paid_at, now()), paid_via=coalesce(paid_via,'test') where id=$1`, [acc.id, hashPassword(pw)]);
  else await q(`insert into accounts(public_id, username, pass_hash, trial_ends, paid, paid_at, paid_via) values($1,$2,$3,now(),true,now(),'test')`, [crypto.randomUUID(), u, hashPassword(pw)]);
  console.log('test account ready:', u);
}
async function connectDb() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set: add the database Internal URL in the service environment'); return setTimeout(connectDb, 30000); }
  try { await migrate(); await seedTestUser(); dbReady = true; console.log('database ready'); } catch (e) { console.error('database not ready:', e.message); setTimeout(connectDb, 10000); }
}
if (require.main === module) { server.listen(PORT, () => console.log('tashtibati server on', PORT)); connectDb(); }
else dbReady = true;
module.exports = { server, migrate, pool };
