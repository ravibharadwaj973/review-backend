import { env } from '../../config/env.js';

export function normalizeResults(data) {
  if (data?.error || data?.search_metadata?.status !== 'Success' || !Array.isArray(data.local_results)) throw new Error('Provider did not return a successful structured Maps search. No ranking was recorded.');
  const organic = data.local_results.filter(r => !r.ad && !r.sponsored);
  if (organic.some(r => !r.place_id || !Number.isInteger(r.position) || r.position < 1) || new Set(organic.map(r => r.position)).size !== organic.length) throw new Error('Provider returned incomplete result identities or positions. No ranking was recorded.');
  const seen = new Set();
  return organic.filter(r => r.position <= 20).filter(r => {
    if (!r.place_id || seen.has(r.place_id)) return false;
    seen.add(r.place_id); return true;
  }).map(r => ({ position: r.position, placeId: String(r.place_id).slice(0, 200), title: String(r.title || 'Unnamed result').slice(0, 200), address: String(r.address || '').slice(0, 400), rating: typeof r.rating === 'number' ? r.rating : undefined }));
}

export async function searchPoint(scan, point, fetcher = fetch) {
  if (!env.mapVisibility.apiKey) throw new Error('Map search provider is not configured.');
  const query = new URLSearchParams({ engine: 'google_maps', type: 'search', q: scan.keyword, ll: `@${point.latitude},${point.longitude},${Math.round(scan.radiusKm * 2000)}m`, hl: scan.language, no_cache: 'true', api_key: env.mapVisibility.apiKey });
  if (/\bnear me\b/i.test(scan.keyword)) query.set('nearby', 'true');
  let response;
  try { response = await fetcher(`https://serpapi.com/search.json?${query}`, { signal: AbortSignal.timeout(25000), redirect: 'error' }); } catch { throw new Error('Map provider request timed out or could not connect.'); }
  if (!response.ok) throw new Error(`Map provider rejected the request (HTTP ${response.status}). Check its key, credit balance and availability.`);
  let data;
  try { data = await response.json(); } catch { throw new Error('Map provider returned unreadable data.'); }
  const results = normalizeResults(data);
  return { results, rank: results.find(r => r.placeId === scan.placeId)?.position ?? null, searchId: String(data.search_metadata.id || '').slice(0, 100), checkedAt: new Date(), status: 'checked' };
}
