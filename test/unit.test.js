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

test('AI service falls back gracefully without a Groq key', async () => {
  const review = { rating: 5, comment: 'Loved the facial, staff were friendly', reviewer: { name: 'Neha' } };
  const analysis = await analyzeReview({ review, business, services: [{ name: 'Facial' }] });
  assert.equal(analysis.model, 'heuristic');
  const reply = await generateReply({ review, analysis, business, services: [] });
  assert.equal(reply.model, 'heuristic');
  assert.match(reply.text, /facial/i);
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

test('customer review draft uses only their choices and stays honest', async () => {
  const { composeCustomerReview } = await import('../src/modules/ai/service.js');
  const { text } = await composeCustomerReview({ business, rating: 3, services: ['Facial'], liked: ['Cleanliness'], disliked: ['Waiting time'], note: '' });
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

test('reply rules: auto for happy reviews, held when urgent or mismatched', () => {
  const biz = { automation: { replyRules: { five: 'auto', four: 'auto', three: 'approve', low: 'approve' } } };
  assert.equal(replyRuleFor(biz, { rating: 5, analysis: { sentiment: 'positive', urgency: 'low' } }).rule, 'auto');
  assert.equal(replyRuleFor(biz, { rating: 3, analysis: { sentiment: 'neutral' } }).rule, 'approve');
  assert.equal(replyRuleFor(biz, { rating: 4, analysis: { sentiment: 'mixed' } }).rule, 'approve');
  assert.equal(replyRuleFor(biz, { rating: 5, analysis: { sentiment: 'positive', urgency: 'high' } }).rule, 'approve');
  assert.equal(replyRuleFor({ automation: { replyRules: { low: 'auto' } } }, { rating: 1, analysis: { urgency: 'low', sentiment: 'negative' } }).rule, 'auto');
});

test('posts: phone numbers and missing offer details are rejected', () => {
  assert.match(validatePost({ summary: 'Call 98110 24567 today', action: 'NONE' }), /phone/);
  assert.equal(validatePost({ summary: 'Closed on 2026-10-20 for Dussehra', action: 'NONE' }), null);
  assert.match(validatePost({ type: 'OFFER', summary: 'Hair spa week', action: 'NONE' }), /title/);
  assert.match(validatePost({ summary: 'Book now', action: 'BOOK', actionUrl: '' }), /link/);
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
