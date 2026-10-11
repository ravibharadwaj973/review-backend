import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import { fetchPublic, publicUrl } from './network.js';

const norm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const normalizeUrl = (value, base) => {
  if (!value || value.length > 2000) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
};

export function analyzePage(result) {
  const $ = load(result.html);
  const title = compact($('title').first().text()).slice(0, 500);
  const description = ($('meta[name="description" i]').attr('content')?.trim() || '').slice(0, 2000);
  const robots = [$('meta[name="robots" i]').attr('content'), result.headers['x-robots-tag']].filter(Boolean).join(',').toLowerCase();
  const structured = [];
  let invalidStructuredData = 0;
  $('script[type="application/ld+json" i]').each((_, element) => {
    try {
      const visit = (value) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') { if (value['@type']) structured.push(value); if (value['@graph']) visit(value['@graph']); }
      };
      visit(JSON.parse($(element).text()));
    } catch { invalidStructuredData += 1; }
  });
  const headings = $('h1,h2,h3').slice(0, 30).map((_, e) => compact($(e).text()).slice(0, 300)).get();
  const h1Count = $('h1').length;
  const links = [...new Set($('a[href]').map((_, e) => normalizeUrl($(e).attr('href'), result.url)).get().filter(Boolean))].slice(0, 100);
  const phones = [...new Set($('a[href^="tel:"]').map((_, e) => $(e).attr('href').slice(4).replace(/\D/g, '')).get().filter(Boolean))];
  const images = $('img').length;
  const missingAlt = $('img').filter((_, e) => $(e).attr('alt') === undefined).length;
  const viewport = $('meta[name="viewport" i]').attr('content') || '';
  const canonical = normalizeUrl($('link[rel="canonical" i]').attr('href'), result.url);
  $('script,style,noscript').remove();
  const visibleText = compact($('body').text());
  $('nav,footer,header').remove();
  const content = compact($('body').text());
  const words = content.split(/\s+/).filter(Boolean).length;
  return { url: result.url, status: result.status, responseMs: result.responseMs, bytes: result.bytes, title, description, headings, h1Count, links, phones, images, missingAlt, viewport, canonical, noindex: /(?:^|[\s,;:])(?:noindex|none)(?:$|[\s,;])/.test(robots), structured, invalidStructuredData, words, text: visibleText.slice(0, 20000), contentHash: createHash('sha256').update(content).digest('hex') };
}

export function buildWebsiteReport({ url, pages, failures = [], robots, sitemap, business, services = [], google, now = new Date() }) {
  const findings = [];
  const add = (group, code, severity, title, detail, page) => findings.push({ group, code, severity, title, detail, url: page });
  if (!url.startsWith('https:')) add('technical', 'https', 'high', 'Use HTTPS', 'The audited website uses HTTP.', url);
  for (const p of pages) {
    if (p.status >= 400) { add('technical', 'broken', 'high', `Page returned ${p.status}`, 'Fix the linked URL or remove the broken link.', p.url); continue; }
    if (p.noindex) add('technical', 'noindex', 'high', 'Page excludes indexing', 'Confirm this exclusion is intentional before changing it.', p.url);
    if (!p.title) add('content', 'title', 'medium', 'Missing page title', 'Write a title describing the actual page and service.', p.url);
    if (!p.description) add('content', 'description', 'medium', 'Missing meta description', 'Summarize the real page content.', p.url);
    if (!p.h1Count) add('content', 'heading', 'medium', 'Missing main heading', 'Add a clear heading for this page.', p.url);
    if (p.words < 150) add('content', 'thin', 'review', 'Limited readable content', 'Review whether this page sufficiently answers customer questions. JavaScript content may not be visible to this crawl.', p.url);
    if (p.missingAlt) add('content', 'alt', 'medium', `${p.missingAlt} images have no alt attribute`, 'Add descriptive text for informative images; decorative images may use an empty alt attribute.', p.url);
    if (!/width\s*=\s*device-width/i.test(p.viewport)) add('technical', 'viewport', 'medium', 'Mobile viewport not found', 'Check responsive viewport configuration. Visual mobile testing is a separate check.', p.url);
    if (p.invalidStructuredData) add('local', 'jsonld', 'medium', 'Invalid JSON-LD', 'Repair the JSON syntax of the structured data.', p.url);
    if (p.responseMs > 2500) add('technical', 'response', 'review', 'Slow page response during crawl', `Response took ${p.responseMs} ms. This is a server response measurement, not a Core Web Vitals or PageSpeed score.`, p.url);
  }
  for (const key of ['title', 'description', 'contentHash']) {
    const groups = new Map();
    for (const p of pages.filter((p) => p.status < 400 && p[key])) groups.set(p[key], [...(groups.get(p[key]) || []), p.url]);
    for (const duplicates of groups.values()) if (duplicates.length > 1) add('content', `duplicate-${key}`, 'review', `Duplicate ${key === 'contentHash' ? 'readable content' : key}`, duplicates.join(' / '), duplicates[0]);
  }
  const valid = pages.filter((p) => p.status < 400);
  const text = norm(valid.map((p) => p.text).join(' '));
  const source = google?.mode === 'live' && google.status === 'connected' && google.remote?.fetchedAt ? google.remote : null;
  const expected = { name: source?.title || business.name, phone: source?.phone || business.phone, address: source?.address || [business.address?.line1, business.address?.city, business.address?.postalCode].filter(Boolean).join(' '), city: business.address?.city };
  const businessTypes = ['LocalBusiness', 'HairSalon', 'BeautySalon', 'DaySpa', 'MedicalBusiness', 'Dentist', 'Restaurant', 'Store', 'Optician', 'HealthClub', 'ProfessionalService'];
  const structured = valid.flatMap((p) => p.structured).filter((item) => [].concat(item['@type']).some((type) => businessTypes.includes(type)));
  if (!structured.length) add('local', 'schema', 'medium', 'Business structured data not found', 'Consider accurate LocalBusiness structured data appropriate to your actual business type.', url);
  const declaredNames = structured.map((s) => s.name).filter(Boolean);
  if (expected.name && declaredNames.some((name) => norm(name) !== norm(expected.name))) add('local', 'name-mismatch', 'high', 'Business name differs in structured data', `Expected: ${expected.name}. Found: ${declaredNames.join(', ')}. Confirm the correct identity.`, url);
  else if (expected.name && !text.includes(norm(expected.name)) && !declaredNames.some((name) => norm(name) === norm(expected.name))) add('local', 'name-not-found', 'review', 'Business name not found in readable pages', `Look for the real name: ${expected.name}.`, url);
  const phones = [...new Set([...valid.flatMap((p) => p.phones), ...structured.map((s) => String(s.telephone || '').replace(/\D/g, '')).filter(Boolean)])];
  const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  if (expected.phone && phones.length && !phones.some((p) => digits(p) === digits(expected.phone))) add('local', 'phone-mismatch', 'high', 'Phone number differs', `Expected: ${expected.phone}. Website declares: ${phones.join(', ')}.`, url);
  else if (expected.phone && !phones.length && !digits(text).includes(digits(expected.phone))) add('local', 'phone-not-found', 'review', 'Contact phone not found', 'Add the correct business phone to the contact details.', url);
  const addresses = structured.map((s) => s.address).filter((a) => a && typeof a === 'object');
  if (expected.address && addresses.some((a) => a.addressLocality && !norm(expected.address).includes(norm(a.addressLocality)))) add('local', 'city-mismatch', 'high', 'Location differs in structured data', `Compare with the profile address: ${expected.address}.`, url);
  if (expected.address && addresses.some((a) => a.streetAddress && !norm(expected.address).includes(norm(a.streetAddress)))) add('local', 'address-mismatch', 'review', 'Street address differs in structured data', `Compare with ${expected.address}. Check spelling and formatting before correcting.`, url);
  if (expected.city && !text.includes(norm(expected.city))) add('local', 'local-market', 'review', 'Local market not found in readable content', `Describe genuine services in ${expected.city} where relevant.`, url);
  const coverage = services.map((service) => {
    const dedicated = valid.filter((p) => new URL(p.url).pathname !== '/' && norm([p.title, ...p.headings].join(' ')).includes(norm(service.name)));
    return { service: service.name, pages: dedicated.map((p) => p.url), mentioned: text.includes(norm(service.name)) };
  });
  for (const item of coverage.filter((s) => !s.pages.length)) add('services', 'service-page', 'review', `Review page coverage: ${item.service}`, 'No dedicated page found in the audited sample. Confirm before creating a page with real service details, location, FAQs and booking information.', url);
  for (const failure of failures) add('technical', failure.code || 'unavailable', 'review', failure.code === 'robots' ? 'Crawl excluded by robots.txt' : 'Page could not be checked', failure.error, failure.url);
  if (robots.status !== 200) add('technical', 'robots', 'review', 'Review robots.txt availability', `Returned ${robots.status || 'an unavailable response'}.`, robots.url);
  if (!sitemap.found) add('technical', 'sitemap', 'review', 'Sitemap not found', 'No readable sitemap was found at the checked URLs.', url);
  return { url, completedAt: now, pages: pages.map(({ text, structured, contentHash, ...p }) => p), findings: findings.sort((a, b) => ({ high: 0, medium: 1, review: 2 }[a.severity] - { high: 0, medium: 1, review: 2 }[b.severity])), coverage, comparisonSource: source ? 'Google snapshot' : 'Saved business profile', robots, sitemap, summary: { pages: pages.length, issues: findings.length, broken: pages.filter((p) => p.status >= 400).length, noindex: pages.filter((p) => p.noindex).length }, limitations: ['A bounded HTML crawl; uncrawled pages and JavaScript-rendered content may change findings.', 'External backlinks and business mentions require an SEO data provider; no backlink score is estimated.', 'PageSpeed, Core Web Vitals, rankings and visual mobile behavior are not measured by this crawl.', 'Recommendations are opportunities to review, not promises of higher rankings.'] };
}

export async function crawlWebsite(url, context, { fetcher = fetchPublic, maxPages = 20 } = {}) {
  const start = publicUrl(url);
  const signal = AbortSignal.timeout(90000);
  const robotsCache = new Map();
  const getRobots = async (origin) => {
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    const location = `${origin}/robots.txt`;
    let result;
    try { result = await fetcher(location, { signal, maxBytes: 200000 }); } catch (err) { result = { url: location, status: 0, html: '', error: err.message }; }
    const rule = { result, parser: robotsParser(location, result.status === 200 ? result.html : '') };
    robotsCache.set(origin, rule);
    return rule;
  };
  const allowed = async (target) => {
    const rule = await getRobots(target.origin);
    if (rule.result.status !== 200 && rule.result.status !== 404) throw Object.assign(new Error('robots.txt could not be checked; crawl paused for this page'), { code: 'robots' });
    if (rule.parser.isAllowed(target.href, 'ReviewRankrBot') === false) throw Object.assign(new Error('robots.txt excludes this page'), { code: 'robots' });
  };
  const home = await fetcher(start.href, { signal, beforeRequest: allowed });
  if (home.status >= 400 || !/html/i.test(home.headers['content-type'] || '')) throw new Error(`The website homepage returned ${home.status} or is not HTML`);
  const origin = new URL(home.url).origin;
  const sameSite = (link) => { try { const u = new URL(link); return u.origin === origin && !u.search && !/\.(?:jpg|jpeg|png|webp|gif|svg|pdf|mp4|zip|css|js|woff2?)$/i.test(u.pathname); } catch { return false; } };
  const robotsRule = await getRobots(origin);
  const sitemapUrls = [...new Set([...robotsRule.parser.getSitemaps(), `${origin}/sitemap.xml`])].filter((u) => sameSite(u)).slice(0, 3);
  const sitemap = { found: false, urls: [], discoveredPages: 0 };
  const candidates = [];
  for (const location of sitemapUrls) {
    try {
      const result = await fetcher(location, { signal, maxBytes: 500000 });
      if (result.status !== 200) continue;
      const $ = load(result.html, { xmlMode: true });
      const links = $('url > loc').map((_, e) => $(e).text().trim()).get().filter(sameSite);
      if ($('urlset,sitemapindex').length) { sitemap.found = true; sitemap.urls.push(location); }
      candidates.push(...links);
      // Sitemap indexes are acknowledged, but their child maps are outside this bounded crawl.
    } catch { /* Discovery failure is reported through sitemap availability. */ }
  }
  sitemap.discoveredPages = candidates.length;
  const pages = [analyzePage(home)];
  const queue = [...new Set([...pages[0].links.filter(sameSite), ...candidates])];
  const seen = new Set([home.url, start.href]);
  const failures = [];
  while (queue.length && pages.length + failures.length < maxPages && !signal.aborted) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      const result = await fetcher(next, { signal, beforeRequest: async (target) => { if (target.origin !== origin) throw new Error('Redirect leaves the audited website'); await allowed(target); } });
      if (seen.has(result.url) && result.url !== next) continue;
      seen.add(result.url);
      if (result.status < 400 && !/html/i.test(result.headers['content-type'] || '')) continue;
      const page = analyzePage(result);
      pages.push(page);
      queue.push(...page.links.filter((link) => sameSite(link) && !seen.has(link)));
    } catch (err) { failures.push({ url: next, error: err.message, code: err.code }); }
  }
  const report = buildWebsiteReport({ url: home.url, pages, failures, robots: { url: robotsRule.result.url, status: robotsRule.result.status }, sitemap, ...context });
  report.limits = { maxPages, remainingLinks: new Set(queue.filter((link) => !seen.has(link))).size, timeLimitReached: signal.aborted };
  return report;
}
