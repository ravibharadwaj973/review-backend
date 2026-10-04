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
