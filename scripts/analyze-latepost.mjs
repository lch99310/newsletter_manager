import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function resolve(base, rel) { if (!rel) return ''; try { return new URL(rel, base).href; } catch { return ''; } }

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

// Generate preview with sample LatePost data
const sampleArticles = [
  {
    title: '字节跳动在春节点亮自己的 ChatGPT 时刻',
    summary: '真正的 AI 攻势，是坚决把自己变成一家科技企业。',
    image: 'https://www.latepost.com/uploads/cover/f36de5bd511813fb66cd0b9d293b76cc.png',
    link: 'https://www.latepost.com/news/dj_detail?id=3426',
    date: '02月17日 12:02',
  },
  {
    title: '"人与 Agent 的社交里，有下一个字节的机会"丨100 个 AI 创业者',
    summary: '"我看到 AI 这一轮的终局就是人和多个 AI 的协作"。',
    image: 'https://www.latepost.com/uploads/cover/91811a196ac320982909f54ce9685be6.jpg',
    link: 'https://www.latepost.com/news/dj_detail?id=3425',
    date: '02月15日 09:02',
  },
  {
    title: 'AI 硬件的上半场：失败、共识与进行中的探索',
    summary: '曙光已经出现，但黎明还没有到来。',
    image: 'https://www.latepost.com/uploads/cover/dc31b573b48d60635ca1ac88f6b3314d.jpg',
    link: 'https://www.latepost.com/news/dj_detail?id=3423',
    date: '02月14日 11:02',
  },
];

const html = buildEmailHtml('LatePost (晚点)', 'https://www.latepost.com/', '2026-02-22', sampleArticles);
fs.writeFileSync('/tmp/email-preview.html', html);
console.log('Preview saved to /tmp/email-preview.html');
