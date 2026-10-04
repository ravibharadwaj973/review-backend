import { HttpError } from '../../utils/http.js';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?)/i;

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/h\d|\/tr|\/div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8377;|&#x20B9;/g, '₹')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function get(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new HttpError(400, 'Use a public website address');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(u, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StarlingBot/1.0; +https://starling.app)' } });
    if (!res.ok) throw new HttpError(400, `The website returned an error (${res.status})`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) throw new HttpError(400, 'That address is not a web page');
    const html = (await res.text()).slice(0, 600_000);
    return html;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'We couldn’t open that website. Check the address and try again.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the home page plus up to 3 linked pages that look like service, menu or price pages.
 */
export async function fetchWebsiteText(url) {
  const home = await get(url);
  const base = new URL(url);
  const links = [...home.matchAll(/href=["']([^"'#]+)["']/gi)]
    .map((m) => {
      try { return new URL(m[1], base); } catch { return null; }
    })
    .filter((u) => u && u.hostname === base.hostname && /servic|menu|price|pricing|rate|treatment|package|course|class|membership/i.test(u.pathname))
    .map((u) => u.href);
  const pages = [...new Set(links)].slice(0, 3);
  const texts = [toText(home)];
  for (const p of pages) {
    try { texts.push(toText(await get(p))); } catch { /* skip */ }
  }
  return texts.join('\n\n').slice(0, 20000);
}
