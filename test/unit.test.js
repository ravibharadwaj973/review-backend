import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GROQ_API_KEY = '';
process.env.GROQ_URI = '';

const { heuristicAnalysis, heuristicReply, heuristicRequestMessage, heuristicTopics } = await import('../src/modules/ai/heuristics.js');
const { encrypt, decrypt } = await import('../src/utils/crypto.js');
const { hoursToGoogle, hoursFromGoogle, starToNumber } = await import('../src/modules/google/client.js');
const { fromGoogleReview } = await import('../src/modules/reviews/service.js');
const { analyzeReview, generateReply } = await import('../src/modules/ai/service.js');

const business = { name: 'Glow Studio', category: 'Beauty salon', phone: '+91 98110 24567', voice: { tone: 'warm' } };

test('mixed review yields positive and negative themes', () => {
  const a = heuristicAnalysis({ comment: 'Haircut was great but I had to wait 30 minutes.', rating: 4 }, ['Haircut', 'Facial']);
  assert.equal(a.sentiment, 'mixed');
  assert.deepEqual(a.services, ['Haircut']);
  assert.ok(a.negatives.includes('Waiting time'));
  assert.ok(a.concerns.includes('Appointment delay'));
});

test('low ratings are negative and urgent', () => {
  const a = heuristicAnalysis({ comment: 'Rude receptionist, very disappointed.', rating: 1 }, []);
  assert.equal(a.sentiment, 'negative');
  assert.equal(a.urgency, 'high');
});

test('replies address the reviewer and never invent offers', () => {
  const review = { rating: 2, comment: 'Dirty towels', reviewer: { name: 'Priya Sharma' } };
  const text = heuristicReply({ review, analysis: heuristicAnalysis(review, []), business });
  assert.match(text, /^Hi Priya/);
  assert.match(text, /98110 24567/);
  assert.doesNotMatch(text, /discount|refund|free/i);
});

test('review request contains the link and does not gate on happiness', () => {
  const link = 'http://localhost:3000/r/abc';
  const msg = heuristicRequestMessage({ customer: { name: 'Rahul Verma' }, serviceName: 'Hair Spa', business, link, channel: 'whatsapp' });
  assert.ok(msg.includes(link));
  assert.doesNotMatch(msg, /if you (were|are) happy/i);
});

test('topics are neutral prompts', () => {
  const topics = heuristicTopics('Facial');
  assert.ok(topics.length >= 3);
  topics.forEach((t) => assert.ok(t.split(' ').length <= 6));
});

test('token encryption round-trips and is non-deterministic', () => {
  const a = encrypt('ya29.secret');
  const b = encrypt('ya29.secret');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'ya29.secret');
});

test('hours convert to and from Google format', () => {
  const hours = [
    { day: 'monday', open: '10:00', close: '20:30', closed: false },
    { day: 'tuesday', open: '10:00', close: '20:00', closed: true },
  ];
  const g = hoursToGoogle(hours);
  assert.equal(g.periods.length, 1);
  assert.deepEqual(g.periods[0].closeTime, { hours: 20, minutes: 30 });
  const back = hoursFromGoogle(g);
  assert.equal(back[0].close, '20:30');
  assert.equal(back[1].closed, true);
});

test('Google review mapping', () => {
  const r = fromGoogleReview({ name: 'accounts/1/locations/2/reviews/x', reviewId: 'x', starRating: 'FOUR', comment: 'Nice (Translated by Google) Bien', createTime: '2026-01-01T00:00:00Z', reviewer: { displayName: 'Amit' }, reviewReply: { comment: 'Thanks', updateTime: '2026-01-02T00:00:00Z' } });
  assert.equal(r.rating, 4);
  assert.equal(r.comment, 'Nice');
  assert.equal(r.reply.comment, 'Thanks');
  assert.equal(starToNumber('FIVE'), 5);
});

test('AI analysis remains available but reply generation requires Groq', async () => {
  const review = { rating: 5, comment: 'Loved the facial, staff were friendly', reviewer: { name: 'Neha' } };
  const analysis = await analyzeReview({ review, business, services: [{ name: 'Facial' }] });
  assert.equal(analysis.model, 'heuristic');
  await assert.rejects(generateReply({ review, analysis, business, services: [] }), /Groq could not generate a reply/);
});

test('service catalogue covers many business types', async () => {
  const { catalogFor, catalogKey } = await import('../src/modules/ai/catalog.js');
  assert.equal(catalogKey('Dental clinic'), 'dental');
  assert.equal(catalogKey('Unisex Salon'), 'salon');
  assert.equal(catalogKey('Car garage'), 'auto');
  assert.ok(catalogFor('Gym').length >= 10);
  assert.ok(catalogFor('Something unusual').length > 0);
});

test('service discovery falls back to the catalogue and skips existing services', async () => {
  const { discoverServices } = await import('../src/modules/ai/service.js');
  const res = await discoverServices({ business: { name: 'Fit', category: 'Gym' }, existing: [{ name: 'Yoga class' }] });
  assert.equal(res.model, 'catalog');
  assert.ok(!res.services.some((s) => s.name.toLowerCase() === 'yoga class'));
});

test('legacy customer template uses only the customer choices', async () => {
  const { heuristicCustomerReview } = await import('../src/modules/ai/heuristics.js');
  const text = heuristicCustomerReview({ rating: 3, services: ['Facial'], liked: ['Cleanliness'], disliked: ['Waiting time'], note: '' });
  assert.match(text, /facial/i);
  assert.match(text, /wait/i);
  assert.doesNotMatch(text, /amazing|best ever|highly recommend/i);
});

test('business slugs are URL-safe', async () => {
  const { Business } = await import('../src/models/Business.js');
  assert.equal(Business.slugify('Glow Studio & Spa, Noida!'), 'glow-studio-spa-noida');
  assert.equal(Business.slugify('Café Délice'), 'cafe-delice');
  assert.equal(Business.slugify('***'), 'business');
});

/* ---------------------------------------------------------------- autopilot */

const { photoSlots, postSlots } = await import('../src/modules/autopilot/slots.js');
const { effectiveHours, specialHoursToGoogle, holidayPlan } = await import('../src/modules/hours/service.js');
const { replyRuleFor } = await import('../src/modules/reviews/service.js');
const { validatePost, toGooglePost } = await import('../src/modules/posts/service.js');
const { zonedDate, weekStartYmd } = await import('../src/utils/time.js');

const week = (open = '10:00', close = '20:00') => ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => ({ day, open, close, closed: false }));

test('photo slots spread N photos over different days in IST', () => {
  const slots = photoSlots('2026-10-05', 4, 'Asia/Kolkata');
  assert.equal(slots.length, 4);
  assert.equal(new Set(slots.map((s) => s.ymd)).size, 4);
  assert.equal(slots[0].ymd, '2026-10-05');
  assert.equal(slots[0].at.toISOString(), '2026-10-05T05:00:00.000Z'); // 10:30 IST
  assert.equal(photoSlots('2026-10-05', 0, 'Asia/Kolkata').length, 0);
});

test('post slots start on the chosen day and time', () => {
  const [one] = postSlots('2026-10-05', { perWeek: 1, day: 'tuesday', time: '11:00' }, 'Asia/Kolkata');
  assert.equal(one.ymd, '2026-10-06');
  assert.equal(one.at.toISOString(), '2026-10-06T05:30:00.000Z');
  assert.equal(postSlots('2026-10-05', { perWeek: 3, day: 'monday', time: '09:00' }, 'Asia/Kolkata').length, 3);
});

test('week starts on Monday in the business timezone', () => {
  // 1 am IST on Monday is still Sunday in UTC
  assert.equal(weekStartYmd(zonedDate('2026-10-12', '01:00', 'Asia/Kolkata'), 'Asia/Kolkata'), '2026-10-12');
});

test('seasonal hours apply only inside their dates', () => {
  const b = { timezone: 'Asia/Kolkata', hours: week(), seasonalHours: [{ name: 'Winter', start: '2026-12-01', end: '2027-02-28', hours: week('11:00', '19:00') }] };
  assert.equal(effectiveHours(b, new Date('2026-10-07T06:00:00Z'))[0].open, '10:00');
  assert.equal(effectiveHours(b, new Date('2026-12-15T06:00:00Z'))[0].open, '11:00');
});

test('special hours go to Google from today on, closed days and late closes handled', () => {
  const b = { timezone: 'Asia/Kolkata', specialHours: [
    { date: '2026-01-26', closed: true },
    { date: '2026-11-08', closed: false, open: '10:00', close: '14:00' },
    { date: '2026-12-31', closed: false, open: '18:00', close: '01:00' },
  ] };
  const { specialHourPeriods: p } = specialHoursToGoogle(b, new Date('2026-10-07T06:00:00Z'));
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].openTime, { hours: 10, minutes: 0 });
  assert.deepEqual(p[1].endDate, { year: 2027, month: 1, day: 1 });
});

test('holiday plan marks which holidays already have hours', () => {
  const plan = holidayPlan({ timezone: 'Asia/Kolkata', specialHours: [{ date: '2026-11-08', closed: true }] }, { days: 40, date: new Date('2026-10-07T06:00:00Z') });
  const diwali = plan.find((h) => h.name === 'Diwali');
  assert.ok(diwali.set);
  assert.ok(plan.some((h) => h.name === 'Dussehra' && !h.set && h.daysAway === 13));
});

test('all reply ratings require business approval, including legacy auto rules', () => {
  const biz = { automation: { replyRules: { five: 'auto', four: 'auto', three: 'approve', low: 'approve' } } };
  assert.equal(replyRuleFor(biz, { rating: 5, analysis: { sentiment: 'positive', urgency: 'low' } }).rule, 'approve');
  assert.equal(replyRuleFor(biz, { rating: 3, analysis: { sentiment: 'neutral' } }).rule, 'approve');
  assert.equal(replyRuleFor(biz, { rating: 4, analysis: { sentiment: 'mixed' } }).rule, 'approve');
  assert.equal(replyRuleFor(biz, { rating: 5, analysis: { sentiment: 'positive', urgency: 'high' } }).rule, 'approve');
  assert.equal(replyRuleFor({ automation: { replyRules: { low: 'auto' } } }, { rating: 1, analysis: { urgency: 'low', sentiment: 'negative' } }).rule, 'approve');
});

const { profileAudit, verificationStatus } = await import('../src/modules/business/audit.js');
const { publicUrl, isPublicAddress } = await import('../src/modules/website/network.js');
const { analyzePage, buildWebsiteReport, crawlWebsite } = await import('../src/modules/website/audit.js');
const { mediaAudit, approvedMedia, supportedPhoto } = await import('../src/modules/photos/audit.js');
const { normalizePerformance, comparePeriods, activityWindows } = await import('../src/modules/performance/service.js');
const { locationAudit, pinDistance } = await import('../src/modules/business/location-audit.js');
const { externalEvidence, checkExternalSource } = await import('../src/modules/prominence/service.js');

test('performance metrics preserve reported zero and unavailable dates separately', () => {
  const series = normalizePerformance({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: { year: 2026, month: 10, day: 1 } }, { date: { year: 2026, month: 10, day: 3 }, value: '9' }] } }] }] });
  assert.deepEqual(series.WEBSITE_CLICKS, [{ date: '2026-10-01', value: 0 }, { date: '2026-10-03', value: 9 }]);
  const comparison = comparePeriods(series, { start: '2026-10-01', end: '2026-10-02' }, { start: '2026-10-03', end: '2026-10-04' });
  assert.equal(comparison.find((m) => m.metric === 'WEBSITE_CLICKS').change, null);
  assert.equal(comparison.find((m) => m.metric === 'CALL_CLICKS').before.value, null);
});

test('performance change is shown only for complete nonzero-baseline periods', () => {
  const series = { CALL_CLICKS: [{ date: '2026-10-01', value: 10 }, { date: '2026-10-02', value: 15 }] };
  const metric = comparePeriods(series, { start: '2026-10-01', end: '2026-10-01' }, { start: '2026-10-02', end: '2026-10-02' }).find((m) => m.metric === 'CALL_CLICKS');
  assert.equal(metric.change, 50);
});

test('performance requests use supported metrics and the selected Google location', async () => {
  const { getDailyPerformance } = await import('../src/modules/google/client.js');
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => { requested = new URL(url); return new Response(JSON.stringify({ multiDailyMetricTimeSeries: [] }), { headers: { 'content-type': 'application/json' } }); };
  try {
    await getDailyPerformance({ locationName: 'locations/123', expiresAt: new Date(Date.now() + 3600000), getAccessToken: () => 'isolated-test-token' }, ['WEBSITE_CLICKS', 'CALL_CLICKS'], '2026-09-01', '2026-09-30');
    assert.equal(requested.pathname, '/v1/locations/123:fetchMultiDailyMetricsTimeSeries');
    assert.deepEqual(requested.searchParams.getAll('dailyMetrics'), ['WEBSITE_CLICKS', 'CALL_CLICKS']);
    assert.equal(requested.searchParams.get('dailyRange.start_date.month'), '9');
    assert.equal(requested.searchParams.get('dailyRange.end_date.day'), '30');
  } finally { globalThis.fetch = original; }
});

test('location settings schema retains the actual operating type and pin', async () => {
  const { Business } = await import('../src/models/index.js');
  const b = new Business({ owner: '111111111111111111111111', name: 'ABC Salon', locationSettings: { type: 'storefront', pin: { latitude: 28.5, longitude: 77.3 } } });
  assert.equal(b.locationSettings.type, 'storefront');
  assert.equal(b.locationSettings.pin.latitude, 28.5);
  await b.validate();
});

test('activity windows exclude completion day and show whether after-period has elapsed', () => {
  const windows = activityWindows('2026-10-10T00:00:00Z', { timezone: 'Asia/Kolkata' }, 7, new Date('2026-10-13T06:00:00Z'));
  assert.deepEqual(windows.before, { start: '2026-10-03', end: '2026-10-09' });
  assert.deepEqual(windows.after, { start: '2026-10-11', end: '2026-10-17' });
  assert.equal(windows.elapsed, false);
});

test('location audit detects pin differences, duplicates and service-area configuration gaps', () => {
  const b = { address: { line1: '123 Main Road', city: 'Noida' }, serviceAreas: ['Noida'], locationSettings: { type: 'service_area', visitsCustomers: true, confirmedAt: new Date(), pin: { latitude: 28.5, longitude: 77.3 } } };
  const account = { mode: 'live', status: 'connected', locationName: 'locations/1', remote: { address: '123 Main Road', latlng: { latitude: 28.6, longitude: 77.3 }, serviceArea: { businessType: 'CUSTOMER_AND_BUSINESS_LOCATION' } }, locationInventory: [{ title: 'Salon', address: '123 Main Road', hours: [] }, { title: 'Salon', address: '123 Main Road', hours: [] }] };
  const result = locationAudit(b, account);
  assert.ok(result.findings.some((f) => f.title === 'Business type differs from Google'));
  assert.ok(result.findings.some((f) => f.title === 'Review address visibility'));
  assert.ok(result.findings.some((f) => f.title === 'Review possible duplicate profiles'));
  assert.ok(result.pinDistanceMetres > 100);
  assert.equal(pinDistance(null, account.remote.latlng), null);
});

test('location details remain unknown when the Google connection is not live', () => {
  const result = locationAudit({}, { mode: 'demo', status: 'connected', locationName: 'locations/demo', remote: { latlng: { latitude: 1, longitude: 2 } } });
  assert.equal(result.remote.latlng, null);
  assert.equal(result.connected, false);
});

test('external evidence distinguishes direct links from unrelated directory contact details', () => {
  const b = { name: 'ABC Salon', phone: '9311891503', links: { website: 'https://abcsalon.example' }, address: { city: 'Noida' } };
  const evidence = externalEvidence(pageResult('<head><title>Directory listing</title></head><body>ABC Salon <a href="https://abcsalon.example/book" rel="nofollow">Book</a><a href="tel:9999999999">Directory support</a></body>', 'https://directory.example/salon'), b);
  assert.equal(evidence.websiteLinks.length, 1);
  assert.equal(evidence.websiteLinks[0].rel, 'nofollow');
  assert.ok(!evidence.issues.some((issue) => issue.includes('phone number differs')));
  assert.equal(evidence.authority, 'Not measured');
  const internal = externalEvidence(pageResult('<body>ABC Salon<a href="/book">Book</a></body>', b.links.website), b);
  assert.equal(internal.websiteLinks.length, 0);
});

test('external source checks honor publisher robots exclusions', async () => {
  const fetcher = async (url, options = {}) => {
    if (options.beforeRequest) await options.beforeRequest(new URL(url));
    return pageResult('User-agent: *\nDisallow: /', url);
  };
  await assert.rejects(checkExternalSource('https://directory.example/salon', business, fetcher), /excludes automated/);
});

test('website network checks reject private, mapped, reserved and credentialed targets', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const target of ['http://127.0.0.1', 'http://[::1]', 'http://localhost', 'http://user:pass@example.com', 'ftp://example.com', 'https://example.com:8443']) assert.throws(() => publicUrl(target));
});

const pageResult = (html, url = 'https://salon.example/', status = 200) => ({ url, html, status, headers: { 'content-type': 'text/html' }, bytes: html.length, responseMs: 100 });

test('HTML audit reads JSON-LD, noindex, footer contacts and actual alt attributes', () => {
  const page = analyzePage(pageResult('<html><head><title>ABC Salon</title><meta name="robots" content="noindex"><script type="application/ld+json">{"@type":"BeautySalon","name":"ABC Salon"}</script></head><body><h1>Hair Coloring</h1><img src="a.jpg"><img src="b.jpg" alt=""><footer>ABC Salon Noida <a href="tel:+919311891503">Call</a></footer></body></html>'));
  assert.equal(page.noindex, true);
  assert.equal(page.missingAlt, 1);
  assert.equal(page.canonical, null);
  assert.equal(page.structured[0].name, 'ABC Salon');
  assert.deepEqual(page.phones, ['919311891503']);
  assert.match(page.text, /Noida/);
});

test('website report finds actual NAP inconsistencies and service-page gaps', () => {
  const page = analyzePage(pageResult('<html><head><title>ABC Beauty Studio</title><meta name="description" content="Hair services"></head><body><h1>Hair Coloring in Noida</h1><a href="tel:9799999999">Call</a><script type="application/ld+json">{"@type":"BeautySalon","name":"ABC Beauty Studio","address":{"streetAddress":"123 Main Street","addressLocality":"Noida"}}</script></body></html>', 'https://salon.example/hair-color'));
  const result = buildWebsiteReport({ url: 'https://salon.example/', pages: [page], robots: { status: 200 }, sitemap: { found: true }, business: { name: 'ABC Salon', phone: '9811111111', address: { line1: '123 Main Road', city: 'Delhi' } }, services: [{ name: 'Hair Coloring' }, { name: 'Facial' }] });
  assert.ok(result.findings.some((f) => f.code === 'name-mismatch'));
  assert.ok(result.findings.some((f) => f.code === 'phone-mismatch'));
  assert.ok(result.findings.some((f) => f.code === 'city-mismatch'));
  assert.ok(result.findings.some((f) => f.code === 'address-mismatch'));
  assert.equal(result.coverage[0].pages.length, 1);
  assert.equal(result.coverage[1].pages.length, 0);
  assert.match(result.limitations.join(' '), /not promises/);
});

test('website crawl respects robots, detects broken internal pages and bounds its sample', async () => {
  const visited = [];
  const fetcher = async (url, options = {}) => {
    const target = new URL(url);
    if (options.beforeRequest) await options.beforeRequest(target);
    visited.push(url);
    if (target.pathname === '/robots.txt') return pageResult('User-agent: *\nDisallow: /private', url);
    if (target.pathname === '/sitemap.xml') return pageResult('<urlset><url><loc>https://salon.example/facial</loc></url></urlset>', url);
    if (target.pathname === '/') return pageResult('<body><a href="/private">Private</a><a href="/broken">Broken</a><a href="https://external.example/">External</a></body>', url);
    if (target.pathname === '/broken') return pageResult('', url, 404);
    return pageResult('<body><h1>Facial</h1></body>', url);
  };
  const report = await crawlWebsite('https://salon.example/', { business: { name: 'ABC Salon' }, services: [{ name: 'Facial' }] }, { fetcher, maxPages: 4 });
  assert.equal(report.summary.broken, 1);
  assert.ok(report.findings.some((f) => f.title === 'Crawl excluded by robots.txt'));
  assert.ok(!visited.includes('https://salon.example/private'));
  assert.ok(!visited.some((url) => url.includes('external.example')));
  assert.ok(report.pages.length <= 4);
  assert.equal(report.sitemap.found, true);
});

test('media gap audit counts approved media without inventing views or service coverage', () => {
  const result = mediaAudit([
    { mediaType: 'photo', category: 'interior', approval: { status: 'approved' }, width: 300, height: 300, createdAt: new Date(), services: ['hair'] },
    { mediaType: 'video', category: 'team', approval: { status: 'pending' }, createdAt: new Date() },
  ], [{ _id: 'hair', name: 'Haircut' }, { _id: 'facial', name: 'Facial' }]);
  assert.equal(result.videos, 1);
  assert.equal(result.approved, 1);
  assert.ok(result.categoryGaps.includes('team'));
  assert.deepEqual(result.serviceGaps.map((s) => s.name), ['Facial']);
  assert.equal(result.lowResolution, 1);
  assert.equal(result.performanceAvailable, false);
});

test('pending photos and videos cannot enter the Google publishing path', async () => {
  const { pushPhoto } = await import('../src/modules/google/sync.js');
  const { postPhotoNow } = await import('../src/modules/photos/schedule.js');
  assert.equal(approvedMedia({}), false);
  assert.equal(supportedPhoto({ mimeType: 'video/mp4' }), false);
  for (const media of [{ approval: { status: 'pending' } }, { approval: { status: 'approved' }, mediaType: 'video' }]) {
    await assert.rejects(pushPhoto(business, media), /Only approved photos/);
    await assert.rejects(postPhotoNow(business, media), /Only approved photos/);
  }
});

test('profile audit does not treat disconnected snapshots as verified Google data', () => {
  const result = profileAudit(business, { account: { mode: 'demo', status: 'connected', locationName: 'locations/demo', remote: { verification: { hasVoiceOfMerchant: true } } } });
  assert.equal(result.connected, false);
  assert.equal(result.verification, 'not_connected');
  assert.equal(result.reputation.average, null);
  assert.equal(result.checks.find((c) => c.id === 'website').status, 'missing');
});

test('verification distinguishes authority, pending verification and confirmed merchant state', () => {
  assert.equal(verificationStatus({ verification: { hasBusinessAuthority: true } }), 'unknown');
  assert.equal(verificationStatus({ verification: { verify: { hasPendingVerification: true } } }), 'pending');
  assert.equal(verificationStatus({ verification: { hasVoiceOfMerchant: true } }), 'verified');
});

test('audit flags real mismatches and derives service gaps and recurring complaints from evidence', () => {
  const account = { mode: 'live', status: 'connected', locationName: 'locations/1', remote: { fetchedAt: new Date(), title: 'Old business name', phone: '9811024567', serviceNames: ['Facial'], verification: { hasVoiceOfMerchant: true }, attributes: [] } };
  const reviews = [
    { rating: 2, analysis: { services: ['Haircut'], negatives: ['Waiting time'], concerns: ['Waiting time'] } },
    { rating: 4, reply: { comment: 'Thanks' }, analysis: { services: ['Facial'], negatives: ['Waiting time'] } },
  ];
  const result = profileAudit(business, { account, services: [{ name: 'Haircut', description: 'Haircut service' }], reviews });
  assert.equal(result.checks.find((c) => c.id === 'name').status, 'mismatch');
  assert.equal(result.checks.find((c) => c.id === 'phone').status, 'complete');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.missingServices.map((s) => s.name), ['Facial']);
  assert.equal(result.reputation.average, 3);
  assert.equal(result.reputation.responseCoverage, 50);
  assert.deepEqual(result.reputation.complaints, [{ theme: 'Waiting time', count: 2 }]);
});

test('reply publishing rejects calls without business approval before reaching Google', async () => {
  const { publishReply } = await import('../src/modules/reviews/service.js');
  await assert.rejects(publishReply({ review: { source: 'google' }, business, text: 'Thank you' }), /Business approval/);
});

test('legacy scheduled replies are cleared without publishing', async () => {
  const { AiResponse } = await import('../src/models/index.js');
  const { publishDueReplies } = await import('../src/modules/reviews/service.js');
  const original = AiResponse.updateMany;
  let update;
  AiResponse.updateMany = async (filter, changes) => { update = { filter, changes }; };
  try {
    assert.equal(await publishDueReplies({ businessId: 'biz' }), 0);
    assert.equal(update.filter.business, 'biz');
    assert.deepEqual(update.changes, { $unset: { autoPublishAt: 1 } });
  } finally { AiResponse.updateMany = original; }
});

test('customer searches use the previous complete month, including year rollover', async () => {
  const { searchKeywordMonth } = await import('../src/modules/google/client.js');
  assert.deepEqual(searchKeywordMonth(new Date('2026-01-10T00:00:00Z')), { year: 2025, month: 12 });
});

test('Google search thresholds remain thresholds and only match listed services', () => {
  const result = profileAudit(business, { account: { mode: 'live', status: 'connected', locationName: 'locations/1', remote: { searchKeywords: [{ searchKeyword: 'haircut near me', insightsValue: { threshold: '15' } }, { searchKeyword: 'facial near me', insightsValue: { value: '50' } }] } }, services: [{ name: 'Haircut' }] });
  assert.equal(result.search.keywords[0].value, null);
  assert.equal(result.search.keywords[0].threshold, '15');
  assert.deepEqual(result.search.keywords[0].services, ['Haircut']);
  assert.deepEqual(result.search.keywords[1].services, []);
  assert.deepEqual(result.missingServices, []);
});

test('existing Google categories are recognized without requiring a new local selection', () => {
  const result = profileAudit(business, { account: { mode: 'live', status: 'connected', locationName: 'locations/1', remote: { categories: { primaryCategory: { name: 'categories/gcid:beauty_salon', displayName: 'Beauty salon' } } } } });
  assert.equal(result.checks.find((c) => c.id === 'primary').status, 'complete');
});

test('posts: phone numbers and missing offer details are rejected', () => {
  assert.match(validatePost({ summary: 'Call 98110 24567 today', action: 'NONE' }), /phone/);
  assert.equal(validatePost({ summary: 'Closed on 2026-10-20 for Dussehra', action: 'NONE' }), null);
  assert.match(validatePost({ type: 'OFFER', summary: 'Hair spa week', action: 'NONE' }), /title/);
  assert.match(validatePost({ summary: 'Book now', action: 'BOOK', actionUrl: '' }), /link/);
});

test('offers and events require real dates in chronological order', () => {
  const event = { type: 'EVENT', title: 'Salon event', summary: 'Meet the team', action: 'NONE', startDate: '2026-10-20' };
  assert.equal(validatePost(event), null);
  assert.match(validatePost({ ...event, startDate: '2026-02-30' }), /valid/);
  assert.match(validatePost({ ...event, endDate: '2026-10-19' }), /end date/);
});

test('offer posts carry an event schedule and offer details for Google', () => {
  const body = toGooglePost({ type: 'OFFER', summary: 'x', title: 'Spa week', startDate: '2026-10-15', endDate: '2026-10-25', couponCode: 'SPA10', action: 'CALL' }, null);
  assert.equal(body.topicType, 'OFFER');
  assert.deepEqual(body.event.schedule.endDate, { year: 2026, month: 10, day: 25 });
  assert.equal(body.offer.couponCode, 'SPA10');
  assert.deepEqual(body.callToAction, { actionType: 'CALL' });
});

/* ------------------------------------------------------------------ billing */

const { discountFor, listPrice, addMonths, accountState } = await import('../src/modules/billing/service.js');

test('billing: price, percent and flat discounts', () => {
  assert.equal(listPrice({ price: 1500 }, { price: 2499 }), 1500); // own price wins
  assert.equal(listPrice({}, { price: 2499 }), 2499);
  assert.equal(discountFor({ discountType: 'percent', discountValue: 10 }, 2499), 249.9);
  assert.equal(discountFor({ discountType: 'flat', discountValue: 5000 }, 2499), 2499); // never below zero
  assert.equal(discountFor({ discountType: 'none', discountValue: 50 }, 1000), 0);
});

test('billing: month periods handle short months', () => {
  assert.equal(addMonths(new Date(2027, 0, 31), 1).getDate(), 28);
  assert.equal(addMonths(new Date(2026, 9, 7), 12).getFullYear(), 2027);
});

test('billing: account state labels', () => {
  const future = new Date(Date.now() + 5 * 864e5);
  assert.equal(accountState({ account: { status: 'suspended' } }), 'suspended');
  assert.equal(accountState({ account: { trialEndsAt: future } }), 'trial');
  assert.equal(accountState({ account: { plan: 'x' } }, { openBalance: 100, overdue: true }), 'overdue');
  assert.equal(accountState({ account: { plan: 'x' } }, { openBalance: 100 }), 'due');
  assert.equal(accountState({ account: {} }), 'no_plan');
});

test('Google review link: Place IDs, placeholders and the fallback', async () => {
  const { normalizeReviewLink, usableReviewLink, googleReviewTarget } = await import('../src/utils/review-link.js');
  assert.equal(normalizeReviewLink(' ChIJN1t_tDeuEmsRUsoyG83frY4 '), 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.equal(normalizeReviewLink('g.page/r/CabcXYZ/review'), 'https://g.page/r/CabcXYZ/review');
  assert.equal(normalizeReviewLink('https://g.page/r/CabcXYZ/review'), 'https://g.page/r/CabcXYZ/review');
  assert.equal(normalizeReviewLink(''), '');
  assert.equal(usableReviewLink('https://search.google.com/local/writereview?placeid=DEMO_PLACE_ID'), '');
  assert.deepEqual(googleReviewTarget({ name: 'Glow', reviewLink: 'https://g.page/r/x/review' }), { url: 'https://g.page/r/x/review', exact: true });
  const fb = googleReviewTarget({ name: 'Glow Studio', address: { city: 'Noida' }, reviewLink: '' });
  assert.equal(fb.exact, false);
  assert.equal(fb.url, 'https://www.google.com/search?q=Glow%20Studio%20Noida%20reviews');
});

test('only a live connected Google location enables replies', async () => {
  const { isLiveConnection } = await import('../src/modules/reviews/policy.js');
  assert.equal(isLiveConnection(null), false);
  assert.equal(isLiveConnection({ mode: 'demo', status: 'connected', locationName: 'locations/demo' }), false);
  assert.equal(isLiveConnection({ mode: 'live', status: 'needs_location' }), false);
  assert.equal(isLiveConnection({ mode: 'live', status: 'error', locationName: 'locations/1' }), false);
  assert.equal(isLiveConnection({ mode: 'live', status: 'connected', locationName: 'locations/1' }), true);
});

test('demo imports are rejected before any database writes', async () => {
  const { ingestReviews } = await import('../src/modules/reviews/service.js');
  await assert.rejects(ingestReviews({ _id: 'business' }, [], { source: 'demo' }), /Only real Google reviews/);
});

test('generated reviews save Groq output separately with business ownership', async () => {
  const { GeneratedReview } = await import('../src/models/GeneratedReview.js');
  const { recordGeneratedReview } = await import('../src/modules/reviews/generated.js');
  const original = GeneratedReview.create;
  const writes = [];
  GeneratedReview.create = async (record) => { writes.push(record); return record; };
  try {
    const context = { business: { _id: 'business-1' }, body: { rating: 4, services: ['Facial'] }, source: 'qr' };
    await assert.rejects(recordGeneratedReview({ ...context, result: { text: 'Template', model: 'heuristic' } }), (err) => err.status === 503);
    await assert.rejects(recordGeneratedReview({ ...context, result: { text: '', model: 'groq:test' } }), (err) => err.status === 503);
    assert.equal(writes.length, 0);
    await recordGeneratedReview({ ...context, result: { text: 'My own experience.', model: 'groq:test' } });
    assert.deepEqual(writes, [{ business: 'business-1', reviewRequest: undefined, source: 'qr', text: 'My own experience.', model: 'groq:test', rating: 4, services: ['Facial'] }]);
  } finally {
    GeneratedReview.create = original;
  }
});

test('customer review drafts require Groq and never use a template silently', async () => {
  const { composeCustomerReview } = await import('../src/modules/ai/service.js');
  await assert.rejects(composeCustomerReview({ business, rating: 5, services: ['Facial'] }),
    (err) => err.status === 503 && /Groq could not generate a review draft/.test(err.message));
});

test('disconnected and demo accounts cannot draft or publish replies', async () => {
  const { GoogleAccount } = await import('../src/models/index.js');
  const { draftReply, publishReply } = await import('../src/modules/reviews/service.js');
  const original = GoogleAccount.findOne;
  const review = { source: 'google', googleReviewId: '1' };
  try {
    for (const account of [null, { mode: 'demo', status: 'connected', locationName: 'locations/demo' }]) {
      GoogleAccount.findOne = () => ({ select: async () => account });
      await assert.rejects(draftReply(review, business), (err) => err.status === 409);
      await assert.rejects(publishReply({ review, business, text: 'Thanks' }), (err) => err.status === 409);
    }
  } finally {
    GoogleAccount.findOne = original;
  }
});
