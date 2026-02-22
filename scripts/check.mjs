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

// ── Filtering rules ─────────────────────────────────────

// Links to EXCLUDE (non-article pages)
const JUNK_LINK_PATTERNS = [
  /\/(about|contact|join|login|signup|register|privacy|terms|careers|faq|help|sitemap)\b/i,
  /\/(websites|tag|label|category|search|archive|page)\//i,
  /\/#/,                        // anchor links
  /^mailto:/i,
  /^javascript:/i,
  /\/(index|home)\/?$/i,        // homepage links
];

// Titles to EXCLUDE (nav items, UI text, labels)
const JUNK_TITLE_PATTERNS = [
  /^(about|contact|关于|加入|广告|联系|login|signup|home|首页)/i,
  /^(more|查看更多|加载更多|订阅|subscribe|read more)/i,
  /^(skip to|跳到|↓|↑|←|→)/i,    // accessibility / nav arrows
  /^(portfolio|blog|posts|tags|categories|archive)$/i,  // section headings
  /^(menu|search|close|open|toggle)$/i,
  /^[·\s]*[\u4e00-\u9fff]{1,2}[·\s]*$/,  // short labels like "· 腾讯", "阿里"
  /^\d{1,2}月\d{1,2}日$/,        // date-only text
];

// Image URLs to EXCLUDE (icons, arrows, tiny UI images)
const JUNK_IMAGE_PATTERNS = [
  /arrow/i,
  /icon/i,
  /logo/i,
  /favicon/i,
  /tip\d*\.png/i,
  /dujia\.png/i,
  /default\.png/i,
  /spinner|loading|placeholder/i,
  /\.svg$/i,                     // SVG icons
  /1x1|spacer|pixel|blank/i,    // tracking pixels
];

// Link patterns that suggest this is an actual article
const ARTICLE_LINK_PATTERNS = [
  /[?&]id=\d+/,                 // ?id=123
  /\/\d{4}[\/-]\d{2}/,          // /2024/01 or /2024-01
  /\/posts?\//i,                 // /post/ or /posts/
  /\/blog\//i,
  /\/news\//i,
  /\/article/i,
  /\/detail/i,
  /\/story/i,
  /\/p\//i,
  /\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i, // slugs like /my-first-post
];

// ── Helpers ─────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function resolve(base, rel) {
  if (!rel) return '';
  try { return new URL(rel, base).href; } catch { return ''; }
}

function isJunkLink(link, baseUrl) {
  if (!link) return true;
  for (const p of JUNK_LINK_PATTERNS) if (p.test(link)) return true;
  // Must be same domain
  try {
    if (new URL(link).hostname !== new URL(baseUrl).hostname) return true;
  } catch { return true; }
  // Must look like an article link (has path beyond just /)
  const pathname = new URL(link).pathname;
  if (pathname === '/' || pathname === '') return true;
  return false;
}

function isArticleLink(link) {
  for (const p of ARTICLE_LINK_PATTERNS) if (p.test(link)) return true;
  return false;
}

function isJunkTitle(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 4 || t.length > 300) return true;
  for (const p of JUNK_TITLE_PATTERNS) if (p.test(t)) return true;
  // Very short non-CJK text is likely a nav label
  if (t.length < 8 && !/[\u4e00-\u9fff]/.test(t)) return true;
  // Very short CJK text (< 4 chars) is likely a tag/label
  const cjkOnly = t.replace(/[^\u4e00-\u9fff]/g, '');
  if (cjkOnly.length > 0 && cjkOnly.length <= 2 && t.length < 6) return true;
  return false;
}

function isJunkImage(url) {
  if (!url) return true;
  for (const p of JUNK_IMAGE_PATTERNS) if (p.test(url)) return true;
  return false;
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

// ── Scraping ────────────────────────────────────────────

function scrape(html, baseUrl) {
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();     // dedup by link
  const seenTitles = new Set(); // dedup by title

  $('a').each((_, el) => {
    const $a = $(el);

    // Skip links inside nav/header/footer/menu regions
    if ($a.closest('nav, header, footer, [class*="nav"], [class*="menu"], [class*="footer"], [class*="subscribe"], [class*="sidebar"]').length) return;

    const href = $a.attr('href') || '';
    const link = resolve(baseUrl, href);
    if (isJunkLink(link, baseUrl)) return;

    // Dedup by link
    if (seen.has(link)) return;

    // Extract title text
    let title = $a.text().trim().replace(/\s+/g, ' ');
    if (isJunkTitle(title)) return;

    // Dedup by title (avoid same article appearing twice with different link format)
    if (seenTitles.has(title)) return;

    seen.add(link);
    seenTitles.add(title);

    // ── Find summary ──
    let summary = '';
    const parent = $a.closest('div, li, section, article, [class*="item"], [class*="card"]');
    if (parent.length) {
      // Look for abstract/summary/description elements
      const candidates = [
        parent.find('[class*="abstract"]').first(),
        parent.find('[class*="summary"]').first(),
        parent.find('[class*="excerpt"]').first(),
        parent.find('[class*="desc"]').first(),
        parent.find('p').not($a.closest('p')).first(),
      ];
      for (const c of candidates) {
        if (c.length) {
          const text = c.text().trim();
          if (text && text !== title && text.length > 10) {
            summary = text.length > 250 ? text.substring(0, 247) + '...' : text;
            break;
          }
        }
      }
    }

    // ── Find image ──
    let image = '';
    if (parent.length) {
      // Look for real content images, skip icons/arrows
      parent.find('img').each((_, imgEl) => {
        if (image) return; // already found one
        const $img = $(imgEl);
        const src = resolve(baseUrl, $img.attr('src') || $img.attr('data-src') || $img.attr('data-original') || '');
        if (isJunkImage(src)) return;
        // Check dimensions if available - skip tiny images
        const w = parseInt($img.attr('width') || '999');
        const h = parseInt($img.attr('height') || '999');
        if (w < 50 || h < 50) return;
        image = src;
      });
    }

    articles.push({ title, summary, image, link, hash: md5(title + '||' + link) });
  });

  // Sort: prefer articles whose links match known article patterns
  articles.sort((a, b) => {
    const aScore = isArticleLink(a.link) ? 1 : 0;
    const bScore = isArticleLink(b.link) ? 1 : 0;
    return bScore - aScore;
  });

  return articles;
}

// ── Email template ──────────────────────────────────────

function buildEmailHtml(sourceName, sourceUrl, date, articles) {
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
          <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.4;color:#1a1a1a">${esc(a.title)}</h2>
          ${a.summary ? `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:#666">${esc(a.summary)}</p>` : ''}
          <a href="${esc(a.link)}" style="font-size:13px;color:#2563eb;text-decoration:none">Read article &rarr;</a>
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
      <a href="${esc(sourceUrl)}" style="font-size:12px;color:#6b9aff;text-decoration:none;display:inline-block;margin-top:6px">${esc(sourceUrl)}</a>
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
      console.log(`   Found ${articles.length} articles total`);
      if (articles.length > 0) {
        console.log(`   Sample titles:`);
        articles.slice(0, 3).forEach(a => console.log(`     - ${a.title}`));
      }
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
    const emailHtml = buildEmailHtml(source.name, source.url, today, newArticles);

    for (const email of subscribers) {
      if (!email || email === 'your-email@example.com') continue;
      try {
        const { error } = await resend.emails.send({
          from: FROM_EMAIL,
          to: email,
          subject,
          html: emailHtml,
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
