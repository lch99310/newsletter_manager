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
const FORCE_SEND = process.env.FORCE_SEND === 'true';

if (!RESEND_API_KEY) {
  console.error('⚠️  RESEND_API_KEY is not set. Will scrape but skip email sending.');
}
console.log(`📧 Email from: ${FROM_EMAIL}`);
console.log(`📧 Subscribers: ${subscribers.filter(e => e && e !== 'your-email@example.com').join(', ') || '(none)'}`);
console.log(`📧 Force send (ignore cache): ${FORCE_SEND}`);
console.log(`📧 Resend API key: ${RESEND_API_KEY ? 'configured (' + RESEND_API_KEY.substring(0, 8) + '...)' : 'NOT SET'}`);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ── Helpers ─────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function resolve(base, rel) {
  if (!rel) return '';
  try { return new URL(rel, base).href; } catch { return ''; }
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
};

// ── Rate limiting helper ────────────────────────────────

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send an email via Resend with exponential backoff on 429 rate limit errors.
 * Resend allows 2 req/s, so we space requests by at least 600ms and retry on 429.
 */
async function sendWithRetry(resendClient, emailOptions, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await resendClient.emails.send(emailOptions);
      return result;
    } catch (err) {
      const status = err?.statusCode || err?.response?.status || err?.status;
      const isRateLimit = status === 429 || (err.message && err.message.includes('rate limit'));

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s
        console.log(`   ⏳ Rate limited. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ── Date helpers ────────────────────────────────────────

/**
 * Parse Chinese date like "02月14日 16:02" or "02月14日" into a Date object.
 * Assumes current year if not specified.
 */
function parseChineseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const month = parseInt(m[1]) - 1;
  const day = parseInt(m[2]);
  const now = new Date();
  const year = now.getFullYear();
  // Handle year boundary: if parsed month is far ahead of current month, it's probably last year
  let d = new Date(year, month, day);
  if (d > new Date(now.getTime() + 7 * 86400000)) {
    d = new Date(year - 1, month, day);
  }
  return d;
}

/**
 * Check if a date is within the last N days.
 */
function isRecent(date, days = 7) {
  if (!date) return true; // if no date available, include it
  const cutoff = new Date(Date.now() - days * 86400000);
  return date >= cutoff;
}

// ══════════════════════════════════════════════════════════
// ── SITE-SPECIFIC STRATEGIES ────────────────────────────
// ══════════════════════════════════════════════════════════

/**
 * LatePost (latepost.com) strategy:
 * - Uses their internal API (POST /site/index) to get article list with structured data
 * - Then fetches each article's detail page for exact date and cover image
 * - Filters to only include articles from the last 3 days
 */
async function scrapeLatePost(source) {
  const baseUrl = 'https://www.latepost.com';
  console.log('   Using LatePost API strategy');

  // Step 1: Get article list from API
  const { data: apiResp } = await axios.post(`${baseUrl}/site/index`,
    'page=1&limit=15',
    {
      timeout: 20000,
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${baseUrl}/`,
      }
    }
  );

  if (!apiResp || apiResp.code !== 1 || !Array.isArray(apiResp.data)) {
    throw new Error(`LatePost API returned unexpected response: ${JSON.stringify(apiResp).substring(0, 200)}`);
  }

  console.log(`   API returned ${apiResp.data.length} articles`);

  // Step 2: Also get the featured headline from homepage HTML
  let headlineArticle = null;
  try {
    const { data: homeHtml } = await axios.get(`${baseUrl}/`, { timeout: 20000, headers: BROWSER_HEADERS });
    const $ = cheerio.load(homeHtml);
    const headlineLink = $('.headlines-title a').first();
    if (headlineLink.length) {
      const href = headlineLink.attr('href') || '';
      const title = headlineLink.text().trim();
      const abstract = $('.headlines-abstract').first().text().trim();
      if (title && href) {
        headlineArticle = {
          title,
          abstract,
          detail_url: href,
        };
      }
    }
  } catch (err) {
    console.log(`   Warning: could not fetch homepage headline: ${err.message}`);
  }

  // Step 3: Merge headline with API articles (headline first, dedup)
  const allRaw = [];
  const seenIds = new Set();

  if (headlineArticle) {
    allRaw.push(headlineArticle);
    const idMatch = headlineArticle.detail_url.match(/id=(\d+)/);
    if (idMatch) seenIds.add(idMatch[1]);
  }

  for (const item of apiResp.data) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    allRaw.push(item);
  }

  // Step 4: For each article, fetch detail page to get exact date and cover image
  const articles = [];
  for (const item of allRaw) {
    const detailUrl = resolve(baseUrl, item.detail_url);
    if (!detailUrl) continue;

    let title = item.title || '';
    let date = item.release_time || '';
    let cover = item.cover ? resolve(baseUrl, item.cover) : '';
    let summary = item.abstract || '';

    // Fetch detail page for better date and cover image
    try {
      const { data: detailHtml } = await axios.get(detailUrl, { timeout: 15000, headers: BROWSER_HEADERS });
      const $d = cheerio.load(detailHtml);

      // Get precise title from detail page
      const detailTitle = $d('.article-header-title').text().trim();
      if (detailTitle) title = detailTitle;

      // Get precise date from detail page (e.g., "02月14日 16:02")
      const detailDate = $d('.article-header-date').text().trim();
      if (detailDate) date = detailDate;

      // Get cover image from detail page
      if (!cover) {
        $d('img[src*="cover"]').each((_, el) => {
          if (cover) return;
          const src = $d(el).attr('src') || '';
          if (src.includes('cover')) cover = resolve(baseUrl, src);
        });
      }
    } catch (err) {
      console.log(`   Warning: could not fetch detail for "${title.substring(0, 30)}": ${err.message}`);
    }

    if (!title) continue;

    // Parse date and check recency (only last 7 days)
    const parsedDate = parseChineseDate(date);
    if (parsedDate && !isRecent(parsedDate, 7)) {
      console.log(`   Skipped (old: ${date}): ${title.substring(0, 40)}`);
      continue;
    }

    articles.push({
      title,
      summary: summary.length > 250 ? summary.substring(0, 247) + '...' : summary,
      image: cover,
      link: detailUrl,
      date,
      hash: md5(title + '||' + detailUrl),
    });
  }

  return articles;
}

// ── SciCover Summary strategy ───────────────────────────

/**
 * SciCover Summary (lch99310.github.io/SciCover_Summary) strategy:
 * - This is a hash-based SPA (#/article/...) so generic scraping fails
 *   because JUNK_LINK_PATTERNS rejects all /#... links.
 * - We fetch the page HTML, parse the article cards directly via cheerio,
 *   and reconstruct the full hash URLs ourselves.
 */
async function scrapeSciCover(source) {
  const baseUrl = source.url.replace(/\/$/, '');
  console.log('   Using SciCover strategy');

  const { data: html } = await axios.get(baseUrl, { timeout: 20000, headers: BROWSER_HEADERS });
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();

  // SciCover renders article cards as <a> elements with hash links
  $('a[href*="#/article/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    // Reconstruct full URL: base + hash fragment
    const link = href.startsWith('http') ? href : `${baseUrl}/${href.replace(/^\.?\/?/, '')}`;

    if (seen.has(link)) return;
    seen.add(link);

    // Extract text content from the card
    const fullText = $a.text().replace(/\s+/g, ' ').trim();

    // Extract journal name and date from the card
    // e.g., "Science February 25, 2026" or "Nature Feb 25, 2026"
    let journal = '';
    let date = '';
    const dateMatch = fullText.match(/(Science|Nature|Cell)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4})/i);
    if (dateMatch) {
      journal = dateMatch[1];
      date = dateMatch[2];
    }

    // Extract the Chinese title (first bold line) and English title (second bold line)
    let title = '';
    let summary = '';
    const boldTexts = [];
    $a.find('strong, b').each((_, b) => {
      const t = $(b).text().trim();
      if (t) boldTexts.push(t);
    });

    if (boldTexts.length >= 2) {
      title = boldTexts[0];        // Chinese title
      summary = boldTexts[1];      // English title as summary
    } else if (boldTexts.length === 1) {
      title = boldTexts[0];
    } else {
      // Fallback: strip known prefixes (journal + date) from full text
      title = fullText
        .replace(/(Science|Nature|Cell)/i, '')
        .replace(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+\d{4})/i, '')
        .replace(/閱讀更多\s*→/g, '')
        .trim();
    }

    if (!title || title.length < 4) return;

    // Try to find an image in the card
    let image = '';
    $a.find('img').each((_, imgEl) => {
      if (image) return;
      const src = $(imgEl).attr('src') || $(imgEl).attr('data-src') || '';
      if (src && !isJunkImage(src)) {
        image = src.startsWith('http') ? src : resolve(baseUrl, src);
      }
    });

    articles.push({
      title,
      summary: summary.length > 250 ? summary.substring(0, 247) + '...' : summary,
      image,
      link,
      date: date || journal,
      hash: md5(title + '||' + link),
    });
  });

  return articles;
}

// ── Generic HTML scraping strategy ──────────────────────

// Filtering rules for generic sites
const JUNK_LINK_PATTERNS = [
  /\/(about|contact|join|login|signup|register|privacy|terms|careers|faq|help|sitemap)\b/i,
  /\/(websites|tags?|label|category|search|archive|page)\//i,
  /\/#/,
  /^mailto:/i,
  /^javascript:/i,
  /\/(index|home)\/?$/i,
];

const JUNK_TITLE_PATTERNS = [
  /^(about|contact|關於|加入|廣告|聯繫|login|signup|home|首頁)/i,
  /^(more|查看更多|加載更多|訂閱|subscribe|read more)/i,
  /^(skip to|跳到|↓|↑|←|→)/i,
  /^(portfolio|blog|posts|tags|categories|archive)$/i,
  /^(menu|search|close|open|toggle)$/i,
  /^[·\s]*[\u4e00-\u9fff]{1,2}[·\s]*$/,
  /^\d{1,2}月\d{1,2}日$/,
];

const JUNK_IMAGE_PATTERNS = [
  /arrow/i, /icon/i, /logo/i, /favicon/i,
  /tip\d*\.png/i, /dujia\.png/i, /default\.png/i,
  /spinner|loading|placeholder/i, /\.svg$/i,
  /1x1|spacer|pixel|blank/i,
];

function isJunkLink(link, baseUrl) {
  if (!link) return true;
  for (const p of JUNK_LINK_PATTERNS) if (p.test(link)) return true;
  try {
    if (new URL(link).hostname !== new URL(baseUrl).hostname) return true;
  } catch { return true; }
  const pathname = new URL(link).pathname;
  if (pathname === '/' || pathname === '') return true;
  return false;
}

function isJunkTitle(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 4 || t.length > 300) return true;
  for (const p of JUNK_TITLE_PATTERNS) if (p.test(t)) return true;
  if (t.length < 8 && !/[\u4e00-\u9fff]/.test(t)) return true;
  const cjkOnly = t.replace(/[^\u4e00-\u9fff]/g, '');
  if (cjkOnly.length > 0 && cjkOnly.length <= 2 && t.length < 6) return true;
  return false;
}

function isJunkImage(url) {
  if (!url) return true;
  for (const p of JUNK_IMAGE_PATTERNS) if (p.test(url)) return true;
  return false;
}

// ── 增強版 Generic HTML scraping strategy ──────────────────────

async function scrapeGeneric(source) {
  const baseUrl = source.url;
  console.log('   Using generic HTML scraping strategy');

  const { data: html } = await axios.get(baseUrl, { timeout: 20000, headers: BROWSER_HEADERS });
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();
  const seenTitles = new Set();

  $('a').each((_, el) => {
    const $a = $(el);
    // 排除導覽列、頁首、頁尾等非文章區塊
    if ($a.closest('nav, header, footer, [class*="nav"], [class*="menu"], [class*="footer"], [class*="sidebar"]').length) return;

    const href = $a.attr('href') || '';
    const link = resolve(baseUrl, href);
    if (isJunkLink(link, baseUrl)) return;
    if (seen.has(link)) return;

    // 1. 先嘗試抓取 <a> 裡面的文字
    let title = $a.text().trim().replace(/\s+/g, ' ');

    // 2. 應對 LY's Note 這種卡片式排版：提取 aria-label 或 title 屬性
    if (!title || /^(read more|post link to)/i.test(title)) {
      const aria = $a.attr('aria-label') || $a.attr('title') || '';
      title = aria.replace(/post link to/i, '').trim();
    }

    // 尋找文章卡片父容器
    const parent = $a.closest('article, .post, .post-entry, div[class*="item"], div[class*="card"], li');

    // 3. 如果還是抓不到標題，從卡片容器中找 <h1>~<h3>
    if ((!title || isJunkTitle(title)) && parent.length) {
      const heading = parent.find('h1, h2, h3, h4, .title').first().text().trim().replace(/\s+/g, ' ');
      if (heading) title = heading;
    }

    if (isJunkTitle(title)) return;
    if (seenTitles.has(title)) return;

    seen.add(link);
    seenTitles.add(title);

    // 尋找文章摘要 (Summary)
    let summary = '';
    if (parent.length) {
      for (const sel of ['[class*="abstract"]', '[class*="summary"]', '[class*="excerpt"]', '[class*="desc"]']) {
        const c = parent.find(sel).first();
        if (c.length) {
          const text = c.text().trim();
          if (text && text !== title && text.length > 10) {
            summary = text.length > 250 ? text.substring(0, 247) + '...' : text;
            break;
          }
        }
      }
    }

    // 尋找文章日期 (Date) - 針對 LY's Note 中的 "25 December 2025" 結構優化
    let date = '';
    if (parent.length) {
      const dateEl = parent.find('time, [class*="date"], [class*="time"], .meta').first();
      if (dateEl.length) {
        date = dateEl.text().trim().split('\n')[0].substring(0, 20).trim();
      }
    }

    // 尋找縮圖 (Image)
    let image = '';
    if (parent.length) {
      parent.find('img').each((_, imgEl) => {
        if (image) return;
        const $img = $(imgEl);
        const src = resolve(baseUrl, $img.attr('src') || $img.attr('data-src') || '');
        if (isJunkImage(src)) return;
        // 排除過小的 icon
        const w = parseInt($img.attr('width') || '999');
        const h = parseInt($img.attr('height') || '999');
        if (w < 50 || h < 50) return;
        image = src;
      });
    }

    articles.push({ title, summary, image, link, date, hash: md5(title + '||' + link) });
  });

  return articles;
}

// ── Strategy router ─────────────────────────────────────

/**
 * Determine which scraping strategy to use based on the source URL.
 * Users can add "strategy": "latepost" or "scicover" in sources.json,
 * or it auto-detects by domain.
 */
async function fetchArticles(source) {
  const url = source.url;
  const strategy = source.strategy || 'auto';

  if (strategy === 'latepost' || (strategy === 'auto' && url.includes('latepost.com'))) {
    return scrapeLatePost(source);
  }

  if (strategy === 'scicover' || (strategy === 'auto' && url.includes('SciCover_Summary'))) {
    return scrapeSciCover(source);
  }

  // Default: generic HTML scraping
  return scrapeGeneric(source);
}

// ── Email template ──────────────────────────────────────

function buildEmailHtml(sourceName, sourceUrl, date, articles) {
  const rows = articles.map(a => {
    const dateLabel = a.date ? `<span style="font-size:11px;color:#999;font-weight:400;margin-left:8px">${esc(a.date)}</span>` : '';
    const imgCell = a.image
      ? `<td style="width:140px;vertical-align:top;padding-left:16px">
           <img src="${esc(a.image)}" alt="" style="width:140px;height:auto;max-height:100px;border-radius:6px;display:block;object-fit:cover" />
         </td>`
      : '';
    return `
    <tr><td style="padding:20px 0;border-bottom:1px solid #eee">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:top">
          <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.4;color:#1a1a1a">${esc(a.title)}${dateLabel}</h2>
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
      <p style="margin:4px 0 0;font-size:13px;color:#999">${date} Updates &middot; ${articles.length} article${articles.length > 1 ? 's' : ''}</p>
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

// ── Main ────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().split('T')[0];
  let cacheUpdated = false;
  let totalNewArticles = 0;
  let totalEmailsSent = 0;

  if (FORCE_SEND) {
    console.log('\n🔄 FORCE_SEND enabled — clearing cache, all articles will be treated as new');
    cache = {};
  }

  for (const source of sources) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📡 Checking: ${source.name} (${source.url})`);

    let articles;
    try {
      articles = await fetchArticles(source);
      console.log(`   Found ${articles.length} articles`);
      if (articles.length > 0) {
        console.log('   Articles:');
        articles.forEach((a, i) => console.log(`     ${i + 1}. ${a.date ? `[${a.date}] ` : ''}${a.title}${a.image ? ' [img]' : ''}`));
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

    console.log(`\n   📊 Cache: ${prevHashes.length} previously seen, ${newArticles.length} new`);

    if (newArticles.length === 0) {
      console.log('   ✅ No updates — skip email');
      continue;
    }

    totalNewArticles += newArticles.length;

    const validSubscribers = subscribers.filter(e => e && e !== 'your-email@example.com');

    if (!resend) {
      console.log('   ⚠️  No Resend API key — skipping email');
      cache[sourceKey] = articles.map(a => a.hash);
      cacheUpdated = true;
      continue;
    }

    if (validSubscribers.length === 0) {
      console.log('   ⚠️  No subscribers — skipping email');
      cache[sourceKey] = articles.map(a => a.hash);
      cacheUpdated = true;
      continue;
    }

    const subject = `${source.name} ${today} Updates (${newArticles.length} new)`;
    const emailHtml = buildEmailHtml(source.name, source.url, today, newArticles);
    let anyEmailSucceeded = false;

    console.log(`\n   📤 Sending to ${validSubscribers.length} subscriber(s)...`);

    for (let i = 0; i < validSubscribers.length; i++) {
      const email = validSubscribers[i];
      try {
        // Respect Resend rate limit: 2 req/s → wait 600ms between sends
        if (i > 0) await sleep(600);

        console.log(`   → Sending to ${email}...`);
        const result = await sendWithRetry(resend, {
          from: `Newsletter Manager <${FROM_EMAIL}>`,
          to: email,
          subject,
          html: emailHtml,
        });

        if (result.error) {
          console.error(`   ❌ Resend error for ${email}: ${JSON.stringify(result.error)}`);
        } else {
          console.log(`   ✉️  Sent to ${email} (id: ${result.data?.id || 'unknown'})`);
          anyEmailSucceeded = true;
          totalEmailsSent++;
        }
      } catch (err) {
        console.error(`   ❌ Exception sending to ${email}: ${err.message}`);
        if (err.response) {
          console.error(`   Response: ${JSON.stringify(err.response)}`);
        }
      }
    }

    cache[sourceKey] = articles.map(a => a.hash);
    cacheUpdated = true;

    if (!anyEmailSucceeded) {
      console.log('   ⚠️  No emails were delivered. Check your Resend API key and FROM_EMAIL.');
      console.log('   💡 Tip: With onboarding@resend.dev, you can only send to your Resend account email.');
    }
  }

  // Save cache
  if (cacheUpdated) {
    fs.writeFileSync(path.join(DATA, 'cache.json'), JSON.stringify(cache, null, 2));
    console.log('\n💾 Cache saved to data/cache.json');
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Done.`);
  console.log(`   New articles found: ${totalNewArticles}`);
  console.log(`   Emails sent: ${totalEmailsSent}`);
  console.log(`${'═'.repeat(50)}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_articles=${totalNewArticles}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `emails_sent=${totalEmailsSent}\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
