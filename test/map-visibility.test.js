import { test } from 'node:test';
import assert from 'node:assert/strict';
import geolib from 'geolib';
import { generateGrid, metrics, signature, compareScans, competitorMetrics, regions, scanReport } from '../src/modules/map-visibility/metrics.js';
import { normalizeResults, searchPoint } from '../src/modules/map-visibility/provider.js';
import { settingsSchema, scanSchema } from '../src/modules/map-visibility/routes.js';
import { env } from '../src/config/env.js';
import { normalizeGeocoding, fetchGeocoding, trackingLocation } from '../src/modules/map-visibility/geocoding.js';

const configuration = { businessName: 'QA Salon', placeId: 'ChIJ_test_business', center: { latitude: 28.6, longitude: 77.2 }, keyword: 'hair salon near me', gridSize: 3, radiusKm: 5, rankingRange: 20, language: 'en', provider: 'serpapi' };
const makeScan = (ranks, date = '2026-10-11T12:00:00Z') => ({ ...configuration, createdAt: date, signature: signature(configuration), status: 'complete', points: generateGrid(configuration.center, 5, 3).map((p, i) => ({ ...p, status: 'checked', rank: ranks[i] ?? null, results: ranks[i] ? [{ placeId: configuration.placeId, title: 'QA Salon', position: ranks[i] }] : [] })) });

test('all supported grids stay within radius, including dateline centers', () => {
  for (const center of [configuration.center, { latitude: 79, longitude: 179.99 }, { latitude: -79, longitude: -179.99 }]) for (const size of [3, 5, 7, 9]) {
    const points = generateGrid(center, 5, size);
    assert.equal(points.length, size * size);
    assert.equal(new Set(points.map(p => p.index)).size, points.length);
    for (const p of points) { assert.ok(geolib.getDistance(center, p) <= 5001); assert.ok(p.longitude >= -180 && p.longitude <= 180); }
    const mid = points[(points.length - 1) / 2];
    assert.ok(geolib.getDistance(center, mid) <= 1);
    assert.ok(points.every(p => p.rank === null && p.status === 'pending'));
  }
});
test('visibility, found-only rank, median and ranking cutoffs use actual results', () => {
  const scan = makeScan([1, 3, 6, 12, 20, null, null, null, null]);
  const m = metrics(scan.points, 20);
  assert.equal(m.visibility, 55.6); assert.equal(m.average, 8.4); assert.equal(m.median, 6); assert.equal(m.best, 1); assert.equal(m.worst, 20); assert.equal(m.notVisible, 4);
  assert.equal(metrics(scan.points, 3).visible, 2);
  assert.equal(metrics(scan.points, 3).top10, 33.3);
  assert.equal(metrics(scan.points, 10).visible, 3);
});
test('unknown and failed points never become not-found results or invented percentages', () => {
  const scan = makeScan([1]); scan.points[1].status = 'error'; scan.points[2].status = 'pending';
  const m = metrics(scan.points, 20);
  assert.equal(m.visibility, null); assert.equal(m.top3, null); assert.equal(m.unknown, 2); assert.equal(m.notVisible, 6);
  assert.equal(metrics([], 20).visibility, null);
  assert.equal(metrics(makeScan([]).points, 20).average, null);
});
test('comparison requires an earlier complete scan and identical measurement configuration', () => {
  const current = makeScan([1, 2, 3, 4]), previous = makeScan([5, 6], '2026-10-01T12:00:00Z');
  assert.equal(compareScans(current, previous).visibilityChange, 22.2);
  assert.equal(compareScans(current, previous).averageImprovement, 3);
  for (const [field, value] of [['radiusKm', 3], ['keyword', 'facial'], ['language', 'hi'], ['rankingRange', 10], ['placeId', 'other']]) {
    const modified = { ...previous, [field]: value }; modified.signature = signature(modified);
    assert.equal(compareScans(current, modified).comparable, false);
  }
  assert.equal(compareScans(current, { ...previous, status: 'partial' }).comparable, false);
  assert.equal(compareScans(previous, current).comparable, false);
});
test('competitors are matched by stable Place IDs, not names; regions partition all points', () => {
  const scan = makeScan([5]);
  scan.points[1].results = [{ placeId: 'competitor-id', title: 'QA Salon', position: 1 }];
  const rivals = competitorMetrics(scan);
  assert.equal(rivals.find(c => c.own).visible, 1);
  assert.equal(rivals.find(c => c.placeId === 'competitor-id').visible, 1);
  assert.equal(regions(scan).reduce((n, r) => n + r.total, 0), 9);
  scan.points.forEach((p, i) => { p.results = Array.from({ length: 20 }, (_, j) => ({ placeId: `rival-${i}-${j}`, title: 'Rival', position: j + 1 })); });
  assert.equal(competitorMetrics(scan)[0].own, true);
});
test('provider rejects missing/error/processing/malformed data rather than recording rank', () => {
  for (const data of [{}, { error: 'quota', local_results: [] }, { search_metadata: { status: 'Processing' }, local_results: [] }, { search_metadata: { status: 'Success' }, local_results: [{ position: 1, title: 'missing id' }] }]) assert.throws(() => normalizeResults(data));
  assert.deepEqual(normalizeResults({ search_metadata: { status: 'Success' }, local_results: [] }), []);
  const rows = normalizeResults({ search_metadata: { status: 'Success' }, local_results: [{ position: 1, place_id: 'ad', ad: true }, { position: 2, place_id: 'real', title: 'Real business' }, { position: 21, place_id: 'outside' }] });
  assert.deepEqual(rows.map(r => r.placeId), ['real']);
});
test('provider requests use each point, near-me localization and server-only key without leaking error details', async () => {
  const original = env.mapVisibility.apiKey; env.mapVisibility.apiKey = 'fixture-key';
  try {
    const scan = makeScan([1]), point = scan.points[0]; let query;
    const result = await searchPoint(scan, point, async url => {
      query = new URL(url).searchParams;
      return { ok: true, json: async () => ({ search_metadata: { status: 'Success', id: 'search-fixture' }, local_results: [{ position: 3, place_id: configuration.placeId, title: 'QA Salon' }] }) };
    });
    assert.equal(query.get('q'), scan.keyword); assert.equal(query.get('nearby'), 'true'); assert.equal(query.get('no_cache'), 'true'); assert.ok(query.get('ll').includes(String(point.latitude))); assert.equal(result.rank, 3);
    await assert.rejects(searchPoint(scan, point, async () => { throw new Error('URL with fixture-key'); }), e => !e.message.includes('fixture-key'));
    await assert.rejects(searchPoint(scan, point, async () => ({ ok: false, status: 429 })), /HTTP 429/);
  } finally { env.mapVisibility.apiKey = original; }
});
test('settings and scan validations bound cost, location and explicit approval', () => {
  const settings = { placeId: configuration.placeId, center: configuration.center, keywords: ['salon', 'salon'], language: 'en', confirmed: true };
  assert.deepEqual(settingsSchema.parse(settings).keywords, ['salon']);
  assert.equal(settingsSchema.safeParse({ ...settings, confirmed: false }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, center: { latitude: 91, longitude: 77 } }).success, false);
  const request = { keyword: 'salon', radiusKm: 5, gridSize: 5, rankingRange: 20, approved: true };
  for (const patch of [{ approved: false }, { radiusKm: 100 }, { gridSize: 20 }, { rankingRange: 100 }]) assert.equal(scanSchema.safeParse({ ...request, ...patch }).success, false);
});
test('client report is observational, date-stamped and labels incomplete data', () => {
  const scan = makeScan([1]); scan.points[2].status = 'error'; scan.status = 'partial';
  const report = scanReport(scan);
  assert.match(report, /ReviewRankr/); assert.match(report, /2026-10-11/); assert.match(report, /Unavailable \(incomplete scan\)/); assert.match(report, /not a Google-provided/); assert.doesNotMatch(report, /rank higher by|guaranteed improvement/i);
});

test('geocoding keeps partial matches explicit and never fabricates coordinates on errors', () => {
  assert.deepEqual(normalizeGeocoding({ status: 'ZERO_RESULTS' }), []);
  assert.throws(() => normalizeGeocoding({ status: 'REQUEST_DENIED', error_message: 'secret-key-detail' }), e => !e.message.includes('secret-key-detail'));
  assert.throws(() => normalizeGeocoding({ status: 'OK', results: [{ place_id: 'id', geometry: { location: { lat: 100, lng: 77 } } }] }));
  const result = normalizeGeocoding({ status: 'OK', results: [{ place_id: 'ChIJ_geocode_fixture', formatted_address: 'Delhi', partial_match: true, geometry: { location: { lat: 28.6, lng: 77.2 }, location_type: 'APPROXIMATE' } }] })[0];
  assert.equal(result.partialMatch, true); assert.equal(result.locationType, 'APPROXIMATE'); assert.equal(result.latitude, 28.6);
});
test('backend geocoding uses the private key only against the fixed Google endpoint', async () => {
  const original = env.mapVisibility.geocodingKey; env.mapVisibility.geocodingKey = 'fixture-secret';
  try {
    let url;
    await fetchGeocoding({ address: 'Actual address, Delhi' }, async value => { url = new URL(value); return { ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) }; });
    assert.equal(url.origin, 'https://maps.googleapis.com'); assert.equal(url.searchParams.get('address'), 'Actual address, Delhi'); assert.equal(url.searchParams.get('key'), 'fixture-secret');
    await assert.rejects(fetchGeocoding({ placeId: 'ChIJ_fixture' }, async () => { throw new Error('fixture-secret'); }), e => !e.message.includes('fixture-secret'));
  } finally { env.mapVisibility.geocodingKey = original; }
});
test('Google location cache is tenant scoped, expiring, and independent coordinates remain usable', async () => {
  const { GeocodeCache } = await import('../src/models/index.js');
  const original = GeocodeCache.findOne; let query;
  GeocodeCache.findOne = value => { query = value; return { lean: async () => null }; };
  try {
    const expired = await trackingLocation({ business: 'owned', coordinateSource: 'google', placeId: 'ChIJ_fixture' });
    assert.equal(expired.center, null); assert.equal(query.business, 'owned'); assert.ok(query.expiresAt.$gt instanceof Date);
    assert.deepEqual(await trackingLocation({ center: configuration.center, coordinateSource: 'owner' }), { center: configuration.center, expiresAt: null });
    assert.ok(GeocodeCache.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
  } finally { GeocodeCache.findOne = original; }
});

test('scan read, report and cancellation queries stay fenced to the signed-in business', async () => {
  const { mapVisibilityRouter } = await import('../src/modules/map-visibility/routes.js');
  const { MapScan } = await import('../src/models/index.js');
  const original = MapScan.findOne;
  const captured = [];
  MapScan.findOne = query => { captured.push(query); return { lean: async () => null }; };
  try {
    assert.ok(mapVisibilityRouter.stack.some(layer => layer.handle.name === 'requireAuth'));
    assert.ok(mapVisibilityRouter.stack.some(layer => layer.handle.name === 'requireBusiness'));
    for (const path of ['/scans/:id', '/scans/:id/report', '/scans/:id/cancel']) {
      const route = mapVisibilityRouter.stack.find(layer => layer.route?.path === path).route;
      const handler = route.stack.at(-1).handle;
      let error;
      await handler({ params: { id: 'a'.repeat(24) }, query: {}, business: { _id: 'owned-business' } }, {}, err => { error = err; });
      assert.equal(error.status, 404);
      assert.equal(captured.at(-1).business, 'owned-business');
    }
  } finally { MapScan.findOne = original; }
});

test('missing provider key blocks scan creation before database writes', async () => {
  const { mapVisibilityRouter } = await import('../src/modules/map-visibility/routes.js');
  const original = env.mapVisibility.apiKey; env.mapVisibility.apiKey = '';
  try {
    const route = mapVisibilityRouter.stack.find(layer => layer.route?.path === '/scans' && layer.route.methods.post).route;
    let error;
    await route.stack.at(-1).handle({ body: { keyword: 'salon', radiusKm: 5, gridSize: 5, rankingRange: 20, approved: true }, business: { _id: 'owned' } }, {}, err => { error = err; });
    assert.equal(error.status, 400); assert.match(error.message, /SERPAPI_API_KEY/);
  } finally { env.mapVisibility.apiKey = original; }
});

test('persistent runner records success and stops immediately on provider failure without auto retry', async () => {
  const { runMapScans } = await import('../src/modules/map-visibility/runner.js');
  const { MapScan, Business } = await import('../src/models/index.js');
  const originals = { updateMany: MapScan.updateMany, findOneAndUpdate: MapScan.findOneAndUpdate, findById: MapScan.findById, updateOne: MapScan.updateOne, business: Business.findById, fetch: global.fetch, key: env.mapVisibility.apiKey };
  try {
    env.mapVisibility.apiKey = 'fixture-only';
    for (const failure of [false, true]) {
      let claimed = false, calls = 0;
      const updates = [];
      const scan = { ...configuration, _id: 'scan-fixture', business: 'owned-business', points: generateGrid(configuration.center, 5, 3) };
      MapScan.updateMany = async (query, update) => { assert.equal(query.status, 'running'); assert.ok(query.leaseUntil.$lt instanceof Date); assert.equal(update.$set.status, 'failed'); return {}; };
      MapScan.findOneAndUpdate = async () => { if (claimed) return null; claimed = true; return scan; };
      MapScan.findById = () => ({ select: () => ({ lean: async () => ({ active: true }) }) });
      Business.findById = () => ({ select: () => ({ lean: async () => ({ account: { status: 'active' } }) }) });
      MapScan.updateOne = async (query, update) => { assert.equal(query.active, true); updates.push(structuredClone(update.$set)); return { modifiedCount: 1 }; };
      global.fetch = async () => { calls++; return failure ? { ok: false, status: 429 } : { ok: true, json: async () => ({ search_metadata: { status: 'Success', id: 'fixture' }, local_results: [{ position: 2, place_id: configuration.placeId, title: 'QA Salon' }] }) }; };
      await runMapScans();
      assert.equal(calls, failure ? 1 : 9);
      assert.equal(updates.at(-1).status, failure ? 'failed' : 'complete');
      assert.equal(updates.at(-1).active, false);
      assert.equal(updates.at(-1).summary.visibility, failure ? null : 100);
      if (failure) assert.equal(scan.points.filter(p => p.status === 'pending').length, 8);
    }
  } finally {
    for (const name of ['updateMany', 'findOneAndUpdate', 'findById', 'updateOne']) MapScan[name] = originals[name];
    Business.findById = originals.business; global.fetch = originals.fetch; env.mapVisibility.apiKey = originals.key;
  }
});
