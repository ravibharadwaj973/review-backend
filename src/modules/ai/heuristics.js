/**
 * Deterministic fallbacks used when Groq is not configured or unreachable.
 * They keep every feature usable offline; output is marked model = "heuristic".
 */

const THEMES = [
  { key: 'Staff behaviour', words: ['staff', 'friendly', 'polite', 'rude', 'behaviour', 'behavior', 'team', 'stylist', 'receptionist', 'helpful', 'attitude', 'courteous', 'trainer', 'doctor', 'nurse'] },
  { key: 'Service quality', words: ['quality', 'great job', 'excellent', 'perfect', 'amazing', 'professional', 'skilled', 'results', 'result', 'best'] },
  { key: 'Cleanliness', words: ['clean', 'hygiene', 'hygienic', 'dirty', 'neat', 'tidy', 'sanitized', 'smell'] },
  { key: 'Waiting time', words: ['wait', 'waiting', 'waited', 'late', 'delay', 'delayed', 'queue', 'on time', 'punctual'] },
  { key: 'Pricing', words: ['price', 'pricing', 'expensive', 'cheap', 'overpriced', 'value', 'affordable', 'cost', 'costly', 'worth'] },
  { key: 'Appointment experience', words: ['appointment', 'booking', 'booked', 'slot', 'schedule', 'rescheduled'] },
  { key: 'Ambience', words: ['ambience', 'ambiance', 'atmosphere', 'music', 'decor', 'vibe', 'comfortable', 'relaxing', 'cozy'] },
  { key: 'Staff availability', words: ['understaffed', 'no one', 'nobody', 'unavailable', 'busy staff', 'short staffed'] },
];

const POSITIVE = ['great', 'good', 'excellent', 'amazing', 'love', 'loved', 'friendly', 'best', 'perfect', 'happy', 'nice', 'clean', 'professional', 'recommend', 'awesome', 'fantastic', 'wonderful', 'helpful', 'relaxing', 'satisfied', 'superb'];
const NEGATIVE = ['bad', 'poor', 'rude', 'dirty', 'worst', 'terrible', 'wait', 'waited', 'late', 'expensive', 'overpriced', 'disappointed', 'unprofessional', 'never', 'awful', 'horrible', 'delay', 'not happy', 'issue', 'problem', 'burnt', 'pain'];

const has = (text, w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);

export function heuristicAnalysis({ comment = '', rating }, serviceNames = []) {
  const text = comment.toLowerCase();
  const pos = POSITIVE.filter((w) => has(text, w)).length;
  const neg = NEGATIVE.filter((w) => has(text, w)).length;
  const services = serviceNames.filter((s) => text.includes(s.toLowerCase()));

  // Split into clauses so "great haircut but long wait" yields both a positive and a negative
  const clauses = text.split(/\bbut\b|\bhowever\b|\bthough\b|[.;!]/).map((c) => c.trim()).filter(Boolean);
  const positives = new Set();
  const negatives = new Set();
  for (const clause of clauses) {
    const cPos = POSITIVE.some((w) => has(clause, w));
    const cNeg = NEGATIVE.some((w) => has(clause, w));
    for (const theme of THEMES) {
      if (!theme.words.some((w) => has(clause, w))) continue;
      if (cNeg && !cPos) negatives.add(theme.key);
      else if (cPos && !cNeg) positives.add(theme.key);
      else if (rating >= 4) positives.add(theme.key);
      else if (rating <= 2) negatives.add(theme.key);
    }
    for (const s of services) {
      if (clause.includes(s.toLowerCase())) {
        if (cPos && !cNeg) positives.add(`${s} quality`);
        if (cNeg && !cPos) negatives.add(`${s} quality`);
      }
    }
  }

  let sentiment;
  if (rating >= 4 && negatives.size === 0) sentiment = 'positive';
  else if (rating <= 2) sentiment = 'negative';
  else if (positives.size && negatives.size) sentiment = 'mixed';
  else if (rating === 3) sentiment = negatives.size ? 'mixed' : 'neutral';
  else sentiment = pos >= neg ? 'positive' : 'mixed';

  const score = Math.max(-1, Math.min(1, (rating - 3) / 2 + (pos - neg) * 0.05));
  const concerns = [...negatives].map((n) => (n === 'Waiting time' ? 'Appointment delay' : n));
  const keywords = [...new Set([...services, ...POSITIVE.filter((w) => has(text, w)), ...NEGATIVE.filter((w) => has(text, w))])].slice(0, 8);

  return {
    sentiment,
    score: Number(score.toFixed(2)),
    services,
    positives: [...positives].slice(0, 5),
    negatives: [...negatives].slice(0, 5),
    concerns: concerns.slice(0, 4),
    keywords,
    urgency: rating <= 2 ? 'high' : negatives.size ? 'medium' : 'low',
    recommendation:
      rating <= 2
        ? 'Reply within 24 hours, acknowledge the issue specifically, and offer to resolve it offline.'
        : negatives.size
          ? 'Thank them, acknowledge the concern they raised, and mention what you are doing about it.'
          : 'Thank them warmly and reference what they enjoyed.',
    model: 'heuristic',
  };
}

function firstName(name = '') {
  const n = name.trim().split(/\s+/)[0] || '';
  if (!n || /google|user|anonymous/i.test(n)) return '';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function heuristicReply({ review, analysis, business }) {
  const name = firstName(review.reviewer?.name);
  const hi = name ? `Hi ${name}, thank you` : 'Thank you';
  const service = analysis?.services?.[0];
  const praise = analysis?.positives?.[0];
  const issue = analysis?.negatives?.[0];
  const sign = business.voice?.signOff ? `\n\n${business.voice.signOff}` : `\n\n— Team ${business.name}`;

  if (review.rating >= 4 && !issue) {
    const about = service ? `your ${service.toLowerCase()}` : praise ? praise.toLowerCase() : 'your visit';
    return `${hi} for the lovely review! We're so glad you enjoyed ${about} at ${business.name}. We look forward to seeing you again soon.${sign}`;
  }
  if (review.rating >= 3) {
    const good = service ? `your ${service.toLowerCase()}` : 'your experience with us';
    const bad = issue ? issue.toLowerCase() : 'some parts of your visit';
    return `${hi} for the honest feedback. We're happy you liked ${good}, and we're sorry about the ${bad}. We've shared this with our team so we can do better on your next visit.${sign}`;
  }
  const bad = issue ? `the ${issue.toLowerCase()}` : 'your experience';
  const contact = business.phone ? ` at ${business.phone}` : '';
  return `${hi} for telling us about this, and we're sorry about ${bad}. This isn't the experience we want for anyone at ${business.name}. Please reach out to us${contact} so we can understand what happened and make it right.${sign}`;
}

export function heuristicRequestMessage({ customer, serviceName, business, link, channel }) {
  const name = firstName(customer.name) || 'there';
  const svc = serviceName ? ` for your ${serviceName.toLowerCase()}` : '';
  const body = `Hi ${name}, thank you for visiting ${business.name}${svc}. We'd really value hearing about your experience — it takes less than a minute to leave a Google review: ${link}`;
  if (channel === 'email') return `${body}\n\nThank you,\n${business.name}`;
  return body;
}

const SERVICE_TOPIC_HINTS = [
  { match: /hair|cut|colou?r|spa|blow|keratin|style/i, topics: ['How your hair turned out', 'Your stylist'] },
  { match: /facial|skin|cleanup|peel/i, topics: ['How your skin felt after', 'Your therapist'] },
  { match: /mani|pedi|nail/i, topics: ['Nail finish and detail', 'Hygiene of tools'] },
  { match: /makeup|bridal/i, topics: ['How the look held up', 'The artist'] },
  { match: /massage|therapy|physio/i, topics: ['How relaxed you felt', 'Your therapist'] },
  { match: /train|gym|yoga|fitness|class/i, topics: ['Your trainer', 'Equipment and space'] },
  { match: /consult|check|dental|clinic|doctor/i, topics: ['How clearly things were explained', 'Waiting time'] },
  { match: /food|meal|dinner|lunch|thali|biryani|pizza/i, topics: ['Taste of the food', 'Portion size'] },
];

export function heuristicTopics(serviceName = '') {
  const hint = SERVICE_TOPIC_HINTS.find((h) => h.match.test(serviceName));
  const base = hint ? hint.topics : [`Your ${serviceName || 'service'} experience`];
  return [...base, 'Staff behaviour', 'Cleanliness', 'Overall experience'].slice(0, 5);
}

export function heuristicDescription({ business, services }) {
  const names = services.slice(0, 6).map((s) => s.name.toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || 'a range of services';
  const city = business.address?.city ? ` in ${business.address.city}` : '';
  return `${business.name} is a ${business.category.toLowerCase()}${city} offering ${list}. Our team focuses on careful, professional service in a clean and welcoming space. Book a visit or walk in during opening hours.`.slice(0, 750);
}

export function heuristicServiceDescription({ service, business }) {
  const dur = service.duration ? ` in about ${service.duration} minutes` : '';
  return `${service.name} at ${business.name}, done by our trained team${dur}.`;
}

export function heuristicInsights({ praised, criticized, totals }) {
  const items = [];
  if (criticized[0]) {
    items.push({
      observation: `"${criticized[0].topic}" comes up in ${criticized[0].count} critical review${criticized[0].count > 1 ? 's' : ''}.`,
      action: criticized[0].topic === 'Waiting time'
        ? 'Review appointment capacity at peak hours and send a delay message when running late.'
        : `Brief the team on ${criticized[0].topic.toLowerCase()} and track whether mentions drop next month.`,
      impact: 'high',
    });
  }
  if (praised[0]) {
    items.push({
      observation: `Customers most often praise "${praised[0].topic}" (${praised[0].count} mentions).`,
      action: 'Feature this strength in your Google description and photo captions.',
      impact: 'medium',
    });
  }
  if (totals.unanswered > 0) {
    items.push({
      observation: `${totals.unanswered} review${totals.unanswered > 1 ? 's are' : ' is'} still unanswered.`,
      action: 'Reply to every review, starting with the lowest ratings — response rate is visible to customers.',
      impact: totals.unanswered > 5 ? 'high' : 'medium',
    });
  }
  return items;
}


/** Rule-based review draft from the customer's own selections (used without Groq). */
const GOOD = {
  'staff behaviour': ['the staff were really friendly', 'the staff were nice and polite'],
  'service quality': ['the work was really good', 'they did a really good job'],
  cleanliness: ['the place was clean', 'everything was neat and clean'],
  'waiting time': ["I didn't have to wait long", 'they were on time'],
  'value for money': ['it was good value for money', 'the price was fair'],
  ambience: ['the place has a nice, calm feel', 'the place felt relaxing'],
  'overall experience': ['overall it was a good visit', 'overall I was happy'],
};
const BAD = {
  'staff behaviour': ['the staff could be a bit more friendly', 'the staff seemed a little rushed'],
  'service quality': ['the work could have been better', "the result wasn't what I hoped for"],
  cleanliness: ['the place could be cleaner', 'cleanliness needs some attention'],
  'waiting time': ['I had to wait longer than expected', 'the wait was quite long'],
  'value for money': ['it felt a bit expensive for what I got', 'the price felt a little high'],
  ambience: ['the place could feel more comfortable', 'it was a bit noisy'],
  'overall experience': ['overall it could have been better', 'overall it was just okay'],
};
const joinList = (arr) => (arr.length > 1 ? `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}` : arr[0] || '');
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const phrase = (map, topic, v, fallback) => {
  const key = topic.toLowerCase();
  return map[key] ? map[key][v % map[key].length] : fallback(key);
};

export function heuristicCustomerReview({ rating = 5, services = [], liked = [], disliked = [], note = '', staff = '', variant = 0 }) {
  const r = Math.min(5, Math.max(1, Math.round(rating)));
  const v = variant % 3;
  const svc = services.length ? `my ${joinList(services.map((x) => x.toLowerCase()))}` : 'my visit';
  const openers = {
    5: [`Really happy with ${svc} here.`, `Came in for ${svc.replace(/^my /, 'a ')} and loved it.`, `Very happy with ${svc}.`],
    4: [`Good experience with ${svc}.`, `Came in for ${svc.replace(/^my /, 'a ')} and it went well.`, `Pretty happy with ${svc}.`],
    3: [`${cap(svc)} was okay.`, `Came in for ${svc.replace(/^my /, 'a ')}. It was alright.`, `Mixed feelings about ${svc}.`],
    2: [`Not very happy with ${svc}.`, `${cap(svc)} wasn't great this time.`, `Expected more from ${svc}.`],
    1: [`Disappointed with ${svc}.`, `Bad experience with ${svc}.`, `${cap(svc)} did not go well, sadly.`],
  };
  const parts = [openers[r][v]];
  const noun = (x) => (/^your /.test(x) ? x.replace(/^your /, 'my ') : /^(my|the) /.test(x) ? x : `the ${x}`);
  const good = liked.map((t, k) => phrase(GOOD, t, v + k, (x) => `I liked ${noun(x)}`));
  const bad = disliked.map((t, k) => phrase(BAD, t, v + k, (x) => `${noun(x)} could be better`));
  if (good.length) parts.push(`${cap(joinList(good))}.`);
  if (staff) parts.push(r >= 4 ? [`${staff} took good care of me.`, `Thanks to ${staff}.`, `${staff} was really helpful.`][v] : `${staff} served me.`);
  if (bad.length) parts.push(`${good.length ? ['But ', 'Only thing is, ', 'One thing: '][v] : ''}${good.length ? joinList(bad) : cap(joinList(bad))}.`);
  if (note.trim()) parts.push(cap(note.trim()).replace(/([^.!?])$/, '$1.'));
  if (r >= 4 && !bad.length) parts.push(['Will come again.', 'Would recommend.', 'Will be back.'][v]);
  return parts.join(' ');
}


/** Simple post text when the AI is unavailable. */
export function heuristicPost({ business, services = [], theme, featured, instruction }) {
  const name = business.name;
  const list = services.slice(0, 3).map((s) => s.name.toLowerCase()).join(', ');
  const texts = {
    service: `Have you tried our ${String(featured?.name || 'services').toLowerCase()}? ${featured?.description || `It's one of the things people come back to ${name} for.`}\n\nDrop in or book your slot this week.`,
    tip: `A small tip from the ${name} team: a little care at home goes a long way between visits. Ask us what works best for you next time you're in.\n\nWe're happy to help — book your slot this week.`,
    reviews: `Thank you to everyone who left us a review. People keep mentioning ${(featured?.praised || ['our friendly team']).slice(0, 2).join(' and ').toLowerCase()}, and it means a lot to us.\n\nSee you again soon.`,
    team: `A quick hello from the team at ${name}. We love what we do, and we're here to make your visit easy and relaxed.\n\nCome say hi this week.`,
    faq: `${featured?.question || 'A question we hear a lot'}\n${featured?.answer || 'Ask us — we are happy to help.'}\n\nHave another question? Just ask us.`,
    festival: `Wishing you a happy ${featured?.name || 'festival'} from all of us at ${name}.${featured?.hoursNote ? ` On ${featured.name} we are ${featured.hoursNote}.` : ''}\n\nSee you soon.`,
    custom: instruction ? `${instruction}\n\nVisit ${name} this week.` : `Visit ${name} for ${list || 'our services'}. Book your slot this week.`,
  };
  // Offer / event titles are left for the owner unless it's a festival greeting
  const title = theme === 'festival' ? `Happy ${featured?.name || 'holidays'}`.slice(0, 58) : '';
  return { summary: (texts[theme] || texts.custom).slice(0, 1500), title };
}

/** Common questions for any local business. Answers come only from known data. */
export function heuristicQuestions({ business, services = [] }) {
  const open = (business.hours || []).filter((h) => !h.closed);
  const hoursText = open.length ? `We're open ${open.length === 7 ? 'every day' : `${open.length} days a week`}, usually ${open[0].open} to ${open[0].close}.` : '';
  const area = [business.address?.line1, business.address?.city].filter(Boolean).join(', ');
  return [
    { question: 'Do I need to book in advance?', answer: business.links?.booking ? 'Booking ahead is best so we can keep a slot for you. You can book online.' : '', needsInput: !business.links?.booking },
    { question: 'What are your opening hours?', answer: hoursText, needsInput: !hoursText },
    { question: 'What services do you offer?', answer: services.length ? `We offer ${services.slice(0, 6).map((s) => s.name.toLowerCase()).join(', ')}${services.length > 6 ? ' and more' : ''}.` : '', needsInput: !services.length },
    { question: 'Where are you located?', answer: area ? `You'll find us at ${area}.` : '', needsInput: !area },
    { question: 'Is parking available?', answer: '', needsInput: true },
    { question: 'Which payment methods do you accept?', answer: '', needsInput: true },
    { question: 'How long does a visit usually take?', answer: '', needsInput: true },
  ].map((q) => ({ ...q, fromReviews: false }));
}
