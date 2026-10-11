import { isLiveConnection } from '../reviews/policy.js';

const norm = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function pinDistance(a, b) {
  if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite)) return null;
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude), dLng = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h))));
}

export function locationAudit(business, account) {
  const connected = isLiveConnection(account);
  const remote = connected ? account.remote || {} : {};
  const settings = business.locationSettings || {};
  const findings = [];
  const add = (title, detail, status = 'review') => findings.push({ title, detail, status });
  if (!settings.confirmedAt || settings.type === 'unknown') add('Confirm how this location operates', 'Choose storefront, service-area or hybrid based on your actual operations.');
  if (settings.confirmedAt && settings.virtualOffice) add('Review location eligibility', 'A mailing or virtual office alone does not establish an eligible operating location.');
  if (settings.type === 'storefront' || settings.type === 'hybrid') {
    if (!business.address?.line1 || !business.address?.city) add('Complete the physical address', 'Add the accurate street address and city.', 'missing');
    if (!settings.receivesCustomers || !settings.permanentSignage || !settings.staffedDuringHours) add('Review storefront eligibility', 'Confirm customer access, permanent signage and staffing during stated hours. Eligibility exceptions must be checked with Google.');
  }
  if (settings.type === 'service_area' || settings.type === 'hybrid') {
    if (!settings.visitsCustomers) add('Confirm service-area eligibility', 'Service areas apply to businesses that actually serve customers at their locations.');
    if (!business.serviceAreas?.length) add('Add actual service areas', 'List the cities or areas where you genuinely provide service.', 'missing');
  }
  if (settings.type === 'storefront' && business.serviceAreas?.length && !settings.visitsCustomers) add('Review saved service areas', 'Areas are saved, but customer-location service has not been confirmed.');
  const expectedType = { service_area: 'CUSTOMER_LOCATION_ONLY', hybrid: 'CUSTOMER_AND_BUSINESS_LOCATION' }[settings.type];
  if (connected && expectedType && remote.serviceArea?.businessType !== expectedType) add('Business type differs from Google', 'Review your actual operating model and the service-area configuration in Google.');
  if (settings.type === 'service_area' && remote.address) add('Review address visibility', 'Customer-location-only businesses should check that their private address is hidden on Google.');
  const remoteAreas = (remote.serviceArea?.places?.placeInfos || []).map((p) => p.placeName);
  if (connected && business.serviceAreas?.length && remote.serviceArea && JSON.stringify(business.serviceAreas.map(norm).sort()) !== JSON.stringify(remoteAreas.map(norm).sort())) add('Service areas differ from Google', 'Confirm the actual coverage and naming before correcting either list.');
  const distance = pinDistance(settings.pin, remote.latlng);
  if (remote.openInfo?.status && remote.openInfo.status !== 'OPEN') add('Review the Google operating status', `Google reports ${remote.openInfo.status.replace(/_/g, ' ').toLowerCase()}. Confirm this matches the location's actual status.`);
  if (distance !== null && distance > 100) add('Map pin differs from your confirmed point', `The two points are approximately ${distance} metres apart. Review the entrance or operating location; this is not a search-ranking distance measure.`);
  if (!remote.latlng) add('Google map pin unavailable', 'Refresh a connected Google profile to check its reported coordinates.', 'unknown');
  if (!settings.pin && settings.type !== 'service_area') add('Confirm the actual map point', 'Record coordinates only for a genuine operating location.');
  const inventory = connected ? account.locationInventory || [] : [];
  const duplicates = new Map();
  for (const location of inventory) {
    if (!location.address) continue;
    const key = `${norm(location.title)}|${norm(location.address)}`;
    duplicates.set(key, [...(duplicates.get(key) || []), location]);
  }
  for (const group of duplicates.values()) if (group.length > 1) add('Review possible duplicate profiles', `${group.length} authorized profiles share the same name and address. Review eligibility before making changes; nothing is merged or deleted automatically.`);
  for (const location of inventory) if (!location.hours?.length) add(`Check hours: ${location.title}`, 'No regular hours were returned for this authorized location. Confirm whether hours apply.');
  return { connected, findings, settings, remote: { address: remote.address || '', latlng: remote.latlng || null, serviceAreas: remoteAreas, businessType: remote.serviceArea?.businessType || null, openStatus: remote.openInfo?.status || null, mapsUri: remote.mapsUri || null, fetchedAt: remote.fetchedAt || null }, pinDistanceMetres: distance, inventory, inventoryFetchedAt: connected ? account.locationsFetchedAt || null : null };
}
