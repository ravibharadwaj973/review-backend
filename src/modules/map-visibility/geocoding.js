import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { GeocodeCache } from '../../models/index.js';
import { HttpError, badRequest } from '../../utils/http.js';

export function normalizeGeocoding(data) {
  if (data?.status === 'ZERO_RESULTS') return [];
  if (data?.status !== 'OK' || !Array.isArray(data.results)) throw new HttpError(502, 'Google could not geocode this location. Check API access, billing and key restrictions.');
  return data.results.slice(0, 5).map(result => {
    const point = result.geometry?.location;
    if (!result.place_id || !Number.isFinite(point?.lat) || Math.abs(point.lat) > 80 || !Number.isFinite(point?.lng) || Math.abs(point.lng) > 180) throw new HttpError(502, 'Google returned invalid or unsupported coordinates.');
    return { placeId: String(result.place_id).slice(0, 200), latitude: point.lat, longitude: point.lng, address: String(result.formatted_address || '').slice(0, 600), locationType: String(result.geometry.location_type || ''), partialMatch: !!result.partial_match };
  });
}
export async function fetchGeocoding({ address, placeId }, fetcher = fetch) {
  if (!env.mapVisibility.geocodingKey) throw badRequest('The backend Geocoding API is not configured.');
  const params = new URLSearchParams({ key: env.mapVisibility.geocodingKey, ...(placeId ? { place_id: placeId } : { address }) });
  let response, data;
  try { response = await fetcher(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { redirect: 'error', signal: AbortSignal.timeout(12000) }); } catch { throw new HttpError(502, 'Google Geocoding could not be reached.'); }
  if (!response.ok) throw new HttpError(502, 'Google Geocoding rejected the request.');
  try { data = await response.json(); } catch { throw new HttpError(502, 'Google Geocoding returned unreadable data.'); }
  return normalizeGeocoding(data);
}
export async function geocodeLocation(business, query) {
  const now = new Date();
  const queryKey = createHash('sha256').update(JSON.stringify(query)).digest('hex');
  const cached = await GeocodeCache.findOne({ business, expiresAt: { $gt: now }, ...(query.placeId ? { 'results.placeId': query.placeId } : { queryKey }) }).lean();
  if (cached) return { ...cached, results: query.placeId ? cached.results.filter(r => r.placeId === query.placeId) : cached.results };
  const results = await fetchGeocoding(query);
  // Google-derived content is temporary; Place IDs may be retained separately.
  const expiresAt = new Date(Date.now() + 29 * 86400000);
  return GeocodeCache.findOneAndUpdate({ business, queryKey }, { $set: { results, fetchedAt: now, expiresAt } }, { new: true, upsert: true, runValidators: true }).lean();
}
export async function trackingLocation(settings) {
  if (!settings || settings.coordinateSource !== 'google') return settings ? { center: settings.center, expiresAt: null } : null;
  const cache = await GeocodeCache.findOne({ business: settings.business, 'results.placeId': settings.placeId, expiresAt: { $gt: new Date() } }).lean();
  const result = cache?.results.find(r => r.placeId === settings.placeId);
  return result ? { center: { latitude: result.latitude, longitude: result.longitude }, expiresAt: cache.expiresAt } : { center: null, expiresAt: null };
}
