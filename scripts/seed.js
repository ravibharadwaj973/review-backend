/**
 * Seeds a complete demo workspace:
 *   email:    demo@starling.app
 *   password: starling123
 * Run: npm run seed            (uses fast built-in analysis)
 *      SEED_USE_AI=true npm run seed   (uses Groq for analysis — slower)
 */
if (process.env.SEED_USE_AI !== 'true') {
  process.env.GROQ_API_KEY = '';
  process.env.GROQ_URI = '';
}

const { connectDB, disconnectDB } = await import('../src/config/db.js');
const M = await import('../src/models/index.js');
const { demoReviews } = await import('../src/modules/google/demo.js');
const { ingestReviews, analyzeAndStore, draftReply } = await import('../src/modules/reviews/service.js');
const { randomToken } = await import('../src/utils/crypto.js');
const { heuristicRequestMessage, heuristicTopics } = await import('../src/modules/ai/heuristics.js');
const { env } = await import('../src/config/env.js');

const EMAIL = 'demo@starling.app';
const PASSWORD = 'starling123';

await connectDB();

const existing = await M.User.findOne({ email: EMAIL });
if (existing) {
  const b = await M.Business.findOne({ owner: existing._id });
  if (b) {
    await Promise.all(
      ['Service', 'Customer', 'GoogleAccount', 'Review', 'AiResponse', 'ReviewRequest', 'Photo', 'Location', 'Post', 'Question'].map((m) => M[m].deleteMany({ business: b._id }))
    );
    await b.deleteOne();
  }
  await existing.deleteOne();
  console.log('[seed] removed previous demo workspace');
}

const user = new M.User({ name: 'Aarti Malhotra', email: EMAIL });
await user.setPassword(PASSWORD);
await user.save();

const business = await M.Business.create({
  owner: user._id,
  name: 'Glow Studio',
  category: 'Beauty salon',
  description:
    'Glow Studio is a hair and beauty salon in Sector 18, Noida offering haircuts, hair colour, hair spa, facials, manicures and pedicures. Our stylists and therapists are trained in the latest techniques, and every tool is sanitised between clients.',
  phone: '+91 98110 24567',
  email: 'hello@glowstudio.in',
  address: { line1: 'Shop 14, Atta Market, Sector 18', city: 'Noida', state: 'Uttar Pradesh', postalCode: '201301', country: 'IN' },
  hours: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => ({ day, open: day === 'sunday' ? '11:00' : '10:00', close: '21:00', closed: day === 'tuesday' })),
  serviceAreas: ['Noida', 'Greater Noida', 'East Delhi'],
  links: { website: 'https://glowstudio.in', booking: 'https://glowstudio.in/book', whatsapp: 'https://wa.me/919811024567', instagram: 'https://instagram.com/glowstudio.noida' },
  policies: 'Appointments are held for 15 minutes. Please give 3 hours notice for cancellations.',
  staff: [{ name: 'Simran', role: 'Senior stylist' }, { name: 'Faiz', role: 'Colour specialist' }, { name: 'Leena', role: 'Skin therapist' }],
  voice: { tone: 'warm', signOff: '— Team Glow Studio', language: 'English' },
  reviewLink: 'https://search.google.com/local/writereview?placeid=DEMO_PLACE_ID',
  onboarding: { profile: true, services: true, google: true },
  qrStats: { opens: 86, composed: 41, clicks: 57, lastOpenAt: new Date() },
});
await business.ensureSlug();

const menu = [
  ['Hair', 'Haircut', 500, 45, 'Consultation, wash, precision cut and blow-dry.'],
  ['Hair', 'Hair Spa', 1200, 60, 'Deep-conditioning treatment with head and shoulder massage.'],
  ['Hair', 'Hair Colour', 2500, 120, 'Global colour with ammonia-free products.'],
  ['Hair', 'Keratin Treatment', 4500, 150, 'Smoothening treatment for frizz-free hair for up to 4 months.'],
  ['Skin', 'Cleanup', 700, 30, 'Cleansing, exfoliation and steam.'],
  ['Skin', 'Facial', 1000, 45, 'Classic facial tailored to your skin type.'],
  ['Skin', 'Premium Facial', 1800, 60, 'Hydrating facial with serum infusion.'],
  ['Hands & feet', 'Manicure', 600, 40, 'Shaping, cuticle care and polish.'],
  ['Hands & feet', 'Pedicure', 800, 50, 'Soak, scrub, massage and polish.'],
  ['Makeup', 'Party Makeup', 3000, 75, 'Long-wear makeup for evenings and events.'],
];
const services = await M.Service.insertMany(
  menu.map(([category, name, price, duration, description], i) => ({ business: business._id, category, name, price, duration, description, sortOrder: i, reviewTopics: heuristicTopics(name) }))
);

const location = await M.Location.create({ business: business._id, title: business.name, address: 'Sector 18, Noida', isPrimary: true, google: { accountName: 'accounts/demo', locationName: 'locations/demo' }, lastSyncedAt: new Date() });
await M.GoogleAccount.create({ business: business._id, mode: 'demo', email: 'demo@starling.local', status: 'connected', accountName: 'accounts/demo', locationName: 'locations/demo', locationTitle: business.name, lastSyncAt: new Date() });

// Reviews
const reviews = await ingestReviews(business, demoReviews(services.map((s) => s.name), { count: 64 }), { source: 'demo', locationId: location._id });
const plain = services.map((s) => s.toObject());
for (const r of reviews) await analyzeAndStore(r, business, plain);
const unanswered = reviews.filter((r) => r.status === 'unanswered').sort((a, b) => b.createTime - a.createTime);
const recentUnanswered = [...new Set([...unanswered.slice(0, 6), ...unanswered.filter((r) => r.rating <= 3)])];
for (const r of recentUnanswered) await draftReply(r, business);
// Mark historic replies as AI-published so AI metrics have history
for (const r of reviews.filter((x) => x.status === 'answered').slice(0, 14)) {
  await M.AiResponse.create({ business: business._id, review: r._id, text: r.reply.comment, finalText: r.reply.comment, status: 'published', model: 'heuristic', publishedAt: r.reply.updateTime, publishedTo: 'demo', approvedAt: r.reply.updateTime, approvedBy: user._id });
}

// Customers + visits
const people = [
  ['Priya Sharma', '9810011122'], ['Rahul Verma', '9810011123'], ['Ananya Gupta', '9810011124'], ['Amit Kumar', '9810011125'],
  ['Sneha Reddy', '9810011126'], ['Vikram Singh', '9810011127'], ['Neha Kapoor', '9810011128'], ['Arjun Mehta', '9810011129'],
  ['Kavya Nair', '9810011130'], ['Rohan Joshi', '9810011131'], ['Isha Malhotra', '9810011132'], ['Karan Bhatia', '9810011133'],
  ['Pooja Iyer', '9810011134'], ['Aditya Rao', '9810011135'], ['Meera Pillai', '9810011136'], ['Tanvi Desai', '9810011137'],
  ['Simran Kaur', '9810011138'], ['Dev Patel', '9810011139'], ['Ritika Bose', '9810011140'], ['Yash Thakur', '9810011141'],
  ['Zoya Hussain', '9810011142'], ['Naveen Gowda', '9810011143'], ['Anjali Menon', '9810011144'], ['Farhan Ali', '9810011145'],
];
const customers = [];
for (let i = 0; i < people.length; i += 1) {
  const [name, phone] = people[i];
  const nVisits = 1 + (i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : i % 2);
  const visits = [];
  for (let v = 0; v < nVisits; v += 1) {
    const svc = services[(i * 3 + v * 5) % services.length];
    visits.push({ service: svc._id, serviceName: svc.name, date: new Date(Date.now() - (v === nVisits - 1 && i >= 14 ? (i - 14) * 0.6 * 864e5 + 5 * 3600e3 : (((i * 2 + v * 23) % 120) + 2) * 864e5)), amount: svc.price });
  }
  visits.sort((a, b) => a.date - b.date);
  customers.push(await M.Customer.create({ business: business._id, name, phone, email: `${name.split(' ')[0].toLowerCase()}@example.com`, visits }));
}

// Review requests across the funnel
const statuses = ['reviewed', 'reviewed', 'clicked', 'sent', 'sent', 'reviewed', 'clicked', 'sent', 'reviewed', 'draft', 'sent', 'clicked', 'reviewed', 'sent'];
for (let i = 0; i < statuses.length; i += 1) {
  const c = customers[i];
  const visit = c.visits.at(-1);
  const token = randomToken(9);
  const status = statuses[i];
  const sentAt = new Date(visit.date.getTime() + 3 * 3600e3);
  await M.ReviewRequest.create({
    createdAt: status === 'draft' ? new Date() : sentAt,
    business: business._id,
    customer: c._id,
    service: visit.service,
    serviceName: visit.serviceName,
    visitDate: visit.date,
    channel: i % 5 === 0 ? 'sms' : i % 7 === 0 ? 'email' : 'whatsapp',
    message: heuristicRequestMessage({ customer: c, serviceName: visit.serviceName, business, link: `${env.appUrl}/r/${token}`, channel: 'whatsapp' }),
    model: 'heuristic',
    token,
    topics: heuristicTopics(visit.serviceName),
    status,
    sentAt: status === 'draft' ? undefined : sentAt,
    openedAt: ['clicked', 'reviewed'].includes(status) ? new Date(sentAt.getTime() + 1800e3) : undefined,
    clickedAt: ['clicked', 'reviewed'].includes(status) ? new Date(sentAt.getTime() + 2000e3) : undefined,
    clicks: ['clicked', 'reviewed'].includes(status) ? 1 : 0,
    reviewedAt: status === 'reviewed' ? new Date(sentAt.getTime() + 86400e3) : undefined,
    attribution: status === 'reviewed' ? 'name_match' : undefined,
  });
  await M.Customer.updateOne({ _id: c._id }, { reviewStatus: status === 'draft' ? 'none' : status === 'sent' ? 'requested' : status, lastRequestedAt: status === 'draft' ? undefined : sentAt });
}

console.log('\n[seed] Demo workspace ready');
console.log(`        Sign in at ${env.appUrl}/login`);
console.log(`        email:    ${EMAIL}`);
console.log(`        password: ${PASSWORD}`);
console.log(`        ${reviews.length} reviews, ${services.length} services, ${customers.length} customers\n`);
await disconnectDB();
process.exit(0);
