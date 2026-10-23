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
const CONTACT = process.env.CONTACT_EMAIL || 'tashtibatiapp@gmail.com';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'tashtibatiapp@gmail.com';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';     // Apple "Services ID" used for Sign in with Apple on Android / web
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://tashtibati.onrender.com').replace(/\/$/, '');
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.SUPPORT_MODEL || 'claude-haiku-5-5';
const PLAN_MODEL = process.env.PLAN_MODEL || 'claude-sonnet-5-5';     // reads room names and sizes from plan photos
const HELP = require('./help.js');
const TERMS = require('./terms.js');      // terms and conditions; the app carries the same file
const LATEST_VERSION = process.env.LATEST_VERSION || '';           // newest app version, e.g. 2.2.0
const AI_DAILY_CAP = +process.env.AI_DAILY_CAP || 1500;            // cost guard: AI calls per day for the whole app
const SESSION_DAYS = +process.env.SESSION_DAYS || 90;              // a sign-in unused this long expires
const INTEGRITY_MODE = (process.env.INTEGRITY_MODE || 'off').toLowerCase();   // Play Integrity: off | log | enforce
const INTEGRITY_PROJECT = process.env.INTEGRITY_PROJECT || '';     // Google Cloud project number (for copies installed outside Google Play)
const INTEGRITY_DEVICE = process.env.INTEGRITY_DEVICE === 'basic' ? 'basic' : 'device';
// signing certificate(s) of copies installed outside Google Play (SHA-256, hex or base64). Copies from Play are recognised by Google.
const INTEGRITY_CERTS = (process.env.INTEGRITY_CERTS || '35:BB:C5:52:7B:14:E3:1C:DD:3C:8E:8E:DF:D9:16:2B:A3:0E:90:CF:02:8D:20:D7:40:0E:7C:80:8E:C2:43:71').split(',').map(x => hexOf(x)).filter(Boolean);
function hexOf(v) { v = String(v || '').trim(); if (/^[0-9a-f:]{64,95}$/i.test(v)) return v.replace(/:/g, '').toLowerCase();
  try { return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'); } catch (e) { return ''; } }
// offline use: the server signs a pass (ECDSA P-256) that lets this device work without internet for a few days
const OFFLINE_DAYS = Math.max(0, Math.min(14, process.env.OFFLINE_DAYS === undefined ? 3 : +process.env.OFFLINE_DAYS || 0));
let OFFLINE_KEY = null;
try { if (process.env.OFFLINE_KEY) OFFLINE_KEY = crypto.createPrivateKey({ key: Buffer.from(process.env.OFFLINE_KEY, 'base64'), format: 'der', type: 'pkcs8' }); } catch (e) { console.error('OFFLINE_KEY is not a valid key'); }
// email codes: Gmail (SMTP_USER + an app password in SMTP_PASS) or Resend (RESEND_API_KEY + MAIL_FROM)
const MAIL_FROM = process.env.MAIL_FROM || (process.env.SMTP_USER ? `Tashtibati <${process.env.SMTP_USER}>` : '');
// SMS / WhatsApp codes: Twilio Verify
const TW = { sid: process.env.TWILIO_ACCOUNT_SID || '', tok: process.env.TWILIO_AUTH_TOKEN || '', svc: process.env.TWILIO_VERIFY_SID || '' };
const WA_ON = process.env.TWILIO_WHATSAPP === '1';
// iPhone / iPad app: App Store purchases are signed by Apple (JWS with an x5c chain up to Apple Root CA - G3, pinned below)
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.efahmy.finishingprojects';
const IOS_UPDATE_URL = process.env.IOS_UPDATE_URL || '';
const APPLE_ROOT_FP = (process.env.APPLE_ROOT_FP || '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179').toLowerCase();
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
    alter table devices add column if not exists integrity text;
    create index if not exists sessions_last_seen on sessions(last_seen);
    alter table accounts add column if not exists email_verified boolean not null default false;
    alter table accounts add column if not exists phone text;
    alter table accounts add column if not exists phone_verified boolean not null default false;
    alter table accounts add column if not exists pending_phone text;
    alter table accounts add column if not exists phone_channel text not null default 'sms';
    alter table accounts add column if not exists twofa boolean not null default false;
    alter table accounts add column if not exists terms_version text;
    alter table accounts add column if not exists terms_at timestamptz;
    update accounts set email_verified=true where not email_verified and email is not null and (google_sub is not null or apple_sub is not null);
    create table if not exists verify_codes (
      id serial primary key, account_id int not null references accounts(id) on delete cascade, purpose text not null, target text not null,
      code_hash text not null, expires timestamptz not null, attempts int not null default 0, used boolean not null default false, created_at timestamptz not null default now());
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
// soft limit: true while under the limit (no error)
function under(key, max, ms) { try { limit(key, max, ms); return true; } catch (e) { return false; } }
// whole-app daily budget for AI calls, so a misuse can never run up a large bill
const aiDay = { day: '', n: 0 };
function aiBudget(cost) { const d = new Date().toISOString().slice(0, 10); if (aiDay.day !== d) { aiDay.day = d; aiDay.n = 0; }
  if (aiDay.n + cost > AI_DAILY_CAP) { if (aiDay.n <= AI_DAILY_CAP) console.error('AI daily cap reached'); aiDay.n = AI_DAILY_CAP + 1; return false; } aiDay.n += cost; return true; }
// the visitor's real address: the edge (Cloudflare) sets True-Client-IP / CF-Connecting-IP and overwrites any value the visitor sends
function clientIp(req) {
  const h = req.headers, edge = h['true-client-ip'] || h['cf-connecting-ip'];
  if (edge) return String(edge).trim();
  const xff = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || '';
}

function stateOf(acc) { if (acc.paid) return 'paid'; return new Date(acc.trial_ends) > new Date() ? 'trial' : 'expired'; }
async function statusPayload(acc, deviceRow) {
  const devs = await q('select id, device_id, kind, model, last_seen from devices where account_id=$1 and active order by kind', [acc.id]);
  const cur = devs.find(d => d.id === deviceRow);
  return { ok: true, username: acc.username, displayName: acc.display_name || '', email: acc.email || '', google: !!acc.google_sub, apple: !!acc.apple_sub, social: ['google', 'apple'].includes(acc.pass_hash) ? acc.pass_hash : '', accountId: acc.public_id, state: stateOf(acc), trialEnds: acc.trial_ends, paidAt: acc.paid_at,
    serverTime: new Date().toISOString(), productId: PRODUCT_ID, trialDays: TRIAL_DAYS,
    updates: stateOf(acc) === 'paid', latestVersion: LATEST_VERSION, updateUrl: UPDATE_URL, updateUrlIos: IOS_UPDATE_URL,
    devices: devs.map(d => ({ kind: d.kind, model: d.model, lastSeen: d.last_seen, current: d.id === deviceRow })),
    emailVerified: !!acc.email_verified, phone: acc.phone_verified ? acc.phone : '', phoneVerified: !!acc.phone_verified, phoneChannel: acc.phone_channel || 'sms', twofa: !!(acc.twofa && acc.phone_verified),
    offline: offlinePass(acc, cur && cur.device_id), termsVersion: TERMS.version, termsAccepted: acc.terms_version === TERMS.version };
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
  [acc] = await q(`insert into accounts(public_id, username, pass_hash, trial_ends, ${col}, email, display_name, email_verified) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [crypto.randomUUID(), username, provider, trialEnds, sub, email || null, String(name || '').slice(0, 80), !!email]);
  if (!usedTrial) await q('insert into trial_devices(device_id, account_id) values($1,$2) on conflict do nothing', [dev.id, acc.id]);
  return { acc, created: true, usedTrial: !!usedTrial };
}
// Apple ID token check (RS256 with Apple's published keys)
let appleKeys = null;
async function verifyAppleToken(idToken, nonce, aud = APPLE_CLIENT_ID) {
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
  if (!ok || claims.iss !== 'https://appleid.apple.com' || !aud || claims.aud !== aud || claims.exp * 1000 < Date.now() || !claims.sub) throw new HttpErr(401, 'badApple');
  if (nonce && claims.nonce !== nonce) throw new HttpErr(401, 'badApple');
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
  const [s] = await q(`select s.token_hash, s.device_row, s.last_seen as session_seen, d.active as dev_active, a.* from sessions s join accounts a on a.id=s.account_id
                       left join devices d on d.id=s.device_row where s.token_hash=$1`, [sha(m[1])]);
  if (!s) throw new HttpErr(401, 'noSession');
  if (new Date(s.session_seen) < Date.now() - SESSION_DAYS * 864e5) { await q('delete from sessions where token_hash=$1', [s.token_hash]); throw new HttpErr(401, 'sessionExpired'); }
  if (s.device_row && s.dev_active === false) throw new HttpErr(401, 'deviceRemoved');
  await q('update sessions set last_seen=now() where token_hash=$1', [s.token_hash]);
  if (s.device_row) await q('update devices set last_seen=now() where id=$1', [s.device_row]);
  return s;
}

// ---------- Google Play verification (needs a service account with access in Play Console) ----------
const gToks = {};
function serviceAccount() { try { return process.env.GOOGLE_SERVICE_ACCOUNT ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT) : null; } catch (e) { return null; } }
async function googleToken(sa, scope = 'https://www.googleapis.com/auth/androidpublisher') {
  const gTok = gToks[scope];
  if (gTok && gTok.exp > Date.now() + 60000) return gTok.token;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
  const j = await r.json(); if (!r.ok) throw new Error('google token: ' + (j.error_description || j.error || r.status));
  gToks[scope] = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
async function verifyPlay(token, productId) {
  const sa = serviceAccount();
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

// ---------- terms and conditions: each account's accepted version and time ----------
async function noteTerms(acc, b) {
  if (b && b.termsAccepted === TERMS.version && acc.terms_version !== TERMS.version) {
    await q('update accounts set terms_version=$2, terms_at=now() where id=$1', [acc.id, TERMS.version]);
    acc.terms_version = TERMS.version;
  }
}
function termsHtml() {
  const part = (L, dir) => `<section dir="${dir}" style="text-align:${dir === 'rtl' ? 'right' : 'left'}"><h1>${L.title}</h1>
    <p class="muted">${dir === 'rtl' ? 'الإصدار' : 'Version'} ${TERMS.version} · ${dir === 'rtl' ? 'تاريخ السريان' : 'Effective'} ${TERMS.effective} · ${L.note}</p>
    ${L.clauses.map(([t, b, list, after]) => `<h2>${t}</h2>${b ? `<p>${b}</p>` : ''}${list ? `<ol>${list.map(x => `<li>${x}</li>`).join('')}</ol>` : ''}${after ? `<p>${after}</p>` : ''}`).join('')}</section>`;
  return page('الشروط والأحكام — تشطيباتى', part(TERMS.ar, 'rtl') + '<hr>' + part(TERMS.en, 'ltr') + `<p><a href="/privacy">سياسة الخصوصية · Privacy policy</a></p>`);
}

// ---------- offline pass, email / SMS codes, two-step sign-in ----------
function offlinePass(acc, deviceId) {
  if (!OFFLINE_KEY || !OFFLINE_DAYS || !deviceId) return null;
  const st = stateOf(acc); if (st === 'expired') return null;
  let until = Date.now() + OFFLINE_DAYS * 864e5; if (st === 'trial') until = Math.min(until, new Date(acc.trial_ends).getTime());
  const p = Buffer.from(JSON.stringify({ a: acc.public_id, d: deviceId, s: st, u: until, t: Date.now() })).toString('base64url');
  return { p, s: crypto.sign('sha256', Buffer.from(p), { key: OFFLINE_KEY, dsaEncoding: 'ieee-p1363' }).toString('base64url'), days: OFFLINE_DAYS };
}
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(e);
const maskEmail = e => { const [u, d] = String(e || '').split('@'); return u && d ? u[0] + '•••@' + d : ''; };
const maskPhone = p => { p = String(p || ''); return p.length > 7 ? p.slice(0, 5) + '•'.repeat(p.length - 8) + p.slice(-3) : p; };
// Egyptian numbers may be typed locally (010…, 011…, 012…, 015…); everything else needs the country code
function normPhone(v) {
  let x = String(v || '').replace(/[\s\-()]/g, '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  if (x.startsWith('00')) x = '+' + x.slice(2);
  if (/^01[0125]\d{8}$/.test(x)) x = '+2' + x;
  if (/^201[0125]\d{8}$/.test(x)) x = '+' + x;
  return /^\+[1-9]\d{7,14}$/.test(x) ? x : '';
}
const mailOn = () => !!(MAIL_FROM && (process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS)));
const smsOn = () => !!(TW.sid && TW.tok && TW.svc);
let mailer = null;
async function sendMail(to, subject, text, html) {
  if (!mailOn()) throw new HttpErr(503, 'mailNotConfigured');
  try {
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }) });
      if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
    } else {
      mailer ||= require('nodemailer').createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +process.env.SMTP_PORT || 465, secure: (+process.env.SMTP_PORT || 465) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      await mailer.sendMail({ from: MAIL_FROM, to, subject, text, html });
    }
  } catch (e) { console.error('mail', e.message); throw new HttpErr(502, 'mailFailed'); }
}
function codeMail(code) {
  const text = `رمز التحقق لتطبيق تشطيباتى: ${code}\nصالح لمدة 15 دقيقة. لا تشارك هذا الرمز مع أي شخص، ولن نطلبه منك أبدًا.\nإذا لم تطلبه تجاهل هذه الرسالة.\n\nYour Tashtibati verification code: ${code}\nIt is valid for 15 minutes. Never share it. If you did not ask for it, ignore this email.`;
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7"><p>رمز التحقق لتطبيق <b>تشطيباتى</b>:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold" dir="ltr">${code}</p><p>صالح لمدة 15 دقيقة. لا تشارك هذا الرمز مع أي شخص، ولن نطلبه منك أبدًا. إذا لم تطلبه تجاهل هذه الرسالة.</p><hr><p dir="ltr" style="text-align:left">Your Tashtibati verification code is <b>${code}</b>. It is valid for 15 minutes. Never share it. If you did not ask for it, ignore this email.</p></div>`;
  return ['رمز التحقق — تشطيباتى / Tashtibati code', text, html];
}
async function newCode(accId, purpose, target) {
  await q('delete from verify_codes where account_id=$1 and purpose=$2', [accId, purpose]);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await q(`insert into verify_codes(account_id, purpose, target, code_hash, expires) values($1,$2,$3,$4, now() + interval '15 minutes')`, [accId, purpose, target, sha(accId + ':' + purpose + ':' + code)]);
  return code;
}
async function checkCode(accId, purpose, code) {
  const [c] = await q('select * from verify_codes where account_id=$1 and purpose=$2 and not used and expires > now() order by id desc limit 1', [accId, purpose]);
  if (!c || c.attempts >= 5) return null;
  await q('update verify_codes set attempts=attempts+1 where id=$1', [c.id]);
  if (!safeEq(sha(accId + ':' + purpose + ':' + String(code || '').trim()), c.code_hash)) return null;
  await q('update verify_codes set used=true where id=$1', [c.id]);
  return c;
}
async function twilio(path, params) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(TW.svc)}/${path}`, { method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(TW.sid + ':' + TW.tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
    .catch(() => { throw new HttpErr(502, 'smsFailed'); });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}
async function smsSend(to, channel) {
  if (!smsOn()) throw new HttpErr(503, 'smsNotConfigured');
  const r = await twilio('Verifications', { To: to, Channel: channel === 'whatsapp' && WA_ON ? 'whatsapp' : 'sms', Locale: 'ar' });
  if (!r.ok) { console.error('twilio send', r.status, r.j.code, r.j.message); throw new HttpErr(r.status === 429 ? 429 : 502, r.status === 429 ? 'tooMany' : 'smsFailed'); }
}
async function smsCheck(to, code) {
  if (!smsOn() || !to || !/^\d{4,10}$/.test(String(code || '').trim())) return false;
  const r = await twilio('VerificationCheck', { To: to, Code: String(code).trim() });
  return r.ok && r.j.status === 'approved';
}
// two-step sign-in: with it on, a sign-in needs a code sent to the verified mobile
const otpPassed = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of otpPassed) if (v < now) otpPassed.delete(k); }, 60000).unref();
async function twoStep(acc, dev, b) {
  if (!acc.twofa || !acc.phone_verified || !acc.phone) return;
  const k = acc.id + ':' + dev.id, ttl = otpPassed.get(k);
  if (ttl && ttl > Date.now()) return k;      // passed a moment ago (e.g. now confirming a move to this device)
  const info = { to: maskPhone(acc.phone), channel: acc.phone_channel || 'sms' };
  if (b.otp) { limit('otpchk:' + acc.id, 10, 900e3);
    if (await smsCheck(acc.phone, b.otp)) { otpPassed.set(k, Date.now() + 10 * 60e3); return k; }
    throw new HttpErr(401, 'otpWrong', info); }
  limit('otpsend:' + acc.id, 6, 3600e3);
  await smsSend(acc.phone, acc.phone_channel);
  throw new HttpErr(401, 'otpRequired', info);
}
// password reset: the user can type the username, the verified email or the verified mobile
async function findAccount(id) {
  const v = String(id || '').trim(); if (!v) return null;
  if (v.includes('@')) return (await q('select * from accounts where lower(email)=lower($1) and email_verified order by id desc limit 1', [v]))[0] || null;
  const ph = /^[+0-9٠-٩\s\-()]{8,}$/.test(v) ? normPhone(v) : '';
  if (ph) return (await q('select * from accounts where phone=$1 and phone_verified order by id desc limit 1', [ph]))[0] || null;
  return (await q('select * from accounts where username=$1', [normUser(v)]))[0] || null;
}

// App Store: verify a signed transaction / notification (ES256 JWS, certificate chain pinned to Apple Root CA - G3)
const OID_LEAF = Buffer.from('060a2a864886f76364060b01', 'hex'), OID_INTER = Buffer.from('060a2a864886f76364060201', 'hex');
function verifyAppleJws(jws) {
  const parts = String(jws || '').split('.'); if (parts.length !== 3) throw new HttpErr(400, 'badPurchase');
  let head; try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); } catch (e) { throw new HttpErr(400, 'badPurchase'); }
  if (head.alg !== 'ES256' || !Array.isArray(head.x5c) || head.x5c.length < 3) throw new HttpErr(400, 'badPurchase');
  let certs; try { certs = head.x5c.slice(0, 3).map(c => new crypto.X509Certificate(Buffer.from(c, 'base64'))); } catch (e) { throw new HttpErr(400, 'badPurchase'); }
  const [leaf, inter, root] = certs, now = Date.now();
  const ok = crypto.createHash('sha256').update(root.raw).digest('hex') === APPLE_ROOT_FP
    && leaf.verify(inter.publicKey) && inter.verify(root.publicKey)
    && certs.every(c => new Date(c.validFrom).getTime() <= now && new Date(c.validTo).getTime() >= now)
    && leaf.raw.includes(OID_LEAF) && inter.raw.includes(OID_INTER)
    && crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new HttpErr(400, 'badPurchase');
  return JSON.parse(Buffer.from(parts[1], 'base64url'));
}
// a purchase made for an account that was later deleted may be restored to the user's new account
async function accountExists(publicId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(publicId))) return false;
  const [a] = await q('select 1 from accounts where public_id=$1', [String(publicId).toLowerCase()]);
  return !!a;
}
const looksLikeJws = t => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t);
async function appleRefund(originalTransactionId, info) {
  const rows = await q(`update purchases set state='voided', detail=coalesce(detail,'{}'::jsonb) || $2::jsonb where token=$1 and state<>'voided' returning account_id`, ['apple:' + originalTransactionId, JSON.stringify({ voided: info })]);
  for (const r of rows) if (r.account_id) {
    const [still] = await q(`select 1 from purchases where account_id=$1 and state='purchased'`, [r.account_id]);
    if (!still) await q(`update accounts set paid=false, note=left(coalesce(note,'') || ' [App Store refund ' || to_char(now(),'YYYY-MM-DD') || ']', 500) where id=$1 and paid and paid_via='app_store'`, [r.account_id]);
  }
  return rows.length;
}

// refunds and chargebacks: Google lists voided purchases; the full version is removed from those accounts
async function checkVoided() {
  const sa = serviceAccount(); if (!sa || !dbReady) return;
  try {
    const at = await googleToken(sa); let pageTok = '', removed = 0;
    do {
      const u = new URL(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE)}/purchases/voidedpurchases`);
      u.searchParams.set('startTime', String(Date.now() - 30 * 864e5)); u.searchParams.set('maxResults', '1000'); if (pageTok) u.searchParams.set('token', pageTok);
      const r = await fetch(u, { headers: { authorization: 'Bearer ' + at } }); const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('voided purchases', r.status, j.error && j.error.message); return; }
      for (const v of j.voidedPurchases || []) {
        const rows = await q(`update purchases set state='voided', detail=coalesce(detail,'{}'::jsonb) || $2::jsonb where token=$1 and state<>'voided' returning account_id`, [v.purchaseToken, JSON.stringify({ voided: v })]);
        for (const p of rows) if (p.account_id) {
          const [still] = await q(`select 1 from purchases where account_id=$1 and state='purchased'`, [p.account_id]);
          if (!still) { const u2 = await q(`update accounts set paid=false, note=left(coalesce(note,'') || ' [refund ' || to_char(now(),'YYYY-MM-DD') || ']', 500) where id=$1 and paid and paid_via='google_play' returning id`, [p.account_id]); removed += u2.length; }
        }
      }
      pageTok = (j.tokenPagination && j.tokenPagination.nextPageToken) || '';
    } while (pageTok);
    if (removed) console.log('refunds: full version removed from', removed, 'account(s)');
  } catch (e) { console.error('voided purchases', e.message); }
}
setInterval(checkVoided, 6 * 3600e3).unref();

// Play Integrity: is this the real app (from Google Play, or our own signed copy) on a real, unmodified device?
const nonces = new Map();   // nonce -> { at, tokenHash, verdict }
setInterval(() => { const old = Date.now() - 10 * 60e3; for (const [k, v] of nonces) if (v.at < old) nonces.delete(k); }, 60000).unref();
const integrityOn = () => INTEGRITY_MODE !== 'off' && !!serviceAccount();
async function checkIntegrity(b, where) {
  if (!integrityOn()) return null;
  if (b.platform === 'ios') { console.log('integrity', where, 'ios (not checked)'); return null; }   // Play Integrity is Android only
  const fail = code => { console.log('integrity', where, code); if (INTEGRITY_MODE === 'enforce') throw new HttpErr(403, code); return code; };
  const nonce = String(b.nonce || ''), token = String(b.integrity || ''), n = nonces.get(nonce);
  if (!token || !n) return fail(b.integrityError ? 'integrityUnavailable' : 'integrityRequired');
  const th = sha(token);
  if (n.tokenHash) { if (n.tokenHash !== th) return fail('integrityFailed'); return n.verdict === 'ok' ? 'ok' : fail(n.verdict); }   // same request retried (e.g. moving devices)
  n.tokenHash = th;
  let p;
  try {
    const at = await googleToken(serviceAccount(), 'https://www.googleapis.com/auth/playintegrity');
    const r = await fetch(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(PACKAGE)}:decodeIntegrityToken`, { method: 'POST', headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' }, body: JSON.stringify({ integrity_token: token }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('integrity decode', r.status, j.error && j.error.message); n.verdict = 'ok'; return null; }   // Google-side problem: never lock users out for it
    p = j.tokenPayloadExternal || {};
  } catch (e) { console.error('integrity', e.message); n.verdict = 'ok'; return null; }
  const norm = x => String(x || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const rd = p.requestDetails || {}, app = p.appIntegrity || {}, dv = (p.deviceIntegrity || {}).deviceRecognitionVerdict || [];
  const okDevice = INTEGRITY_DEVICE === 'basic' ? dv.length > 0 : dv.some(x => x === 'MEETS_DEVICE_INTEGRITY' || x === 'MEETS_STRONG_INTEGRITY');
  let v = 'ok';
  if (norm(rd.nonce) !== norm(nonce) || (rd.requestPackageName && rd.requestPackageName !== PACKAGE) || Math.abs(Date.now() - (+rd.timestampMillis || 0)) > 15 * 60e3) v = 'integrityFailed';
  else if (!okDevice) v = 'integrityDevice';
  else if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED' && !(app.packageName === PACKAGE && (app.certificateSha256Digest || []).some(c => INTEGRITY_CERTS.includes(hexOf(c))))) v = 'integrityApp';
  n.verdict = v;
  return v === 'ok' ? 'ok' : fail(v);
}
const markIntegrity = (row, v) => v ? q('update devices set integrity=$2 where id=$1', [row, v]) : null;

// ---------- API ----------
const routes = {
  'GET /health': async () => ({ ok: true, db: dbReady }),
  'GET /api/config': async () => ({ ok: true, productId: PRODUCT_ID, trialDays: TRIAL_DAYS, googleClientId: GOOGLE_CLIENT_ID, apple: !!APPLE_CLIENT_ID, support: SUPPORT_EMAIL, ai: !!AI_KEY, termsVersion: TERMS.version, latestVersion: LATEST_VERSION, updateUrl: UPDATE_URL, integrity: integrityOn(), integrityProject: INTEGRITY_PROJECT, mail: mailOn(), sms: smsOn(), whatsapp: smsOn() && WA_ON, offlineDays: OFFLINE_KEY ? OFFLINE_DAYS : 0 }),
  'POST /api/nonce': async (req) => { limit('nonce:' + req.ip, 60, 600e3); const n = crypto.randomBytes(24).toString('base64url'); nonces.set(n, { at: Date.now() }); return { ok: true, nonce: n }; },

  // Sign in with Google: the app sends the Google ID token; Google confirms it; first sign-in creates the account
  'POST /api/google': async (req, b) => {
    limit('google:' + req.ip, 30, 600e3);
    if (!GOOGLE_CLIENT_ID) throw new HttpErr(503, 'googleNotConfigured');
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(b.idToken || ''))).catch(() => { throw new HttpErr(502, 'googleUnreachable'); });
    const g = await r.json().catch(() => ({}));
    if (!r.ok || g.aud !== GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(g.iss || '') || +g.exp * 1000 < Date.now() || !g.sub) throw new HttpErr(401, 'badGoogle');
    const dev = readDevice(b);
    const integ = await checkIntegrity(b, 'google');
    const { acc, created, usedTrial } = await socialAccount('google', g.sub, g.email_verified === 'true' || g.email_verified === true ? g.email : null, g.name || b.name || '', dev);
    const passed = await twoStep(acc, dev, b);
    const row = await attachDevice(acc, dev, !!b.transfer); await markIntegrity(row, integ); if (passed) otpPassed.delete(passed);   // a code is good for one sign-in only
    await noteTerms(acc, b);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), created, trialUsedOnDevice: usedTrial };
  },

  // Sign in with Apple (works on Android through Apple's web page): start -> Apple -> callback -> app deep link -> finish
  'POST /api/apple/start': async (req, b) => {
    limit('apple:' + req.ip, 30, 600e3);
    if (!APPLE_CLIENT_ID) throw new HttpErr(503, 'appleNotConfigured');
    const dev = readDevice(b), state = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
    const integ = await checkIntegrity(b, 'apple');
    applePending.set(state, { dev, nonce, at: Date.now(), integ });
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
  // Sign in with Apple inside the iPhone / iPad app (the token's audience is the app's bundle id)
  'POST /api/apple/native': async (req, b) => {
    limit('apple:' + req.ip, 30, 600e3);
    const raw = String(b.rawNonce || ''); if (raw.length < 16) throw new HttpErr(400, 'badApple');
    const c = await verifyAppleToken(b.idToken, sha(raw), IOS_BUNDLE_ID);
    const dev = readDevice(b), integ = await checkIntegrity(b, 'apple');
    const { acc, created, usedTrial } = await socialAccount('apple', c.sub, c.email || null, String(b.name || '').slice(0, 80), dev);
    const passed = await twoStep(acc, dev, b);
    const row = await attachDevice(acc, dev, !!b.transfer); await markIntegrity(row, integ); if (passed) otpPassed.delete(passed);
    await noteTerms(acc, b);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), created, trialUsedOnDevice: usedTrial };
  },
  // App Store Server Notifications (version 2): refunds and revoked purchases remove the full version
  'POST /api/apple/notifications': async (req, b) => {
    limit('asn:' + req.ip, 120, 600e3);
    const n = verifyAppleJws(b.signedPayload);
    const d = n.data || {};
    if (d.bundleId && d.bundleId !== IOS_BUNDLE_ID) return { ok: true };
    if (['REFUND', 'REVOKE'].includes(n.notificationType) && d.signedTransactionInfo) {
      const t = verifyAppleJws(d.signedTransactionInfo);
      const k = await appleRefund(t.originalTransactionId, { type: n.notificationType, at: Date.now(), transactionId: t.transactionId });
      console.log('app store', n.notificationType, 'purchases updated:', k);
    }
    return { ok: true };
  },
  'POST /api/apple/finish': async (req, b) => {
    const p = applePending.get(String(b.state || ''));
    if (!p) throw new HttpErr(410, 'appleExpired');
    if (p.error) throw new HttpErr(401, p.error);
    if (!p.identity) throw new HttpErr(409, 'appleNotDone');
    const { acc, created, usedTrial } = await socialAccount('apple', p.identity.sub, p.identity.email, p.identity.name, p.dev);
    const passed = await twoStep(acc, p.dev, b);
    const row = await attachDevice(acc, p.dev, !!b.transfer); await markIntegrity(row, p.integ); if (passed) otpPassed.delete(passed);
    await noteTerms(acc, b);
    applePending.delete(String(b.state));
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), created, trialUsedOnDevice: usedTrial };
  },

  // ---------- help and support ----------
  'GET /api/help': async () => ({ ok: true, articles: HELP, email: SUPPORT_EMAIL }),
  'GET /api/terms': async () => ({ ok: true, terms: TERMS }),
  'POST /api/terms/accept': async (req, b) => {
    const s = await auth(req);
    if (b.version !== TERMS.version) throw new HttpErr(409, 'termsOutdated', { version: TERMS.version });
    await q('update accounts set terms_version=$2, terms_at=now() where id=$1', [s.id, TERMS.version]);
    const [acc] = await q('select * from accounts where id=$1', [s.id]);
    return statusPayload(acc, s.device_row);
  },
  'POST /api/support': async (req, b) => {
    limit('ai:' + req.ip, 40, 3600e3);
    let who = null; try { who = await auth(req); } catch (e) {}
    const lang = b.lang === 'en' ? 'en' : 'ar';
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })).filter(m => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length) throw new HttpErr(400, 'empty');
    const last = msgs[msgs.length - 1].content;
    // the AI answers signed-in users only (limited per account and per day for the whole app); everyone else gets the help articles
    if (AI_KEY && who && under('aiu:' + who.id, 60, 864e5) && aiBudget(1)) {
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
    // no assistant configured (or it failed): problems that need a person go straight to support
    if (/استرجاع|استرداد|فلوس|اتخصم|خصم|مرتين|دفع|refund|charged|twice|payment|نسيت|forgot|password|كلمة المرور|ضاع|اتمسح|lost|deleted|bug|crash|بيقفل|مش شغال|عطل|error|خطأ|محظور|blocked|سرق|stolen/i.test(last))
      return { ok: true, reply: lang === 'ar' ? `هذه المشكلة تحتاج فريق الدعم. اضغط «إرسال للدعم» وسنتواصل معك على ${SUPPORT_EMAIL}.` : `This needs the support team. Tap “Send to support” and we will reply from ${SUPPORT_EMAIL}.`, escalate: true, ai: false };
    // no assistant configured (or it failed): answer from the closest help article
    // rough Arabic / English word stems, enough to find the right help article
    const stem = w => /[\u0600-\u06ff]/.test(w) ? w.replace(/[\u064b-\u0652]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/^(وال|بال|كال|فال|لل|ال)/, '').slice(0, 3) : w.replace(/(ing|ed|es|s)$/, '');
    const STOP = new Set(['ازا', 'ايه', 'عاي', 'لما', 'ممك', 'how', 'what', 'the', 'can', 'and', 'for', 'with', 'from', 'into', 'this', 'that']);
    const words = s2 => String(s2).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2).map(stem).filter(w => w.length > 2 && !STOP.has(w));
    const want = new Set(words(last)); let best = null, score = 0;
    for (const a of HELP) { const title = new Set(words(a.ar.t + ' ' + a.en.t)), body = new Set(words(a[lang].b));
      let sc = 0; for (const w of want) { if (title.has(w)) sc += 3; else if (body.has(w)) sc += 1; } if (sc > score) { score = sc; best = a; } }
    const reply = best && score >= 1 ? `${best[lang].t}\n${best[lang].b}` : (lang === 'ar' ? 'لم أجد إجابة مناسبة في المساعدة. يمكنك إرسال المشكلة لفريق الدعم.' : 'I could not find an answer in the help. You can send this to the support team.');
    return { ok: true, reply, escalate: !best || score < 3, ai: false };
  },
  'POST /api/support/ticket': async (req, b) => {
    limit('ticket:' + req.ip, 10, 3600e3);
    let who = null; try { who = await auth(req); } catch (e) {}
    const [t] = await q(`insert into support_tickets(account_id, username, contact, subject, message, transcript, lang, device) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [who ? who.id : null, who ? who.username : String(b.username || '').slice(0, 64), String(b.contact || '').slice(0, 120), String(b.subject || '').slice(0, 200), String(b.message || '').slice(0, 4000),
       JSON.stringify((Array.isArray(b.transcript) ? b.transcript : []).slice(-20)), b.lang === 'en' ? 'en' : 'ar', String(b.device || '').slice(0, 120)]);
    return { ok: true, id: t.id, email: SUPPORT_EMAIL };
  },

  // read room names and sizes from a photo of a unit plan (AI vision); the app shows the result for review
  'POST /api/plan-read': async (req, b) => {
    const s = await auth(req);
    if (stateOf(s) === 'expired') throw new HttpErr(403, 'expired');
    limit('plan:' + s.id, 40, 864e5);
    if (!AI_KEY) throw new HttpErr(503, 'aiNotConfigured');
    if (!aiBudget(3)) throw new HttpErr(503, 'aiBusy');
    const data = String(b.image || ''), media = /^image\/(png|webp|gif)$/.test(b.mediaType) ? b.mediaType : 'image/jpeg';
    if (data.length < 200 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) throw new HttpErr(400, 'badImage');
    const types = 'bedroom, master, reception, living, dining, kitchen, bathroom, toilet, dressing, corridor, stairs, entrance, balcony, terrace, maid, laundry, storage, office, shop, hall, warehouse, production, parking, loading, yard, garden, pool, roof, other';
    const prompt = `This image is an architectural floor plan (a brochure page, a drawing, or a photo of one). Read it and return ONLY a JSON object, no other text:
{"floor": "ground|first|second|third|fourth|fifth|roof|basement|mezzanine|null", "floorLabel": "heading as written or null", "floorArea": number or null, "totalArea": number or null,
 "spaces": [{"name": "label exactly as written", "nameAr": "Arabic name for it", "type": "one of: ${types}", "length": number or null, "width": number or null, "area": number or null}]}
Rules: sizes are in metres; a label like "3.70m x 5.88m" means length 3.70 and width 5.88 (keep that order). "floorArea" is the floor's own area if written (e.g. "GROUND FLOOR AREA 107 M2"); "totalArea" is a total built-up area if written.
Include every labelled room or space. Only give numbers you can actually read — never estimate from the drawing scale; use null when a size is not written or not legible.`;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: PLAN_MODEL, max_tokens: 3000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: prompt }] }] }) })
      .catch(() => { throw new HttpErr(502, 'aiUnreachable'); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('plan ai', r.status, j.error && j.error.message); throw new HttpErr(502, 'aiFailed'); }
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    let plan = null; try { plan = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch (e) {}
    if (!plan || !Array.isArray(plan.spaces)) throw new HttpErr(422, 'planUnreadable');
    const n = v => (typeof v === 'number' && isFinite(v) && v > 0 && v < 100000 ? Math.round(v * 100) / 100 : null);
    plan.spaces = plan.spaces.slice(0, 120).map(x => ({ name: String(x.name || '').slice(0, 60), nameAr: String(x.nameAr || '').slice(0, 60), type: String(x.type || 'other').slice(0, 20), length: n(x.length), width: n(x.width), area: n(x.area) }));
    return { ok: true, plan: { floor: plan.floor || null, floorLabel: plan.floorLabel || null, floorArea: n(plan.floorArea), totalArea: n(plan.totalArea), spaces: plan.spaces } };
  },

  // ---------- email, mobile, two-step, password reset ----------
  'POST /api/email/start': async (req, b) => {
    const s = await auth(req); const email = String(b.email || '').trim().toLowerCase();
    if (!validEmail(email)) throw new HttpErr(400, 'badEmail');
    const [other] = await q('select 1 from accounts where lower(email)=$1 and email_verified and id<>$2', [email, s.id]); if (other) throw new HttpErr(409, 'emailInUse');
    limit('mail:' + s.id, 5, 3600e3); limit('mailall', 500, 3600e3);
    const code = await newCode(s.id, 'email', email); await sendMail(email, ...codeMail(code));
    return { ok: true, to: maskEmail(email) };
  },
  'POST /api/email/confirm': async (req, b) => {
    const s = await auth(req); limit('mailchk:' + s.id, 10, 900e3);
    const c = await checkCode(s.id, 'email', b.code); if (!c) throw new HttpErr(400, 'badCode');
    const [other] = await q('select 1 from accounts where lower(email)=$1 and email_verified and id<>$2', [c.target, s.id]); if (other) throw new HttpErr(409, 'emailInUse');
    await q('update accounts set email=$2, email_verified=true where id=$1', [s.id, c.target]);
    const [acc] = await q('select * from accounts where id=$1', [s.id]); return statusPayload(acc, s.device_row);
  },
  'POST /api/phone/start': async (req, b) => {
    const s = await auth(req); const phone = normPhone(b.phone); const channel = b.channel === 'whatsapp' && WA_ON ? 'whatsapp' : 'sms';
    if (!phone) throw new HttpErr(400, 'badPhone');
    const [other] = await q('select 1 from accounts where phone=$1 and phone_verified and id<>$2', [phone, s.id]); if (other) throw new HttpErr(409, 'phoneInUse');
    limit('sms:' + s.id, 5, 3600e3); limit('smsall', 300, 3600e3);
    await smsSend(phone, channel);
    await q('update accounts set pending_phone=$2, phone_channel=$3 where id=$1', [s.id, phone, channel]);
    return { ok: true, to: maskPhone(phone), channel };
  },
  'POST /api/phone/confirm': async (req, b) => {
    const s = await auth(req); limit('smschk:' + s.id, 10, 900e3);
    if (!s.pending_phone) throw new HttpErr(400, 'badCode');
    if (!(await smsCheck(s.pending_phone, b.code))) throw new HttpErr(400, 'badCode');
    await q('update accounts set phone=pending_phone, phone_verified=true, pending_phone=null where id=$1', [s.id]);
    const [acc] = await q('select * from accounts where id=$1', [s.id]); return statusPayload(acc, s.device_row);
  },
  'POST /api/2fa/start': async (req) => {
    const s = await auth(req); if (!s.phone_verified) throw new HttpErr(400, 'phoneFirst');
    limit('sms:' + s.id, 5, 3600e3); await smsSend(s.phone, s.phone_channel);
    return { ok: true, to: maskPhone(s.phone), channel: s.phone_channel };
  },
  'POST /api/2fa': async (req, b) => {
    const s = await auth(req); if (!s.phone_verified) throw new HttpErr(400, 'phoneFirst'); limit('smschk:' + s.id, 10, 900e3);
    if (!(await smsCheck(s.phone, b.code))) throw new HttpErr(400, 'badCode');
    await q('update accounts set twofa=$2 where id=$1', [s.id, !!b.on]);
    const [acc] = await q('select * from accounts where id=$1', [s.id]); return statusPayload(acc, s.device_row);
  },
  // forgotten password: a code to the verified email or mobile, then a new password (all sign-ins end)
  'POST /api/reset/start': async (req, b) => {
    limit('reset:' + req.ip, 10, 3600e3); limit('resetall', 300, 3600e3);
    const channel = ['email', 'sms', 'whatsapp'].includes(b.channel) ? b.channel : 'email';
    if (channel === 'email' && !mailOn()) throw new HttpErr(503, 'mailNotConfigured');
    if (channel !== 'email' && !smsOn()) throw new HttpErr(503, 'smsNotConfigured');
    const acc = await findAccount(b.id);
    // the reply is the same whether or not the account exists, so the form cannot be used to find accounts
    if (acc && under('resetacc:' + acc.id, 4, 3600e3)) {
      try {
        if (channel === 'email' && acc.email_verified && acc.email) await sendMail(acc.email, ...codeMail(await newCode(acc.id, 'reset', acc.email)));
        else if (channel !== 'email' && acc.phone_verified && acc.phone) await smsSend(acc.phone, channel);
      } catch (e) { console.error('reset send', e.code || e.message); }
    }
    return { ok: true };
  },
  'POST /api/reset/finish': async (req, b) => {
    limit('resetf:' + req.ip, 20, 3600e3);
    const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 128) throw new HttpErr(400, 'weakPassword');
    const acc = await findAccount(b.id); if (!acc) throw new HttpErr(400, 'badCode');
    limit('resetfa:' + acc.id, 8, 3600e3);
    const byPhone = b.channel === 'sms' || b.channel === 'whatsapp';
    const ok = byPhone ? (acc.phone_verified && await smsCheck(acc.phone, b.code)) : !!(await checkCode(acc.id, 'reset', b.code));
    if (!ok) throw new HttpErr(400, 'badCode');
    await q('update accounts set pass_hash=$2 where id=$1', [acc.id, hashPassword(pw)]);
    await q('delete from sessions where account_id=$1', [acc.id]); await q(`delete from verify_codes where account_id=$1 and purpose='reset'`, [acc.id]);
    if (byPhone && b.deviceId) otpPassed.set(acc.id + ':' + String(b.deviceId).slice(0, 128), Date.now() + 10 * 60e3);   // the mobile was just proven
    return { ok: true, username: acc.username };
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
    if (b.termsAccepted !== TERMS.version) throw new HttpErr(400, 'termsRequired');
    const dev = readDevice(b);
    limit('regdev:' + dev.id, 5, 864e5); limit('regall', 300, 3600e3);
    const integ = await checkIntegrity(b, 'register');
    const [exists] = await q('select 1 from accounts where username=$1', [username]);
    if (exists) throw new HttpErr(409, 'usernameTaken');
    const [usedTrial] = await q('select 1 from trial_devices where device_id=$1', [dev.id]);
    const trialEnds = usedTrial ? new Date() : new Date(Date.now() + TRIAL_DAYS * 864e5);
    const [acc] = await q('insert into accounts(public_id, username, pass_hash, trial_ends, terms_version, terms_at) values($1,$2,$3,$4,$5,now()) returning *', [crypto.randomUUID(), username, hashPassword(pw), trialEnds, TERMS.version]);
    if (!usedTrial) await q('insert into trial_devices(device_id, account_id) values($1,$2) on conflict do nothing', [dev.id, acc.id]);
    const row = await attachDevice(acc, dev, false); await markIntegrity(row, integ);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row), trialUsedOnDevice: !!usedTrial };
  },

  'POST /api/login': async (req, b) => {
    const username = normUser(b.username);
    limit('login:' + req.ip, 30, 600e3); limit('user:' + username, 10, 900e3);
    const [acc] = await q('select * from accounts where username=$1', [username]);
    if (!acc || !checkPassword(String(b.password || ''), acc.pass_hash)) { limit('loginfail', 600, 3600e3); throw new HttpErr(401, 'badLogin'); }
    const dev = readDevice(b), integ = await checkIntegrity(b, 'login');
    const passed = await twoStep(acc, dev, b);
    const row = await attachDevice(acc, dev, !!b.transfer); await markIntegrity(row, integ); if (passed) otpPassed.delete(passed);   // a code is good for one sign-in only
    await noteTerms(acc, b);
    hits.delete('user:' + username);
    return { ...(await statusPayload(acc, row)), token: await newSession(acc, row) };
  },

  'GET /api/status': async (req) => { const s = await auth(req); return statusPayload(s, s.device_row); },

  'POST /api/purchase': async (req, b) => {
    const s = await auth(req);
    const token = String(b.purchaseToken || ''); const productId = String(b.productId || PRODUCT_ID);
    if (token.length < 10) throw new HttpErr(400, 'badPurchase');
    if (looksLikeJws(token)) {          // App Store (iPhone / iPad)
      const t = verifyAppleJws(token);
      const key = 'apple:' + t.originalTransactionId;
      const [prev] = await q('select * from purchases where token=$1', [key]);
      if (prev && prev.account_id && prev.account_id !== s.id) throw new HttpErr(409, 'purchaseOtherAccount');
      let state = 'purchased';
      if (t.bundleId !== IOS_BUNDLE_ID || t.productId !== PRODUCT_ID) state = 'error';
      else if (t.appAccountToken && String(t.appAccountToken).toLowerCase() !== String(s.public_id).toLowerCase() && await accountExists(t.appAccountToken)) state = 'wrongAccount';
      else if (t.revocationDate) state = 'cancelled';
      await q(`insert into purchases(account_id, token, order_id, product_id, state, detail) values($1,$2,$3,$4,$5,$6)
               on conflict (token) do update set state=excluded.state, detail=excluded.detail, account_id=excluded.account_id`,
        [s.id, key, String(t.transactionId || '').slice(0, 64), t.productId, state, JSON.stringify({ store: 'app_store', environment: t.environment, purchaseDate: t.purchaseDate, transactionId: t.transactionId })]);
      if (state === 'purchased') await q(`update accounts set paid=true, paid_at=coalesce(paid_at, now()), paid_via='app_store' where id=$1`, [s.id]);
      const [acc2] = await q('select * from accounts where id=$1', [s.id]);
      return { ...(await statusPayload(acc2, s.device_row)), purchase: state };
    }
    const [old] = await q('select * from purchases where token=$1', [token]);
    if (old && old.account_id && old.account_id !== s.id) throw new HttpErr(409, 'purchaseOtherAccount');
    const v = await verifyPlay(token, productId).catch(e => ({ configured: true, error: e.message }));
    let state = 'review';
    if (v.configured && v.data) {
      const d = v.data;
      if (d.obfuscatedExternalAccountId && d.obfuscatedExternalAccountId !== s.public_id && await accountExists(d.obfuscatedExternalAccountId)) state = 'wrongAccount';
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
        (select count(*)::int from devices d where d.account_id=a.id and d.revoked) as blocked, a.apple_sub is not null as apple, a.email_verified, a.phone, a.phone_verified, a.twofa, a.terms_version, a.terms_at,
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
    else if (b.action === 'disable2fa') await q('update accounts set twofa=false where id=$1', [id]);
    else if (b.action === 'note') await q('update accounts set note=$2 where id=$1', [id, String(b.note || '').slice(0, 500)]);
    else if (b.action === 'delete') await q('delete from accounts where id=$1', [id]);
    else throw new HttpErr(400, 'badAction');
    return { ok: true };
  },
  'GET /admin/api/tickets': async (req) => { adminAuth(req);
    return { ok: true, tickets: await q(`select id, username, contact, subject, message, transcript, lang, device, status, created_at from support_tickets order by (status='open') desc, created_at desc limit 200`) }; },
  'POST /admin/api/ticket': async (req, b) => { adminAuth(req); await q('update support_tickets set status=$2 where id=$1', [+b.id, b.status === 'open' ? 'open' : 'closed']); return { ok: true }; },
  // Google / Apple accounts have no password: the web form files a deletion request that the admin completes after checking
  'POST /delete-account/request': async (req, b) => {
    limit('delreq:' + req.ip, 5, 3600e3);
    const username = normUser(b.username), contact = String(b.contact || '').slice(0, 120);
    if (!username || !contact) throw new HttpErr(400, 'missing');
    const [acc] = await q('select id, username, email from accounts where username=$1', [username]);
    await q(`insert into support_tickets(account_id, username, contact, subject, message, lang) values($1,$2,$3,$4,$5,'ar')`,
      [acc ? acc.id : null, username, contact, 'طلب حذف حساب (Google / Apple)', `طلب حذف الحساب من صفحة الحذف. ${acc ? 'البريد المسجل: ' + (acc.email || '—') : 'لا يوجد حساب بهذا الاسم.'}`]);
    return { ok: true };
  },
  'POST /delete-account': async (req, b) => {         // web form for Google Play's account-deletion requirement
    limit('del:' + req.ip, 10, 3600e3);
    const [acc] = await q('select * from accounts where username=$1', [normUser(b.username)]);
    limit('deluser:' + normUser(b.username), 10, 900e3);
    if (!acc || !checkPassword(String(b.password || ''), acc.pass_hash)) throw new HttpErr(401, 'badLogin');
    await q('delete from accounts where id=$1', [acc.id]);
    return { ok: true };
  },
};
let adminFails = { n: 0, until: 0 };
function adminAuth(req) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) throw new HttpErr(503, 'adminNotConfigured');
  if (adminFails.n >= 60 && Date.now() < adminFails.until) throw new HttpErr(429, 'tooMany');
  if (req.method === 'POST') {    // changes only from the admin page itself (blocks other sites from using a signed-in browser)
    const site = req.headers['sec-fetch-site'], origin = req.headers.origin;
    if (!/application\/json/.test(req.headers['content-type'] || '') || (site && !['same-origin', 'none'].includes(site)) || (origin && origin !== PUBLIC_URL && origin !== 'https://' + req.headers.host)) throw new HttpErr(403, 'badOrigin');
  }
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  const [u, p] = m ? Buffer.from(m[1], 'base64').toString().split(/:(.*)/s) : [];
  if (!m || !safeEq(u, ADMIN_USER) || !safeEq(p || '', ADMIN_PASSWORD)) { if (Date.now() > adminFails.until) adminFails = { n: 0, until: Date.now() + 3600e3 }; adminFails.n++; limit('admin:' + req.ip, 20, 600e3); throw new HttpErr(401, 'admin', { basic: true }); }
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
<h2>قراءة المخططات بالذكاء الاصطناعي</h2><p>عند اختيارك قراءة مخطط من صورة، تُرسل الصورة عبر خادمنا إلى مزوّد الذكاء الاصطناعي (Anthropic) لاستخراج أسماء الغرف ومقاساتها فقط، ولا نحتفظ بها. إذا لم تستخدم هذه الخاصية لا تُرسل أي صورة.</p>
<h2>بيانات الآخرين في رسائلك</h2><p>رسائل واتساب التي يحفظها التطبيق قد تحتوي أسماء وأرقام عملاء ومقاولين وأعضاء فريقك. تُحفظ على جهازك ونسخك الاحتياطية فقط، وأنت مسؤول عن استخدامها لأغراض عملك وبما يتفق مع القانون (ومنه قانون حماية البيانات الشخصية رقم 151 لسنة 2020).</p>
<h2>البريد ورقم الموبايل</h2><p>إذا أضفت بريدك أو رقم موبايلك نحفظهما لتأكيد الحساب واستعادة كلمة المرور والتحقق بخطوتين فقط. رموز البريد تُرسل عبر مزوّد البريد، ورموز SMS أو واتساب عبر Twilio، ولا نستخدم بياناتك للتسويق.</p>
<h2>العمل بدون إنترنت</h2><p>بعد كل تحقق ناجح يحصل جهازك على تصريح موقّع يسمح بالعمل بدون إنترنت لمدة ${OFFLINE_DAYS} أيام (وفي الفترة التجريبية حتى نهايتها)، ثم يلزم الاتصال للتحقق مرة أخرى.</p>
<h2>الحماية</h2><p>الاتصال بخادمنا مشفّر (HTTPS). تسجيل الدخول ينتهي بعد ${SESSION_DAYS} يومًا دون استخدام. قد يستخدم التطبيق خدمة Google Play Integrity للتأكد أنه النسخة الأصلية على جهاز سليم، وتُرسل Google لنا النتيجة فقط. بيانات التطبيق لا تُنسخ في نسخ Android الاحتياطية التلقائية ولا تنتقل لجهاز آخر إلا عبر النسخ الاحتياطي الذي تختاره، ويمكنك حماية ملف النسخة الاحتياطية بكلمة مرور (تشفير AES-256)؛ إذا نسيتها لا يمكن فتح الملف.</p>
<h2>المساعدة والدعم</h2><p>أسئلتك للمساعد الذكي داخل التطبيق (بعد تسجيل الدخول) تُرسل إلى خادمنا ومزوّد الذكاء الاصطناعي (Anthropic) لتوليد الرد فقط، ولا تُستخدم لأي غرض آخر. الطلبات المحوّلة للدعم تُحفظ لدينا مع اسم المستخدم لمتابعتها، وتُرسل بالبريد إلى ${SUPPORT_EMAIL}.</p>
<h2>الشراء والتحديثات</h2><p>النسخة الكاملة شراء لمرة واحدة عبر Google Play، وتشمل حق تنزيل التطبيق وجميع تحديثاته المستقبلية لنفس الحساب، وإعادة تثبيته على جهازك. الحساب يعمل على جهاز واحد، ويمكن نقله لجهاز جديد بعد الشراء، وعندها يُزال الجهاز القديم ولا يمكنه الدخول لهذا الحساب مرة أخرى. الفترة التجريبية مرة واحدة لكل جهاز. إذا استُرد مبلغ الشراء من Google Play يعود الحساب إلى النسخة المنتهية.</p>
<h2>حذف الحساب</h2><p>يمكنك حذف حسابك من داخل التطبيق (الحساب ← حذف الحساب) أو من <a href="/delete-account">صفحة حذف الحساب</a> (لحسابات Google وApple تُرسل طلبًا ونحذفه خلال 7 أيام). يُحذف الحساب وبيانات الأجهزة والجلسات فورًا. بيانات مشاريعك على جهازك ونسخك الاحتياطية تبقى ملكك وتحت تحكمك.</p>
<h2>الشروط والأحكام</h2><p>استخدام التطبيق يخضع <a href="/terms">للشروط والأحكام</a>.</p>
<h2>التواصل</h2><p>${CONTACT}</p>
<hr><h1 dir="ltr" style="text-align:left">Privacy policy and terms — Tashtibati</h1><div dir="ltr" style="text-align:left">
<p>Our server stores your username and a hashed password (or your Google / Apple account id, email and name when you sign in with them), trial dates, Google Play purchase details, and the id, type and model of your device, to apply the one-device-per-account rule and to give each device only one free trial. Project data stays on your device; backups go where you choose: a "Tashtibati" folder in your own Google Drive, a file on your device that you can send to any cloud, or iCloud on the iPhone version. Project data is never sent to our server. WhatsApp notification reading (only with your consent) happens on the device.</p>
<p>When you choose to read a floor plan from a photo, the photo is sent through our server to our AI provider (Anthropic) only to extract room names and sizes, and is not kept. WhatsApp messages the app keeps may contain names and numbers of clients, contractors and your team; they stay on your device and in your own backups, and you are responsible for using them lawfully for your work (including Egypt's Personal Data Protection Law No. 151 of 2020).</p>
<p>If you add your email or mobile number we keep them only to confirm your account, reset your password and for two-step sign-in. Email codes are sent through our email provider and SMS / WhatsApp codes through Twilio; your details are never used for marketing. After each successful check your device receives a signed pass that lets the app work without internet for ${OFFLINE_DAYS} days (during the trial, until it ends); then it needs a connection again.</p>
<p>Security: all traffic to our server is encrypted (HTTPS); a sign-in expires after ${SESSION_DAYS} days without use; the app may use Google Play Integrity to confirm it is the genuine app on a genuine device (Google sends us only the verdict); app data is excluded from Android's automatic backup and device-to-device transfer; backup files can be protected with a password (AES-256 encryption — a forgotten password cannot be recovered). If a Google Play purchase is refunded, the account returns to the expired state.</p>
<p>Questions to the in-app support assistant (when signed in) are sent to our server and our AI provider (Anthropic) only to produce the reply. Issues passed to support are stored with your username and emailed to ${SUPPORT_EMAIL}.</p>
<p>The full version is a one-time Google Play purchase and includes the right to download the app and all its future updates on the same account, and to reinstall it on your device. An account works on one device; after purchase it can be moved to a new device, and the old device is then removed and cannot sign in to that account again. You can delete your account in the app or at <a href="/delete-account">/delete-account</a> (Google / Apple accounts: send a request there and we delete it within 7 days). Contact: ${CONTACT}</p></div>`);

const TERMS_PAGE = termsHtml();
const htmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SUPPORT_PAGE = page('الدعم — تشطيباتى · Tashtibati Support', `<h1>الدعم الفني — تشطيباتى</h1>
<div class="card"><p>للمساعدة أو الاستفسار أو الإبلاغ عن مشكلة راسلنا على <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> ونرد عادةً خلال يومي عمل. داخل التطبيق: زر الحساب ← «المساعدة».</p>
<p dir="ltr" style="text-align:left">For help, questions or to report a problem, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. We usually reply within two working days. In the app: Account → Help.</p>
<p><a href="/terms">الشروط والأحكام · Terms</a> &nbsp;·&nbsp; <a href="/privacy">سياسة الخصوصية · Privacy</a> &nbsp;·&nbsp; <a href="/delete-account">حذف الحساب · Delete account</a></p></div>
<h2>أسئلة شائعة</h2>${HELP.map(h => `<div class="card"><b>${htmlEsc(h.ar.t)}</b><p>${htmlEsc(h.ar.b)}</p></div>`).join('')}
<h2 dir="ltr" style="text-align:left">Frequently asked questions</h2>${HELP.map(h => `<div class="card" dir="ltr" style="text-align:left"><b>${htmlEsc(h.en.t)}</b><p>${htmlEsc(h.en.b)}</p></div>`).join('')}
<p class="muted">© ${new Date().getFullYear()} Ehab Ahmed Abdel Hamid Fahmy · ايهاب احمد عبد الحميد فهمى</p>`);

const DELETE_PAGE = page('حذف الحساب — تشطيباتى', `<h1>حذف حساب تشطيباتى</h1><p class="muted">يحذف الحساب وحالة الشراء والأجهزة المسجلة نهائيًا. بيانات المشاريع على جهازك وفي Google Drive لا تتأثر.</p>
<form class="card" id="f"><p><label>اسم المستخدم<br><input name="username" autocomplete="username" required></label></p><p><label>كلمة المرور<br><input name="password" type="password" autocomplete="current-password" required></label></p>
<button>حذف الحساب نهائيًا</button><p id="m" role="status"></p></form>
<h2>دخلت بحساب Google أو Apple؟</h2><p class="muted">الأسرع: من داخل التطبيق ← الحساب ← حذف الحساب (فوري). أو أرسل طلب الحذف هنا: نتأكد أن الحساب لك عبر وسيلة التواصل التي تكتبها، ثم نحذفه خلال 7 أيام.</p>
<form class="card" id="f2"><p><label>اسم المستخدم (يظهر في التطبيق ← الحساب)<br><input name="username" required></label></p><p><label>البريد أو رقم الهاتف للتواصل<br><input name="contact" required></label></p>
<button>إرسال طلب الحذف</button><p id="m2" role="status"></p></form>
<script>const post=(u,f)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))}).then(r=>r.json()).catch(()=>({}));
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const j=await post('/delete-account',e.target);document.getElementById('m').textContent=j.ok?'تم حذف الحساب.':j.error==='tooMany'?'محاولات كثيرة، حاول لاحقًا.':'اسم المستخدم أو كلمة المرور غير صحيحة.';};
document.getElementById('f2').onsubmit=async e=>{e.preventDefault();const j=await post('/delete-account/request',e.target);document.getElementById('m2').textContent=j.ok?'تم استلام طلبك. سنتواصل معك للتأكيد ثم نحذف الحساب.':'تعذر الإرسال، حاول لاحقًا.';};</script>`);

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
 $('#rows').innerHTML=j.accounts.map(a=>'<tr><td><b>'+esc(a.username)+'</b>'+(a.google?' <span class="pill trial">Google</span>':'')+(a.apple?' <span class="pill trial">Apple</span>':'')+(a.email?'<br><span class="muted">'+esc(a.email)+(a.email_verified?' ✓':'')+'</span>':'')+(a.phone?'<br><span class="muted" dir="ltr">'+esc(a.phone)+(a.phone_verified?' ✓':'')+'</span>':'')+(a.twofa?' <span class="pill paid">2FA</span>':'')+'<br><span class="muted">'+(a.terms_version?'الشروط '+esc(a.terms_version)+' · '+d(a.terms_at):'لم يوافق على الشروط بعد')+'</span>'+'<br><span class="muted">'+d(a.created_at)+'</span>'+(a.note?'<br><span class="muted">'+esc(a.note)+'</span>':'')+'</td>'+
 '<td><span class="pill '+a.state+'">'+st[a.state]+'</span><br><span class="muted">'+(a.paid?('منذ '+d(a.paid_at)+' · '+esc(a.paid_via||'')):('حتى '+d(a.trial_ends)))+'</span></td>'+
 '<td>'+((a.devices||[]).map(x=>esc(x.kind==='tablet'?'تابلت':'هاتف')+' '+esc(x.model)+' <button class="ghost" data-a="removeDevice" data-id="'+a.id+'" data-dev="'+x.id+'">إزالة</button><br><span class="muted">'+d(x.lastSeen)+'</span>').join('<br>')||'—')+'</td>'+
 '<td>'+((a.purchases||[]).map(p=>esc(p.order||'')+' <b>'+esc(p.state)+'</b>').join('<br>')||'—')+'</td>'+
 '<td style="display:flex;gap:6px;flex-wrap:wrap">'+(a.paid?'<button class="ghost" data-a="markUnpaid" data-id="'+a.id+'">إلغاء التفعيل</button>':'<button data-a="markPaid" data-id="'+a.id+'">تفعيل كمدفوع</button>')+
 (a.blocked?'<button class="ghost" data-a="unblockDevices" data-id="'+a.id+'">إلغاء حظر '+a.blocked+' جهاز قديم</button>':'')+'<button class="ghost" data-a="extendTrial" data-id="'+a.id+'">+7 أيام</button><button class="ghost" data-a="resetDevices" data-id="'+a.id+'">إعادة ضبط الأجهزة</button>'+(a.twofa?'<button class="ghost" data-a="disable2fa" data-id="'+a.id+'">إيقاف التحقق بخطوتين</button>':'')+'<button class="ghost" data-a="note" data-id="'+a.id+'">ملاحظة</button></td></tr>').join('');}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-a]');if(!b)return;const body={id:+b.dataset.id,action:b.dataset.a,deviceId:+b.dataset.dev||undefined,days:7};
 if(body.action==='note'){const n=prompt('ملاحظة');if(n==null)return;body.note=n;}
 if(['resetDevices','markUnpaid','removeDevice','unblockDevices','disable2fa'].includes(body.action)&&!confirm('تأكيد؟'))return;
 await fetch('/admin/api/account',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});load();});
async function loadT(){const j=await (await fetch('/admin/api/tickets')).json();
 $('#tickets').innerHTML=j.tickets.length?'<table><thead><tr><th>#</th><th>المستخدم</th><th>المشكلة</th><th>الحالة</th></tr></thead><tbody>'+j.tickets.map(t=>'<tr><td>'+t.id+'<br><span class="muted">'+d(t.created_at)+'</span></td><td>'+esc(t.username||'—')+'<br><span class="muted">'+esc(t.contact||'')+' '+esc(t.device||'')+'</span></td><td><b>'+esc(t.subject||'')+'</b><br><span style="white-space:pre-wrap">'+esc(t.message||'')+'</span>'+((t.transcript||[]).length?'<details><summary class="muted">المحادثة</summary>'+(t.transcript||[]).map(m=>'<p><b>'+(m.role==='assistant'?'المساعد':'المستخدم')+':</b> '+esc(m.content)+'</p>').join('')+'</details>':'')+'</td><td><span class="pill '+(t.status==='open'?'expired':'paid')+'">'+(t.status==='open'?'مفتوح':'مغلق')+'</span><br><button class="ghost" data-t="'+t.id+'" data-s="'+(t.status==='open'?'closed':'open')+'">'+(t.status==='open'?'إغلاق':'إعادة فتح')+'</button></td></tr>').join('')+'</tbody></table>':'<p class="muted">لا توجد طلبات.</p>';}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-t]');if(!b)return;await fetch('/admin/api/ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:+b.dataset.t,status:b.dataset.s})});loadT();});
loadT();$('#go').onclick=load;$('#q').onkeydown=e=>{if(e.key==='Enter')load();};load();
</script>`);

// ---------- server ----------
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const site = res.isAdmin ? { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' }
    : { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'x-frame-options': 'SAMEORIGIN' };
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'strict-transport-security': 'max-age=31536000', ...site, ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  req.ip = clientIp(req);
  const url = new URL(req.url, 'http://x');
  res.isAdmin = url.pathname.startsWith('/admin');
  // shows (in the server log) which forwarding headers Render passes, for the first requests after each start; no addresses are kept
  if (ipDiag < 5 && url.pathname.startsWith('/api/')) { ipDiag++; const h = req.headers; console.log('ipcheck', JSON.stringify({ tci: !!h['true-client-ip'], cf: !!h['cf-connecting-ip'], xffParts: String(h['x-forwarded-for'] || '').split(',').filter(Boolean).length, sameAsTci: !!h['true-client-ip'] && String(h['x-forwarded-for'] || '').includes(h['true-client-ip']) })); }
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/privacy')) return send(res, 200, PRIVACY, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/delete-account') return send(res, 200, DELETE_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/support') return send(res, 200, SUPPORT_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/terms') return send(res, 200, TERMS_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/admin') { adminAuth(req); return send(res, 200, ADMIN_PAGE, 'text/html; charset=utf-8'); }
    const h = routes[`${req.method} ${url.pathname}`];
    if (h && !dbReady && url.pathname !== '/health') throw new HttpErr(503, 'starting');
    if (!h) return send(res, 404, { ok: false, error: 'notFound' });
    let body = {};
    if (req.method === 'POST') {
      const max = url.pathname === '/api/plan-read' ? 9e6 : 65536;
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > max) throw new HttpErr(413, 'tooLarge'); }
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
let ipDiag = 0;
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
  try { await migrate(); await seedTestUser(); dbReady = true; console.log('database ready'); setTimeout(checkVoided, 60e3); } catch (e) { console.error('database not ready:', e.message); setTimeout(connectDb, 10000); }
}
setInterval(() => { if (dbReady) q(`delete from sessions where last_seen < now() - ($1 || ' days')::interval`, [String(SESSION_DAYS)]).catch(() => {}); }, 3600e3).unref();
if (require.main === module) { server.listen(PORT, () => console.log('tashtibati server on', PORT)); connectDb(); }
else dbReady = true;
module.exports = { server, migrate, pool, checkVoided };
