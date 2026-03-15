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

// ══════════════════════════════════════════════════════════
// ── FIX #3: Enhanced browser headers with anti-detection ─
// ══════════════════════════════════════════════════════════

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// ── Rate limiting helper ────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════
// ── FIX #3: Robust HTTP fetch with retry on transient errors
// ══════════════════════════════════════════════════════════

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const mergedOptions = {
    timeout: 20000,
    headers: { ...BROWSER_HEADERS, ...options.headers },
    ...options,
    headers: { ...BROWSER_HEADERS, ...options.headers },
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios(url, mergedOptions);
      return response;
    } catch (err) {
      const status = err?.response?.status;
      const isRetryable = !status || status >= 500 || status === 429 || status === 403;

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.log(`   ⏳ Request failed (${status || err.code || 'network error'}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);

        // On 403, rotate User-Agent for next attempt
        if (status === 403) {
          const agents = [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
          ];
          mergedOptions.headers['User-Agent'] = agents[attempt % agents.length];
          // Add Referer to look more like a real browser
          mergedOptions.headers['Referer'] = new URL(url).origin + '/';
        }
        continue;
      }
      throw err;
    }
  }
}

// ══════════════════════════════════════════════════════════
// ── FIX #4: Global email rate limiter ────────────────────
// ══════════════════════════════════════════════════════════

let lastEmailSentAt = 0;

async function sendWithRetry(resendClient, emailOptions, maxRetries = 4) {
  // Global rate limit: ensure at least 1200ms between ANY two emails
  const now = Date.now();
  const elapsed = now - lastEmailSentAt;
  if (elapsed < 1200) {
    await sleep(1200 - elapsed);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      lastEmailSentAt = Date.now();
      const result = await resendClient.emails.send(emailOptions);
      return result;
    } catch (err) {
      const status = err?.statusCode || err?.response?.status || err?.status;
      const isRateLimit = status === 429 || (err.message && err.message.includes('rate limit'));

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, 16s
        console.log(`   ⏳ Rate limited. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ── Date helpers ────────────────────────────────────────

function parseChineseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const month = parseInt(m[1]) - 1;
  const day = parseInt(m[2]);
  const now = new Date();
  const year = now.getFullYear();
  let d = new Date(year, month, day);
  if (d > new Date(now.getTime() + 7 * 86400000)) {
    d = new Date(year - 1, month, day);
  }
  return d;
}

function isRecent(date, days = 7) {
  if (!date) return true;
  const cutoff = new Date(Date.now() - days * 86400000);
  return date >= cutoff;
}

// ══════════════════════════════════════════════════════════
// ── FIX #2: Image URL validation ─────────────────────────
// ══════════════════════════════════════════════════════════

function isValidImageUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    // Must have a reasonable path (not just domain root)
    if (parsed.pathname === '/' || parsed.pathname === '') return false;
    return true;
  } catch {
    return false;
  }
}

// Check if an image URL is actually accessible (HEAD request)
async function isImageAccessible(url) {
  if (!isValidImageUrl(url)) return false;
  try {
    const resp = await axios.head(url, {
      timeout: 8000,
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'image/*,*/*;q=0.8',
      },
      maxRedirects: 3,
      validateStatus: (s) => s < 400,
    });
    const ct = (resp.headers['content-type'] || '').toLowerCase();
    // Must be an image content type
    return ct.startsWith('image/');
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// ── FIX #7: Universal metadata extraction ────────────────
// ══════════════════════════════════════════════════════════

/**
 * Extract article metadata from a detail page using multiple strategies:
 * 1. Open Graph meta tags (og:title, og:description, og:image)
 * 2. Twitter Card meta tags
 * 3. JSON-LD structured data
 * 4. Standard meta description
 * 5. First visible paragraph
 *
 * This provides a unified, reliable way to get summaries and images
 * regardless of the site's HTML structure.
 */
function extractPageMetadata($, url) {
  const meta = { title: '', summary: '', image: '' };

  // 1. Open Graph
  meta.title = $('meta[property="og:title"]').attr('content') || '';
  meta.summary = $('meta[property="og:description"]').attr('content') || '';
  meta.image = $('meta[property="og:image"]').attr('content') || '';

  // 2. Twitter Card fallback
  if (!meta.summary) meta.summary = $('meta[name="twitter:description"]').attr('content') || '';
  if (!meta.image) meta.image = $('meta[name="twitter:image"]').attr('content') || '';
  if (!meta.title) meta.title = $('meta[name="twitter:title"]').attr('content') || '';

  // 3. Standard meta description fallback
  if (!meta.summary) meta.summary = $('meta[name="description"]').attr('content') || '';

  // 4. JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const ld = JSON.parse($(el).html());
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (item['@type'] === 'Article' || item['@type'] === 'BlogPosting' || item['@type'] === 'NewsArticle') {
          if (!meta.title && item.headline) meta.title = item.headline;
          if (!meta.summary && item.description) meta.summary = item.description;
          if (!meta.image && item.image) {
            meta.image = typeof item.image === 'string' ? item.image : (item.image?.url || '');
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  });

  // Resolve relative URLs
  if (meta.image && !meta.image.startsWith('http')) {
    meta.image = resolve(url, meta.image);
  }

  // Trim summary
  if (meta.summary && meta.summary.length > 250) {
    meta.summary = meta.summary.substring(0, 247) + '...';
  }

  return meta;
}

// ══════════════════════════════════════════════════════════
// ── FIX #5 & #7: Enhanced summary extraction from article page
// ══════════════════════════════════════════════════════════

/**
 * Fetch an article's detail page and extract summary + image
 * using the universal metadata approach (OG, meta, JSON-LD).
 * Falls back to first paragraph extraction.
 */
async function enrichArticle(article, baseUrl) {
  if (article.summary && article.image) return article;

  try {
    const resp = await fetchWithRetry(article.link, {
      timeout: 12000,
      headers: { ...BROWSER_HEADERS, 'Referer': baseUrl },
    }, 1); // Only 1 retry for enrichment

    const $ = cheerio.load(resp.data);
    const meta = extractPageMetadata($, article.link);

    // Fill in missing summary
    if (!article.summary && meta.summary) {
      article.summary = meta.summary;
    }

    // If still no summary, try first meaningful paragraph from article body
    if (!article.summary) {
      const bodySelectors = ['article', '.post-content', '.entry-content', '.article-body', '.content', 'main'];
      for (const sel of bodySelectors) {
        const container = $(sel).first();
        if (!container.length) continue;
        const paragraphs = container.find('p');
        for (let i = 0; i < Math.min(paragraphs.length, 5); i++) {
          const text = $(paragraphs[i]).text().trim();
          if (text.length > 30) {
            article.summary = text.length > 250 ? text.substring(0, 247) + '...' : text;
            break;
          }
        }
        if (article.summary) break;
      }
    }

    // Fill in missing image
    if (!article.image && meta.image && isValidImageUrl(meta.image)) {
      article.image = meta.image;
    }
  } catch (err) {
    console.log(`   ⚠️  Could not enrich "${article.title.substring(0, 30)}": ${err.message}`);
  }

  return article;
}

// ══════════════════════════════════════════════════════════
// ── SITE-SPECIFIC STRATEGIES ────────────────────────────
// ══════════════════════════════════════════════════════════

async function scrapeLatePost(source) {
  const baseUrl = 'https://www.latepost.com';
  console.log('   Using LatePost API strategy');

  const { data: apiResp } = await fetchWithRetry(`${baseUrl}/site/index`, {
    method: 'POST',
    data: 'page=1&limit=15',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${baseUrl}/`,
    },
  });

  if (!apiResp || apiResp.code !== 1 || !Array.isArray(apiResp.data)) {
    throw new Error(`LatePost API returned unexpected response: ${JSON.stringify(apiResp).substring(0, 200)}`);
  }

  console.log(`   API returned ${apiResp.data.length} articles`);

  // Also get the featured headline from homepage HTML
  let headlineArticle = null;
  try {
    const { data: homeHtml } = await fetchWithRetry(`${baseUrl}/`, {
      headers: { ...BROWSER_HEADERS, 'Referer': `${baseUrl}/` },
    });
    const $ = cheerio.load(homeHtml);
    const headlineLink = $('.headlines-title a').first();
    if (headlineLink.length) {
      const href = headlineLink.attr('href') || '';
      const title = headlineLink.text().trim();
      const abstract = $('.headlines-abstract').first().text().trim();
      if (title && href) {
        headlineArticle = { title, abstract, detail_url: href };
      }
    }
  } catch (err) {
    console.log(`   Warning: could not fetch homepage headline: ${err.message}`);
  }

  // Merge headline with API articles
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

  const articles = [];
  for (const item of allRaw) {
    const detailUrl = resolve(baseUrl, item.detail_url);
    if (!detailUrl) continue;

    let title = item.title || '';
    let date = item.release_time || '';
    let apiCover = item.cover ? resolve(baseUrl, item.cover) : '';
    let ogCover = '';
    let summary = item.abstract || '';

    // Fetch detail page for better date and cover image
    try {
      const { data: detailHtml } = await fetchWithRetry(detailUrl, {
        timeout: 15000,
        headers: { ...BROWSER_HEADERS, 'Referer': `${baseUrl}/` },
      }, 1);
      const $d = cheerio.load(detailHtml);

      const detailTitle = $d('.article-header-title').text().trim();
      if (detailTitle) title = detailTitle;

      const detailDate = $d('.article-header-date').text().trim();
      if (detailDate) date = detailDate;

      // Always try to get OG image (more reliable for external access)
      const ogImg = $d('meta[property="og:image"]').attr('content');
      if (ogImg) {
        ogCover = resolve(baseUrl, ogImg);
      }
      if (!ogCover) {
        $d('img[src*="cover"]').each((_, el) => {
          if (ogCover) return;
          const src = $d(el).attr('src') || '';
          if (src.includes('cover')) ogCover = resolve(baseUrl, src);
        });
      }

      // Enhance summary from OG if empty
      if (!summary) {
        summary = $d('meta[property="og:description"]').attr('content') || '';
      }
    } catch (err) {
      console.log(`   Warning: could not fetch detail for "${title.substring(0, 30)}": ${err.message}`);
    }

    if (!title) continue;

    const parsedDate = parseChineseDate(date);
    if (parsedDate && !isRecent(parsedDate, 7)) {
      console.log(`   Skipped (old: ${date}): ${title.substring(0, 40)}`);
      continue;
    }

    // Pick the best accessible cover image: prefer OG image, fall back to API cover
    let cover = '';
    const candidates = [ogCover, apiCover].filter(isValidImageUrl);
    for (const candidate of candidates) {
      if (await isImageAccessible(candidate)) {
        cover = candidate;
        break;
      }
    }
    if (!cover && candidates.length > 0) {
      // If HEAD check fails (e.g. server blocks HEAD), use first valid URL as fallback
      cover = candidates[0];
      console.log(`   Note: could not verify image for "${title.substring(0, 30)}", using unverified URL`);
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

// ══════════════════════════════════════════════════════════
// ── FIX #1: SciCover Summary strategy ───────────────────
// ══════════════════════════════════════════════════════════

async function scrapeSciCover(source) {
  const baseUrl = source.url.replace(/\/$/, '');
  const indexUrl = `${baseUrl}/data/index.json`;
  console.log(`   Using SciCover JSON API: ${indexUrl}`);

  try {
    const response = await fetchWithRetry(indexUrl, {
      headers: {
        ...BROWSER_HEADERS,
        'Accept': 'application/json,text/html,*/*;q=0.8',
        'Referer': `${baseUrl}/`,
      },
      responseType: 'json',
    });

    const indexData = response.data;

    // Handle various possible JSON structures
    let list = [];
    if (Array.isArray(indexData)) {
      list = indexData;
    } else if (Array.isArray(indexData?.entries)) {
      list = indexData.entries;
    } else if (Array.isArray(indexData?.articles)) {
      list = indexData.articles;
    } else if (Array.isArray(indexData?.data)) {
      list = indexData.data;
    } else if (Array.isArray(indexData?.items)) {
      list = indexData.items;
    }

    if (list.length === 0) {
      console.log('   Warning: index.json returned empty list');
      console.log('   Response keys:', Object.keys(indexData || {}));
      return [];
    }

    console.log(`   Index found ${list.length} items`);

    const articles = [];
    const seen = new Set();
    const now = new Date();
    // FIX #1: Extend to 30 days (SciCover may update infrequently)
    const cutoffDays = 30;
    const cutoffDate = new Date(now.getTime() - cutoffDays * 86400000);

    for (const item of list) {
      const articleId = item.id || '';
      const title = item.title || item.title_zh || item.title_en || 'Untitled';
      if (title === 'Untitled') continue;

      // FIX #5: Better summary extraction - try multiple fields
      let summary = '';
      for (const field of ['summary', 'abstract', 'description', 'title_en', 'subtitle']) {
        const val = item[field];
        if (val && typeof val === 'string' && val.length > 5 && val !== title) {
          summary = val;
          break;
        }
      }

      const dateStr = item.date || item.published || item.created || '';

      // FIX #1: Use 30-day cutoff instead of 7 days
      let articleDate = null;
      if (dateStr) {
        articleDate = new Date(dateStr);
        if (!isNaN(articleDate.getTime()) && articleDate < cutoffDate) {
          console.log(`   Skipped (old: ${dateStr}): ${title.substring(0, 40)}`);
          continue;
        }
      }
      // If no date at all, always include (don't filter)

      let link = '';
      if (articleId) {
        link = `${baseUrl}/#/article/${articleId}`;
      } else {
        link = baseUrl;
      }

      if (seen.has(link)) continue;
      seen.add(link);

      // FIX: Resolve image URLs correctly
      // cover_url values are like "data/images/science/xxx-cover.jpg" (already include "data/" prefix)
      // So we resolve against baseUrl (not baseUrl/data/ which would double it)
      // Also use raw.githubusercontent.com for reliable image hosting (GitHub Pages may 403)
      let image = '';
      for (const field of ['cover_url', 'cover_image', 'cover_image_local', 'image', 'thumbnail']) {
        const val = item[field];
        if (val && typeof val === 'string') {
          if (val.startsWith('http')) {
            image = val;
          } else {
            // Convert GitHub Pages relative path to raw.githubusercontent.com URL
            // e.g. "data/images/science/xxx.jpg" → "https://raw.githubusercontent.com/{user}/{repo}/main/data/images/..."
            const ghPagesMatch = baseUrl.match(/https?:\/\/([^.]+)\.github\.io\/([^/]+)/);
            if (ghPagesMatch) {
              const [, user, repo] = ghPagesMatch;
              image = `https://raw.githubusercontent.com/${user}/${repo}/main/${val}`;
            } else {
              image = resolve(baseUrl + '/', val);
            }
          }
          if (isValidImageUrl(image)) break;
          image = '';
        }
      }

      articles.push({
        title,
        summary: summary.length > 250 ? summary.substring(0, 247) + '...' : summary,
        image,
        link,
        date: dateStr || 'New',
        hash: md5(articleId || title), // FIX #1: Use ID for stable hash when available
      });
    }

    // Sort by date, newest first
    articles.sort((a, b) => {
      if (!a.date || a.date === 'New') return 1;
      if (!b.date || b.date === 'New') return -1;
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      return db - da;
    });

    return articles;

  } catch (err) {
    console.error(`   ❌ Failed to fetch index.json: ${err.message}`);
    if (err.response) {
      console.error('   Response status:', err.response.status);
      console.error('   Response headers:', JSON.stringify(err.response.headers || {}).substring(0, 200));
    }
    return [];
  }
}

// ══════════════════════════════════════════════════════════
// ── FIX #7: Enhanced generic HTML scraping strategy ──────
// ══════════════════════════════════════════════════════════

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

/**
 * FIX #7: Universal generic scraper with enhanced strategies:
 * 1. Try RSS/Atom feed first (most reliable structured data)
 * 2. Extract page-level OG metadata for context
 * 3. Parse article links from HTML
 * 4. Enrich each article with detail page metadata (OG/meta/JSON-LD)
 */
async function scrapeGeneric(source) {
  const baseUrl = source.url;
  console.log('   Using enhanced generic scraping strategy');

  // Step 1: Try RSS/Atom feed first
  const rssArticles = await tryRssFeed(baseUrl);
  if (rssArticles.length > 0) {
    console.log(`   ✅ Found RSS/Atom feed with ${rssArticles.length} articles`);
    return rssArticles;
  }

  // Collect all page URLs to scrape (primary + extra_paths)
  const pageUrls = [baseUrl];
  if (source.extra_paths && Array.isArray(source.extra_paths)) {
    const origin = new URL(baseUrl).origin;
    const basePath = new URL(baseUrl).pathname.replace(/\/[^/]*\/?$/, ''); // parent path
    for (const extraPath of source.extra_paths) {
      // Support both absolute paths ("/portfolio/") and relative ("portfolio/")
      const extraUrl = extraPath.startsWith('/')
        ? origin + extraPath
        : resolve(baseUrl.replace(/\/?$/, '/'), extraPath);
      if (extraUrl && !pageUrls.includes(extraUrl)) {
        pageUrls.push(extraUrl);
      }
    }
    console.log(`   Scraping ${pageUrls.length} page(s): ${pageUrls.map(u => new URL(u).pathname).join(', ')}`);
  }

  const articles = [];
  const seen = new Set();
  const seenTitles = new Set();
  let foundRssLink = false;

  for (const pageUrl of pageUrls) {
    // Step 2: Fetch HTML page
    let $;
    try {
      const resp = await fetchWithRetry(pageUrl, {
        headers: { ...BROWSER_HEADERS, 'Referer': new URL(pageUrl).origin + '/' },
      });
      $ = cheerio.load(resp.data);
    } catch (err) {
      console.log(`   ⚠️  Failed to fetch ${new URL(pageUrl).pathname}: ${err.message}`);
      continue;
    }

    // Check for RSS link in HTML head (only once)
    if (!foundRssLink) {
      const rssLink = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').attr('href');
      if (rssLink) {
        foundRssLink = true;
        const rssUrl = resolve(pageUrl, rssLink);
        console.log(`   Found RSS link: ${rssUrl}`);
        const rssResult = await tryRssFeedUrl(rssUrl, baseUrl);
        if (rssResult.length > 0) {
          console.log(`   ✅ RSS feed returned ${rssResult.length} articles`);
          return rssResult;
        }
      }
    }

    // Step 3: HTML link extraction from this page
    const siteOrigin = new URL(baseUrl).origin;
    $('a').each((_, el) => {
      const $a = $(el);
      if ($a.closest('nav, header, footer, [class*="nav"], [class*="menu"], [class*="footer"], [class*="sidebar"]').length) return;

      const href = $a.attr('href') || '';
      const link = resolve(pageUrl, href);
      // Allow links from the same origin (not just baseUrl path)
      if (!link) return;
      try {
        if (new URL(link).origin !== siteOrigin) return;
      } catch { return; }
      const pathname = new URL(link).pathname;
      if (pathname === '/' || pathname === '') return;
      for (const p of JUNK_LINK_PATTERNS) { if (p.test(link)) return; }
      if (seen.has(link)) return;

      let title = $a.text().trim().replace(/\s+/g, ' ');

      if (!title || /^(read more|post link to)/i.test(title)) {
        const aria = $a.attr('aria-label') || $a.attr('title') || '';
        title = aria.replace(/post link to/i, '').trim();
      }

      const parent = $a.closest('article, .post, .post-entry, div[class*="item"], div[class*="card"], li');

      if ((!title || isJunkTitle(title)) && parent.length) {
        const heading = parent.find('h1, h2, h3, h4, .title').first().text().trim().replace(/\s+/g, ' ');
        if (heading) title = heading;
      }

      if (isJunkTitle(title)) return;
      if (seenTitles.has(title)) return;

      seen.add(link);
      seenTitles.add(title);

      // Enhanced summary extraction from parent container
      let summary = '';
      if (parent.length) {
        for (const sel of ['[class*="abstract"]', '[class*="summary"]', '[class*="excerpt"]', '[class*="desc"]', '[class*="content"]', 'p']) {
          const c = parent.find(sel).first();
          if (c.length) {
            const text = c.text().trim();
            if (text && text !== title && text.length > 15 && !isJunkTitle(text)) {
              summary = text.length > 250 ? text.substring(0, 247) + '...' : text;
              break;
            }
          }
        }
      }

      // Date extraction
      let date = '';
      if (parent.length) {
        const timeEl = parent.find('time').first();
        if (timeEl.length) {
          date = timeEl.attr('datetime') || timeEl.text().trim();
        }
        if (!date) {
          const dateEl = parent.find('[class*="date"], [class*="time"], .meta').first();
          if (dateEl.length) {
            date = dateEl.text().trim().split('\n')[0].substring(0, 30).trim();
          }
        }
      }

      // Image extraction
      let image = '';
      if (parent.length) {
        parent.find('img').each((_, imgEl) => {
          if (image) return;
          const $img = $(imgEl);
          const src = resolve(pageUrl, $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src') || '');
          if (isJunkImage(src)) return;
          const w = parseInt($img.attr('width') || '999');
          const h = parseInt($img.attr('height') || '999');
          if (w < 50 || h < 50) return;
          if (isValidImageUrl(src)) image = src;
        });
      }

      articles.push({ title, summary, image, link, date, hash: md5(title + '||' + link) });
    });
  } // end of pageUrls loop

  // FIX #5 & #7: Enrich articles that are missing summary/image by fetching their detail pages
  // Only enrich up to 10 articles to avoid too many requests
  const toEnrich = articles.filter(a => !a.summary || !a.image).slice(0, 10);
  if (toEnrich.length > 0) {
    console.log(`   Enriching ${toEnrich.length} articles with detail page metadata...`);
    // Process sequentially with small delay to be polite
    for (const article of toEnrich) {
      await enrichArticle(article, baseUrl);
      await sleep(300);
    }
  }

  return articles;
}

// ══════════════════════════════════════════════════════════
// ── FIX #7: RSS/Atom feed parser ─────────────────────────
// ══════════════════════════════════════════════════════════

async function tryRssFeed(baseUrl) {
  const commonPaths = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml'];
  const origin = new URL(baseUrl).origin;

  for (const feedPath of commonPaths) {
    const feedUrl = origin + feedPath;
    const result = await tryRssFeedUrl(feedUrl, baseUrl);
    if (result.length > 0) return result;
  }
  return [];
}

async function tryRssFeedUrl(feedUrl, baseUrl) {
  try {
    const resp = await fetchWithRetry(feedUrl, {
      timeout: 10000,
      headers: {
        ...BROWSER_HEADERS,
        'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
        'Referer': baseUrl,
      },
    }, 1);

    const xml = resp.data;
    if (typeof xml !== 'string' || (!xml.includes('<rss') && !xml.includes('<feed') && !xml.includes('<channel'))) {
      return [];
    }

    const $ = cheerio.load(xml, { xmlMode: true });
    const articles = [];
    const seen = new Set();

    // RSS 2.0 format
    $('item').each((_, el) => {
      const $item = $(el);
      const title = $item.find('title').first().text().trim();
      const link = $item.find('link').first().text().trim() || $item.find('link').first().attr('href') || '';
      const summary = $item.find('description').first().text().trim();
      const date = $item.find('pubDate').first().text().trim();
      const image = $item.find('enclosure[type^="image"]').attr('url') ||
                     $item.find('media\\:content, content').attr('url') || '';

      if (!title || !link || seen.has(link)) return;
      seen.add(link);

      const cleanSummary = summary.replace(/<[^>]+>/g, '').trim();
      articles.push({
        title,
        summary: cleanSummary.length > 250 ? cleanSummary.substring(0, 247) + '...' : cleanSummary,
        image: isValidImageUrl(image) ? image : '',
        link: resolve(baseUrl, link),
        date: date ? new Date(date).toISOString().split('T')[0] : '',
        hash: md5(title + '||' + link),
      });
    });

    // Atom format
    if (articles.length === 0) {
      $('entry').each((_, el) => {
        const $entry = $(el);
        const title = $entry.find('title').first().text().trim();
        const link = $entry.find('link[rel="alternate"]').attr('href') || $entry.find('link').first().attr('href') || '';
        const summary = $entry.find('summary, content').first().text().trim();
        const date = $entry.find('updated, published').first().text().trim();

        if (!title || !link || seen.has(link)) return;
        seen.add(link);

        const cleanSummary = summary.replace(/<[^>]+>/g, '').trim();
        articles.push({
          title,
          summary: cleanSummary.length > 250 ? cleanSummary.substring(0, 247) + '...' : cleanSummary,
          image: '',
          link: resolve(baseUrl, link),
          date: date ? new Date(date).toISOString().split('T')[0] : '',
          hash: md5(title + '||' + link),
        });
      });
    }

    return articles;
  } catch {
    return [];
  }
}

// ── Strategy router ─────────────────────────────────────

async function fetchArticles(source) {
  const url = source.url;
  const strategy = source.strategy || 'auto';

  if (strategy === 'latepost' || (strategy === 'auto' && url.includes('latepost.com'))) {
    return scrapeLatePost(source);
  }

  if (strategy === 'scicover' || (strategy === 'auto' && url.includes('SciCover_Summary'))) {
    return scrapeSciCover(source);
  }

  // Default: enhanced generic strategy (with RSS detection)
  return scrapeGeneric(source);
}

// ══════════════════════════════════════════════════════════
// ── FIX #2 & #6: Responsive email template ──────────────
// ══════════════════════════════════════════════════════════

function buildEmailHtml(sourceName, sourceUrl, date, articles) {
  const rows = articles.map(a => {
    const dateLabel = a.date ? `<span style="font-size:11px;color:#999;font-weight:400;margin-left:8px">${esc(a.date)}</span>` : '';

    // FIX #2: Image with fallback alt text and proper sizing (no JS onerror — stripped by email clients)
    const imgBlock = a.image
      ? `<!--[if mso]><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
         <div style="margin-top:12px">
           <img src="${esc(a.image)}" alt=""
                style="width:100%;max-width:520px;height:auto;max-height:200px;border-radius:6px;display:block;object-fit:cover" />
         </div>
         <!--[if mso]></td></tr></table><![endif]-->`
      : '';

    return `
    <tr><td style="padding:16px 0;border-bottom:1px solid #eee">
      <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;line-height:1.4;color:#1a1a1a">${esc(a.title)}${dateLabel}</h2>
      ${a.summary ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#666">${esc(a.summary)}</p>` : ''}
      <a href="${esc(a.link)}" style="font-size:13px;color:#2563eb;text-decoration:none">Read article &rarr;</a>
      ${imgBlock}
    </td></tr>`;
  }).join('');

  // FIX #6: Fully responsive email template - single column, fluid width
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<!--[if !mso]><!-->
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<!--<![endif]-->
<style type="text/css">
  /* Reset */
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }

  /* Mobile responsive */
  @media only screen and (max-width: 620px) {
    .email-container { width: 100% !important; max-width: 100% !important; }
    .email-padding { padding-left: 16px !important; padding-right: 16px !important; }
    .email-header { padding: 20px 16px !important; }
    h1 { font-size: 18px !important; }
    h2 { font-size: 15px !important; }
    img { max-width: 100% !important; height: auto !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC','Noto Sans TC',sans-serif;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);max-width:580px;width:100%">
    <tr><td class="email-header" style="background:#111;padding:24px 24px">
      <h1 style="margin:0;font-size:20px;font-weight:700;color:#fff">${esc(sourceName)}</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#999">${date} Updates &middot; ${articles.length} article${articles.length > 1 ? 's' : ''}</p>
      <a href="${esc(sourceUrl)}" style="font-size:12px;color:#6b9aff;text-decoration:none;display:inline-block;margin-top:6px;word-break:break-all">${esc(sourceUrl)}</a>
    </td></tr>
    <tr><td class="email-padding" style="padding:8px 24px 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr>
    <tr><td style="background:#fafafa;padding:16px 24px;border-top:1px solid #eee">
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
        articles.forEach((a, i) => console.log(`     ${i + 1}. ${a.date ? `[${a.date}] ` : ''}${a.title}${a.summary ? ' [summary]' : ''}${a.image ? ' [img]' : ''}`));
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
        console.log(`   → Sending to ${email}...`);
        // FIX #4: sendWithRetry now handles global rate limiting internally
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

    // FIX #4: Wait between sources to avoid rate limiting
    await sleep(2000);
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
