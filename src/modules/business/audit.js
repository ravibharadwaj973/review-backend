import { isLiveConnection } from '../reviews/policy.js';

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\/$/, '');
const phone = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const week = (hours = []) => JSON.stringify([...hours].map((h) => ({ day: h.day, closed: !!h.closed, ...(!h.closed ? { open: h.open, close: h.close } : {}) })).sort((a, b) => a.day.localeCompare(b.day)));

export function verificationStatus(remote) {
  const v = remote?.verification;
  if (!v) return 'unknown';
  if (v.hasVoiceOfMerchant === true) return 'verified';
  if (v.verify) return v.verify.hasPendingVerification ? 'pending' : 'needs_verification';
  if (v.waitForVoiceOfMerchant) return 'under_review';
  if (v.resolveOwnershipConflict) return 'ownership_conflict';
  if (v.complyWithGuidelines) return 'needs_attention';
  return 'unknown';
}

/** Findings are grounded in saved fields, Google snapshots and actual customer feedback. */
export function profileAudit(business, { account, services = [], reviews = [], now = new Date() } = {}) {
  const connected = isLiveConnection(account);
  const remote = connected ? account.remote || {} : {};
  const checks = [];
  const add = (id, title, status, recommendation, href) => checks.push({ id, title, status, recommendation, href });
  const field = (id, title, value, googleValue, href, equal = (a, b) => norm(a) === norm(b)) => {
    if (!norm(value)) add(id, title, 'missing', `Add your accurate ${title.toLowerCase()}.`, href);
    else if (connected && remote.fetchedAt && googleValue !== undefined && !equal(value, googleValue)) add(id, title, 'mismatch', 'Saved details differ from Google. Check which is correct before publishing a correction.', href);
    else add(id, title, 'complete', 'Saved in your business profile.', href);
  };
  field('name', 'Business name', business.name, remote.title, '/app/profile?tab=info');
  field('phone', 'Phone', business.phone, remote.phone, '/app/profile?tab=info', (a, b) => phone(a) === phone(b));
  field('website', 'Website', business.links?.website, remote.website, '/app/profile?tab=links');
  const address = [business.address?.line1, business.address?.line2, business.address?.city, business.address?.state, business.address?.postalCode].filter(Boolean).join(', ');
  if (business.locationSettings?.type === 'service_area' && business.locationSettings.visitsCustomers) add('address', 'Address / service area', business.serviceAreas?.length ? 'complete' : 'missing', 'Confirm genuine service areas and private-address visibility in Google.', '/app/locations');
  else if (!business.address?.line1 && business.serviceAreas?.length) add('address', 'Address / service area', 'review', 'Confirm service-area eligibility and actual operating details.', '/app/locations');
  else field('address', 'Address', business.address?.line1 ? address : '', remote.address, '/app/profile?tab=info');
  field('description', 'Business description', business.description, remote.description, '/app/profile?tab=description');
  const days = new Set((business.hours || []).map((h) => h.day));
  const validHours = days.size === 7 && (business.hours || []).every((h) => h.closed || /^([01]\d|2[0-3]):[0-5]\d$/.test(h.open || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.close || ''));
  add('hours', 'Opening hours', !validHours ? 'missing' : remote.hours && week(business.hours) !== week(remote.hours) ? 'mismatch' : 'complete', !validHours ? 'Confirm opening times for every day.' : 'Confirm these times match your actual operations.', '/app/profile?tab=hours');
  const primary = business.googleCategories?.primary;
  field('primary', 'Primary Google category', primary?.name || remote.categories?.primaryCategory?.name, remote.categories?.primaryCategory?.name, '/app/profile?tab=audit');
  const additional = primary?.name ? business.googleCategories?.additional || [] : remote.categories?.additionalCategories || [];
  const remoteAdditional = remote.categories?.additionalCategories || [];
  add('secondary', 'Secondary categories', !additional.length ? 'review' : remote.categories && JSON.stringify(additional.map((c) => c.name).sort()) !== JSON.stringify(remoteAdditional.map((c) => c.name).sort()) ? 'mismatch' : 'complete', 'Use secondary categories only where they describe services you actually offer.', '/app/profile?tab=audit');
  const upcoming = (business.specialHours || []).filter((h) => h.date >= now.toISOString().slice(0, 10));
  add('special', 'Special hours', upcoming.length ? 'complete' : 'review', upcoming.length ? `${upcoming.length} upcoming dates saved.` : 'Confirm holiday hours and any upcoming exceptions.', '/app/profile?tab=hours');
  add('attributes', 'Google attributes', !connected || !Array.isArray(remote.attributes) ? 'unknown' : remote.attributes.length ? 'complete' : 'review', remote.attributeError || 'Check applicable accessibility, amenities and other attributes in Google.', 'https://business.google.com/');
  const verification = connected ? verificationStatus(remote) : 'not_connected';
  add('verification', 'Google verification', verification === 'verified' ? 'complete' : verification === 'unknown' || !connected ? 'unknown' : 'review', remote.verificationError || (verification === 'verified' ? 'Google confirms this profile is in good standing.' : 'Check verification and ownership in Google Business Profile.'), '/app/google');
  add('services', 'Service list', services.length ? 'complete' : 'missing', services.length ? `${services.length} active services saved. Check that your full offering is represented.` : 'Add only the services your business actually offers.', '/app/profile?tab=services');
  const incompleteServices = services.filter((s) => !norm(s.description));
  add('serviceDetails', 'Service details', incompleteServices.length ? 'review' : services.length ? 'complete' : 'missing', incompleteServices.length ? `${incompleteServices.length} services need a description. Add real prices where appropriate.` : 'Keep descriptions and optional prices accurate.', '/app/profile?tab=services');
  const listed = new Set(services.map((s) => norm(s.name)));
  const evidence = new Map();
  for (const name of [...(remote.serviceNames || []), ...reviews.flatMap((r) => r.analysis?.services || [])]) {
    if (norm(name) && !listed.has(norm(name))) evidence.set(norm(name), name);
  }
  const missingServices = [...evidence.values()].map((name) => ({ name, recommendation: 'Mentioned in Google or customer feedback. Confirm you offer it before adding.' }));
  const concerns = new Map();
  for (const r of reviews) for (const theme of new Set([...(r.analysis?.negatives || []), ...(r.analysis?.concerns || [])])) {
    if (!norm(theme)) continue;
    const entry = concerns.get(norm(theme)) || { theme, count: 0 };
    entry.count += 1;
    concerns.set(norm(theme), entry);
  }
  const completed = checks.filter((c) => c.status === 'complete').length;
  const answered = reviews.filter((r) => norm(r.reply?.comment)).length;
  return {
    checks, completed, total: checks.length, score: Math.round(completed / checks.length * 100),
    connected, verification, fetchedAt: remote.fetchedAt || null,
    stale: !!remote.fetchedAt && now - new Date(remote.fetchedAt) > 7 * 864e5,
    categories: remote.categories || null, attributes: remote.attributes || [],
    missingServices,
    search: { month: remote.searchMonth || null, error: remote.searchKeywordError || null, available: Array.isArray(remote.searchKeywords), keywords: (remote.searchKeywords || []).map((item) => ({ term: item.searchKeyword, value: item.insightsValue?.value ?? null, threshold: item.insightsValue?.threshold ?? null, services: services.filter((s) => norm(item.searchKeyword).includes(norm(s.name))).map((s) => s.name) })) },
    reputation: { total: reviews.length, average: reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null, answered, responseCoverage: reviews.length ? Math.round(answered / reviews.length * 100) : null, complaints: [...concerns.values()].filter((c) => c.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10) },
  };
}
