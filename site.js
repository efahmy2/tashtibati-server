// Public website for tashtibati.com: the home page (Arabic at "/", English at "/en") and its images under /site/.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'site');
const TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const FILES = {};
for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
  const t = TYPES[path.extname(f)]; if (t) FILES[f] = { type: t, body: fs.readFileSync(path.join(DIR, f)) };
}

const T = {
  ar: {
    dir: 'rtl', lang: 'ar', other: '/en', otherLabel: 'English',
    title: 'تشطيباتى — كل حسابات مشروعاتك… منظّمة',
    desc: 'تطبيق لمهندسي ومقاولي التشطيبات: عهدة كل مشروع، المصروفات، تحويلات واتساب، اتفاقات المقاولين، المقاسات، وتقرير Excel بضغطة.',
    name: 'تشطيباتى', tag: 'كل حسابات مشروعاتك… منظّمة', sub: 'للمهندسين ومقاولي التشطيبات',
    lead: 'من أول تحويل من العميل حتى التسليم: الرصيد، والمصروفات، وأتعابك، واتفاقات المقاولين ومقاسات الغرف — في مكان واحد، على موبايلك.',
    play: 'احصل عليه من', playStore: 'Google Play', ios: 'حمّله من', iosStore: 'App Store', soon: 'قريبًا',
    trial: 'جرّب كل المزايا مجانًا ٧ أيام',
    featTitle: 'كل ما تحتاجه لإدارة حسابات الموقع',
    feats: [
      ['رصيد العهدة لحظة بلحظة', 'الوارد من العميل، والمنصرف، والمتبقي، وأتعابك محسوبة تلقائيًا: نسبة من المصروفات، أو مبلغ مقطوع، أو بالمتر.'],
      ['تحويلات واتساب', 'شارك رسالة التحويل أو صورة الإيصال، فيقرأ التطبيق المبلغ ويضيفه للمشروع الصحيح بعد موافقتك.'],
      ['المصروفات حسب البند', 'مواد، يوميات، مقاولين، إيجارات، إكراميات — مع صور الفواتير.'],
      ['اتفاقات المقاولين', 'سعر كل بند وحالته من عرض السعر حتى المحاسبة، والمدفوع والمتبقي لكل مقاول.'],
      ['المواصفات والمقاسات', 'الأدوار والغرف والأبواب والشبابيك، ومساحات الأرضيات والحوائط محسوبة — أو اقرأها من صورة المخطط.'],
      ['تقرير Excel بضغطة', 'الحركة والمقاولين والمواد والمقاسات في ملف واحد تشاركه مع العميل.'],
    ],
    shotsTitle: 'بسيط وواضح، بالعربي والإنجليزي',
    shots: ['الشاشة الرئيسية', 'دفتر الحساب', 'تحويلات واتساب', 'ملخص المشروع'],
    dataTitle: 'بياناتك تحت تحكمك',
    data: ['بيانات المشاريع محفوظة على جهازك، مع نسخة احتياطية مشفّرة بكلمة مرور على Google Drive أو iCloud أو أي مكان تختاره.', 'يعمل بدون إنترنت لعدة أيام.', 'تسجيل دخول آمن، واستعادة كلمة المرور بالبريد أو الموبايل، وتحقق بخطوتين اختياري.'],
    priceTitle: 'السعر', price: 'جرّب كل المزايا مجانًا ٧ أيام، ثم شراء لمرة واحدة من داخل التطبيق يفتح النسخة الكاملة ويشمل كل التحديثات القادمة. بدون اشتراك شهري.',
    contact: 'تواصل معنا', privacy: 'سياسة الخصوصية', terms: 'الشروط والأحكام', support: 'الدعم', del: 'حذف الحساب',
    owner: 'ايهاب احمد عبد الحميد فهمى',
  },
  en: {
    dir: 'ltr', lang: 'en', other: '/', otherLabel: 'العربية',
    title: 'Tashtibati — All your projects’ accounts, organised',
    desc: 'An app for finishing engineers and contractors: site cash per project, expenses, WhatsApp transfers, contractor agreements, room sizes and an Excel report in one tap.',
    name: 'Tashtibati', tag: 'All your projects’ accounts, organised', sub: 'For finishing engineers and contractors',
    lead: 'From the client’s first transfer to handover: balance, expenses, your fee, contractor agreements and room sizes — in one place, on your phone.',
    play: 'Get it on', playStore: 'Google Play', ios: 'Download on the', iosStore: 'App Store', soon: 'Coming soon',
    trial: 'Try every feature free for 7 days',
    featTitle: 'Everything you need to run site accounts',
    feats: [
      ['Site cash, always up to date', 'Money in from the client, money spent, what’s left, and your fee calculated for you: a percentage, a lump sum, or per square metre.'],
      ['WhatsApp transfers', 'Share a transfer message or receipt photo; the app reads the amount and adds it to the right project once you approve.'],
      ['Spending by category', 'Materials, daily labour, contractors, rentals and tips — with invoice photos.'],
      ['Contractor agreements', 'Each item’s price and status from quote to settlement, and paid vs remaining for every contractor.'],
      ['Specs and measurements', 'Floors, rooms, doors and windows, with floor and wall areas calculated — or read sizes from a floor-plan photo.'],
      ['Excel report in one tap', 'Ledger, contractors, materials and measurements in one file to share with your client.'],
    ],
    shotsTitle: 'Simple and clear, in Arabic and English',
    shots: ['Home', 'Ledger', 'WhatsApp transfers', 'Project summary'],
    dataTitle: 'Your data, your control',
    data: ['Project data stays on your device, with a password-encrypted backup to Google Drive, iCloud or anywhere you choose.', 'Works offline for a few days.', 'Secure sign-in, password reset by email or mobile, and optional two-step sign-in.'],
    priceTitle: 'Price', price: 'Try everything free for 7 days, then a one-time in-app purchase unlocks the full version, including all future updates. No monthly subscription.',
    contact: 'Contact us', privacy: 'Privacy policy', terms: 'Terms and conditions', support: 'Support', del: 'Delete account',
    owner: 'Ehab Ahmed Abdel Hamid Fahmy',
  },
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICONS = [
  '<path d="M3 7h18v12H3z"/><path d="M16 13h2"/><path d="M3 10h18"/>',
  '<path d="M4 20l1.5-4.5A8 8 0 1 1 9 19z"/><path d="M9 11h6M9 14h4"/>',
  '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  '<path d="M8 11l3 3 5-6"/><rect x="3" y="4" width="18" height="16" rx="2"/>',
  '<path d="M3 21V9l9-6 9 6v12z"/><path d="M9 21v-6h6v6"/>',
  '<path d="M4 4h16v16H4z"/><path d="M4 10h16M10 4v16"/>',
];

function page(lang, opts) {
  const t = T[lang], base = opts.base || '';
  const store = (href, top, bottom, icon) => href
    ? `<a class="store" href="${esc(href)}" rel="noopener">${icon}<span><small>${top}</small><b>${bottom}</b></span></a>`
    : `<span class="store off" aria-disabled="true">${icon}<span><small>${t.soon}</small><b>${bottom}</b></span></span>`;
  const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 2.5v19l10.5-9.5zM15.8 13.2l2.6 2.4-11 6.2zM15.8 10.8L7.4 2.2l11 6.2zM19.6 9.4l2.4 1.4c.8.5.8 1.8 0 2.3l-2.4 1.4-2.8-2.5z"/></svg>';
  const appleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9c-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM13.9 5c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z"/></svg>';
  const url = `${base}${lang === 'ar' ? '/' : '/en'}`;
  return `<!doctype html><html lang="${t.lang}" dir="${t.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title><meta name="description" content="${esc(t.desc)}">
<link rel="canonical" href="${esc(url)}"><link rel="alternate" hreflang="ar" href="${esc(base)}/"><link rel="alternate" hreflang="en" href="${esc(base)}/en">
<meta property="og:title" content="${esc(t.title)}"><meta property="og:description" content="${esc(t.desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(base)}/site/og.jpg"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/site/favicon.png"><link rel="apple-touch-icon" href="/site/apple-touch-icon.png"><meta name="theme-color" content="#0d2c55">
<style>
:root{--ink:#14202e;--muted:#5a6676;--bg:#f4f6f9;--card:#fff;--line:#dfe4ea;--blue:#1f4e8c;--deep:#0d2c55;--gold:#ffb300;--r:20px}
*{box-sizing:border-box;margin:0}html{scroll-behavior:smooth}
body{font:17px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans Arabic",Tahoma,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:inherit}img{max-width:100%;height:auto;display:block}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.top{position:absolute;inset:0 0 auto;z-index:2}.top .wrap{display:flex;align-items:center;gap:12px;padding-block:18px;color:#fff}
.top img{width:40px;height:40px;border-radius:11px}.top b{font-size:19px}.top .lang{margin-inline-start:auto;text-decoration:none;font-weight:600;padding:8px 14px;border:1px solid rgba(255,255,255,.35);border-radius:999px;font-size:15px}
.hero{position:relative;color:#fff;background:linear-gradient(170deg,#1b4a86 0%,#0f3363 55%,#0a2244 100%);overflow:hidden;padding:120px 0 0}
.hero:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);background-size:120px 120px,120px 120px,24px 24px,24px 24px;pointer-events:none}
.hero .wrap{position:relative;display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:end}
.hero h1{font-size:clamp(34px,5.4vw,58px);line-height:1.15;color:var(--gold);font-weight:800;letter-spacing:${lang === 'en' ? '-.5px' : '0'}}
.hero .sub{font-size:19px;opacity:.8;margin:10px 0 18px}.hero .lead{font-size:18px;opacity:.92;max-width:34em}
.stores{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0 10px}
.store{display:inline-flex;align-items:center;gap:10px;background:#000;color:#fff;text-decoration:none;border-radius:12px;padding:9px 18px 9px 14px;border:1px solid rgba(255,255,255,.25);min-width:180px}
.store svg{width:26px;height:26px}.store span{display:flex;flex-direction:column;line-height:1.15}.store small{font-size:11px;opacity:.85}.store b{font-size:19px;white-space:nowrap}.store.off{opacity:.55}
.trial{font-size:15px;opacity:.85;padding-bottom:40px}
.devices{position:relative;height:470px}.devices .phone{position:absolute;width:228px;bottom:-30px;border-radius:34px;padding:9px;background:#0b0f0d;box-shadow:0 30px 70px rgba(0,0,0,.45)}
.devices .phone img{border-radius:26px}.devices .p1{inset-inline-start:6%;transform:rotate(${lang === 'ar' ? '5' : '-5'}deg)}.devices .p2{inset-inline-start:44%;bottom:-60px;transform:rotate(${lang === 'ar' ? '-4' : '4'}deg)}
section{padding:72px 0}h2{font-size:clamp(26px,3.4vw,36px);line-height:1.25;margin-bottom:28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.feat{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:24px}
.feat svg{width:40px;height:40px;padding:8px;border-radius:12px;background:#eaf0f8;stroke:var(--blue);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;margin-bottom:12px}
.feat h3{font-size:19px;margin-bottom:6px}.feat p{color:var(--muted);font-size:16px}
.shots{display:flex;gap:18px;overflow-x:auto;padding-bottom:10px;scroll-snap-type:x mandatory}
.shots figure{flex:0 0 220px;scroll-snap-align:start}.shots img{border-radius:26px;border:8px solid #0b0f0d;background:#0b0f0d}
.shots figcaption{text-align:center;color:var(--muted);font-size:15px;margin-top:10px}
.tablet{margin-top:34px;border-radius:24px;border:12px solid #0b0f0d;background:#0b0f0d;box-shadow:0 20px 50px rgba(13,44,85,.18)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.box{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:28px}
.box ul{padding-inline-start:20px;color:var(--muted)}.box li{margin:8px 0}.box p{color:var(--muted)}
.price{background:var(--deep);color:#fff;border:0}.price h2{color:var(--gold)}.price p{color:#dce6f3}
footer{background:#0a1a30;color:#c5d2e2;padding:40px 0;font-size:15px}
footer .wrap{display:flex;flex-wrap:wrap;gap:16px 28px;align-items:center;justify-content:space-between}
footer nav{display:flex;flex-wrap:wrap;gap:10px 22px}footer a{text-decoration:none}footer a:hover{color:#fff;text-decoration:underline}
@media (max-width:860px){.hero .wrap{grid-template-columns:1fr}.devices{height:380px}.devices .phone{width:190px}.grid{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}}
@media (max-width:560px){body{font-size:16px}.grid{grid-template-columns:1fr}.devices{height:330px}.devices .phone{width:160px}.devices .p1{inset-inline-start:2%}.devices .p2{inset-inline-start:40%}.store{min-width:0;flex:1;padding-inline:12px}.store b{font-size:17px}section{padding:52px 0}}
</style></head><body>
<header class="top"><div class="wrap"><img src="/site/icon.png" alt=""><b>${esc(t.name)}</b><a class="lang" href="${t.other}" hreflang="${lang === 'ar' ? 'en' : 'ar'}">${t.otherLabel}</a></div></header>
<div class="hero"><div class="wrap">
  <div><h1>${esc(t.tag)}</h1><p class="sub">${esc(t.sub)}</p><p class="lead">${esc(t.lead)}</p>
    <div class="stores">${store(opts.playUrl, t.play, t.playStore, playIcon)}${store(opts.iosUrl, t.ios, t.iosStore, appleIcon)}</div>
    <p class="trial">${esc(t.trial)}</p></div>
  <div class="devices" aria-hidden="true"><div class="phone p1"><img src="/site/${lang}-home.webp" alt="" width="420" height="909"></div><div class="phone p2"><img src="/site/${lang}-ledger.webp" alt="" width="420" height="909"></div></div>
</div></div>
<main>
<section><div class="wrap"><h2>${esc(t.featTitle)}</h2><div class="grid">
${t.feats.map((f, i) => `<div class="feat"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[i]}</svg><h3>${esc(f[0])}</h3><p>${esc(f[1])}</p></div>`).join('')}
</div></div></section>
<section style="padding-top:0"><div class="wrap"><h2>${esc(t.shotsTitle)}</h2><div class="shots">
${['home', 'ledger', 'transfers', 'summary'].map((s, i) => `<figure><img src="/site/${lang}-${s}.webp" alt="${esc(t.shots[i])}" width="420" height="909" loading="lazy"><figcaption>${esc(t.shots[i])}</figcaption></figure>`).join('')}
</div><img class="tablet" src="/site/${lang}-tablet.webp" alt="${esc(t.shots[1])} — iPad" loading="lazy" width="1100" height="688"></div></section>
<section style="padding-top:0"><div class="wrap two">
  <div class="box"><h2>${esc(t.dataTitle)}</h2><ul>${t.data.map(d => `<li>${esc(d)}</li>`).join('')}</ul></div>
  <div class="box price"><h2>${esc(t.priceTitle)}</h2><p>${esc(t.price)}</p><div class="stores">${store(opts.playUrl, t.play, t.playStore, playIcon)}${store(opts.iosUrl, t.ios, t.iosStore, appleIcon)}</div></div>
</div></section>
</main>
<footer><div class="wrap">
  <nav><a href="/support">${t.support}</a><a href="/privacy">${t.privacy}</a><a href="/terms">${t.terms}</a><a href="/delete-account">${t.del}</a><a href="mailto:${esc(opts.email)}">${t.contact}: ${esc(opts.email)}</a></nav>
  <span>© ${new Date().getFullYear()} ${esc(t.owner)}</span>
</div></footer>
</body></html>`;
}

/** Handles "/", "/en" and "/site/*". Returns true when it answered. */
function handle(req, res, url, send, opts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname === '/' || url.pathname === '/en' || url.pathname === '/ar') {
    const lang = url.pathname === '/en' ? 'en' : 'ar';
    send(res, 200, page(lang, opts), 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300', 'content-language': lang });
    return true;
  }
  if (url.pathname.startsWith('/site/')) {
    const f = FILES[url.pathname.slice(6)];
    if (!f) return false;
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'public, max-age=604800', 'x-content-type-options': 'nosniff', 'content-length': f.body.length });
    res.end(req.method === 'HEAD' ? undefined : f.body);
    return true;
  }
  return false;
}

module.exports = { handle, page };
