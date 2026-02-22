import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// ── Load config ─────────────────────────────────────────
const sources = JSON.parse(fs.readFileSync(path.join(DATA, 'sources.json'), 'utf-8')).sources;
const subscribers = JSON.parse(fs.readFileSync(path.join(DATA, 'subscribers.json'), 'utf-8')).subscribers;
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(path.join(DATA, 'cache.json'), 'utf-8'));
} catch { cache = {}; }

// ── Email setup ─────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
if (!RESEND_API_KEY) {
  console.error('RESEND_API_KEY is not set. Skipping email sending.');
}
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ── Scraping helpers ────────────────────────────────────
const NAV_EXCLUDE = /\/(about|contact|join|login|signup|register|privacy|terms|careers|faq|help|sitemap|websites)\b/i;
const NAV_TEXT = /^(about|contact|关于|加入|广告|联系|login|signup|home|首页|more|查看更多|加载更多|订阅)/i;

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function resolve(base, rel) {
  if (!rel) return '';
  try { return new URL(rel, base).href; } catch { return ''; }
}

function isTitle(text) {
  const t = (text || '').trim();
  if (t.length < 4 || t.length > 300) return false;
  if (NAV_TEXT.test(t)) return false;
  if (t.length < 6 && !/[\u4e00-\u9fff]/.test(t)) return false;
  return true;
}

async function fetchPage(url) {
  const { data } = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    },
  });
  return data;
}

function scrape(html, baseUrl) {
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();

  // Strategy: find all <a> with meaningful text, filter out nav
  const mainArea = $('main, #content, .content, [role="main"], body');
  mainArea.find('a').each((_, el) => {
    const $a = $(el);
    if ($a.closest('nav, header, footer, [class*="nav"], [class*="menu"], [class*="sidebar"], [class*="footer"]').length) return;

    const href = $a.attr('href') || '';
    const link = resolve(baseUrl, href);
    if (!link || NAV_EXCLUDE.test(link)) return;
    // Must be same domain or relative
    try {
      const linkHost = new URL(link).hostname;
      const baseHost = new URL(baseUrl).hostname;
      if (linkHost !== baseHost) return;
    } catch { return; }

    let title = $a.text().trim().replace(/\s+/g, ' ');
    if (!isTitle(title)) return;

    const hash = md5(title + '||' + link);
    if (seen.has(hash)) return;
    seen.add(hash);

    // Find summary near the link
    let summary = '';
    const parent = $a.closest('div, li, section, article, [class*="item"]');
    if (parent.length) {
      const pEl = parent.find('p, .desc, .summary, .excerpt, .abstract, [class*="abstract"], [class*="desc"]').first();
      if (pEl.length) {
        summary = pEl.text().trim();
        if (summary === title) summary = '';
        if (summary.length > 250) summary = summary.substring(0, 247) + '...';
      }
    }

    // Find image near the link
    let image = '';
    if (parent.length) {
      const img = parent.find('img').first();
      if (img.length) {
        image = resolve(baseUrl, img.attr('src') || img.attr('data-src') || img.attr('data-original') || '');
      }
    }

    articles.push({ title, summary, image, link, hash });
  });

  return articles;
}

// ── Email template ──────────────────────────────────────
function buildEmailHtml(sourceName, date, articles) {
  const rows = articles.map(a => {
    const imgCell = a.image
      ? `<td style="width:160px;vertical-align:top;padding-left:16px">
           <img src="${esc(a.image)}" alt="" style="width:160px;height:auto;max-height:120px;border-radius:6px;display:block;object-fit:cover" />
         </td>`
      : '';
    return `
    <tr><td style="padding:20px 0;border-bottom:1px solid #eee">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:top">
          <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.4;color:#1a1a1a;text-transform:uppercase">${esc(a.title)}</h2>
          ${a.summary ? `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:#666">${esc(a.summary)}</p>` : ''}
          <a href="${esc(a.link)}" style="font-size:13px;color:#2563eb;text-decoration:none">Read article →</a>
        </td>
        ${imgCell}
      </tr></table>
    </td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5">
<tr><td align="center" style="padding:24px 16px">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <tr><td style="background:#111;padding:24px 28px">
      <h1 style="margin:0;font-size:20px;font-weight:700;color:#fff">${esc(sourceName)}</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#999">${date} Updates</p>
    </td></tr>
    <tr><td style="padding:8px 28px 20px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr>
    <tr><td style="background:#fafafa;padding:16px 28px;border-top:1px solid #eee">
      <p style="margin:0;font-size:11px;color:#999;text-align:center">Sent by Newsletter Manager via GitHub Actions</p>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];
  let cacheUpdated = false;
  let totalNewArticles = 0;

  for (const source of sources) {
    console.log(`\n📡 Checking: ${source.name} (${source.url})`);

    let articles;
    try {
      const html = await fetchPage(source.url);
      articles = scrape(html, source.url);
      console.log(`   Found ${articles.length} articles`);
    } catch (err) {
      console.error(`   ❌ Failed to fetch: ${err.message}`);
      continue;
    }

    if (articles.length === 0) {
      console.log('   No articles found');
      continue;
    }

    // Check which articles are new
    const sourceKey = md5(source.url);
    const prevHashes = cache[sourceKey] || [];
    const prevSet = new Set(prevHashes);
    const newArticles = articles.filter(a => !prevSet.has(a.hash));

    console.log(`   New articles: ${newArticles.length}`);

    if (newArticles.length === 0) {
      console.log('   No updates, skip email');
      continue;
    }

    totalNewArticles += newArticles.length;

    // Update cache with ALL current article hashes
    cache[sourceKey] = articles.map(a => a.hash);
    cacheUpdated = true;

    // Send email
    if (!resend || subscribers.length === 0) {
      console.log('   ⚠️  No email service or subscribers configured, skipping send');
      continue;
    }

    const subject = `${source.name} ${today} Updates`;
    const html = buildEmailHtml(source.name, today, newArticles);

    for (const email of subscribers) {
      if (!email || email === 'your-email@example.com') continue;
      try {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject,
          html,
        });
        if (error) {
          console.error(`   ❌ Failed to send to ${email}: ${error.message}`);
        } else {
          console.log(`   ✉️  Sent to ${email}`);
        }
      } catch (err) {
        console.error(`   ❌ Error sending to ${email}: ${err.message}`);
      }
    }
  }

  // Save cache
  if (cacheUpdated) {
    fs.writeFileSync(path.join(DATA, 'cache.json'), JSON.stringify(cache, null, 2));
    console.log('\n💾 Cache updated');
  }

  console.log(`\n✅ Done. Total new articles: ${totalNewArticles}`);

  // Set output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_articles=${totalNewArticles}\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
