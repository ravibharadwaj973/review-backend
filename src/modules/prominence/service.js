import { load } from 'cheerio';
import robotsParser from 'robots-parser';
import { fetchPublic, publicUrl } from '../website/network.js';

const norm = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const digits = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const host = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

export function externalEvidence(result, business) {
  const $ = load(result.html);
  const declarations = [];
  $('script[type="application/ld+json" i]').each((_, e) => {
    try {
      const visit = (object) => { if (Array.isArray(object)) object.forEach(visit); else if (object && typeof object === 'object') { if (object.name || object.telephone || object.address) declarations.push(object); if (object['@graph']) visit(object['@graph']); } };
      visit(JSON.parse($(e).text()));
    } catch { /* Invalid publisher data is not treated as verified identity. */ }
  });
  const links = [];
  const ownWebsite = !!business.links?.website && host(result.url) === host(business.links.website);
  $('a[href]').each((_, e) => {
    try {
      const link = new URL($(e).attr('href'), result.url);
      if (!ownWebsite && ['https:', 'http:'].includes(link.protocol) && business.links?.website && host(link.href) === host(business.links.website)) links.push({ url: link.href.slice(0, 2000), text: $(e).text().trim().slice(0, 200), rel: $(e).attr('rel') || '' });
    } catch { /* Non-web links cannot be evidence of a backlink. */ }
  });
  const phones = [...new Set($('a[href^="tel:"]').map((_, e) => $(e).attr('href').slice(4)).get())].slice(0, 30);
  $('script,style,noscript').remove();
  const readable = $('body').text().replace(/\s+/g, ' ').trim();
  const text = norm(readable);
  const nameFound = !!business.name && text.includes(norm(business.name));
  const related = declarations.filter((d) => norm(d.name) === norm(business.name) || d.url && business.links?.website && (() => { try { return host(d.url) === host(business.links.website); } catch { return false; } })());
  const issues = [];
  if (ownWebsite) issues.push('This is the saved business website; its internal links are not external backlink evidence.');
  if (!nameFound && !related.length) issues.push('The business name was not found in readable content or matching structured data.');
  if (related.some((d) => d.name && norm(d.name) !== norm(business.name))) issues.push('A related structured-data business name differs from the saved name.');
  if (business.phone && related.some((d) => d.telephone && digits(d.telephone) !== digits(business.phone))) issues.push('A related structured-data phone number differs from the saved business phone.');
  if (nameFound && !related.length && business.phone && phones.length && !phones.some((phone) => digits(phone) === digits(business.phone))) issues.push('Observed contact numbers do not match the saved phone. Review their association; they may be publisher contact numbers.');
  if (business.address?.city && related.some((d) => d.address?.addressLocality && norm(d.address.addressLocality) !== norm(business.address.city))) issues.push('A related structured-data city differs from the saved business city.');
  if (business.address?.line1 && related.some((d) => d.address?.streetAddress && norm(d.address.streetAddress) !== norm(business.address.line1))) issues.push('A related structured-data street address differs. Check formatting before correcting.');
  if (!links.length && business.links?.website) issues.push('No direct link to the saved website was found in this HTML page.');
  const at = readable.toLowerCase().indexOf(String(business.name || '').toLowerCase());
  return { url: result.url, title: $('title').text().trim().slice(0, 300), status: result.status, nameFound, websiteLinks: links.slice(0, 20), phones, relatedDeclarations: related.map((d) => ({ name: String(d.name || '').slice(0, 160), telephone: String(d.telephone || '').slice(0, 50), address: d.address })).slice(0, 10), excerpt: nameFound && at >= 0 ? readable.slice(Math.max(0, at - 100), at + 300) : '', issues, authority: 'Not measured', reviewSentiment: 'Not measured', checkedAt: new Date() };
}

export async function checkExternalSource(url, business, fetcher = fetchPublic) {
  const rules = new Map();
  const result = await fetcher(publicUrl(url).href, { beforeRequest: async (target) => {
    let parser = rules.get(target.origin);
    if (!parser) {
      const response = await fetcher(`${target.origin}/robots.txt`, { maxBytes: 200000 });
      if (![200, 404].includes(response.status)) throw new Error('robots.txt could not be checked for this source');
      parser = robotsParser(`${target.origin}/robots.txt`, response.status === 200 ? response.html : '');
      rules.set(target.origin, parser);
    }
    if (parser.isAllowed(target.href, 'ReviewRankrBot') === false) throw new Error('This source excludes automated checks in robots.txt');
  } });
  if (result.status >= 400 || !/html/i.test(result.headers['content-type'] || '')) throw new Error(`Source returned ${result.status} or is not a readable HTML page`);
  return externalEvidence(result, business);
}
