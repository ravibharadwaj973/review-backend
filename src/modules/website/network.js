import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import { HttpError } from '../../utils/http.js';

export const isPublicAddress = (address) => {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
};

export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Enter a full public website URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) throw new HttpError(400, 'Use a public HTTP or HTTPS website');
  url.hash = '';
  return url;
}

/** Pin a checked public address for each request, including every redirect. */
export async function fetchPublic(value, { beforeRequest, signal, maxBytes = 1_000_000 } = {}) {
  let url = publicUrl(value);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (beforeRequest) await beforeRequest(url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new HttpError(400, 'The website resolves to a private or reserved address');
    const pinned = addresses[0];
    const agent = new Agent({ connect: { lookup: (_host, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family) } });
    const start = Date.now();
    try {
      const response = await fetch(url, { dispatcher: agent, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { 'User-Agent': 'ReviewRankrBot/1.0', Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.8' } });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        await response.body?.cancel();
        url = publicUrl(new URL(response.headers.get('location'), url).href);
        continue;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > maxBytes) throw new HttpError(400, 'The page exceeds the audit download limit');
        chunks.push(Buffer.from(chunk));
      }
      return { url: url.href, status: response.status, headers: Object.fromEntries(response.headers), html: Buffer.concat(chunks).toString('utf8'), bytes: size, responseMs: Date.now() - start };
    } finally { await agent.close(); }
  }
  throw new HttpError(400, 'The website redirects too many times');
}
