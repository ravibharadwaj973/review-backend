import { chat, chatJSON } from './groq.js';
import * as H from './heuristics.js';
import { AiUnavailableError } from './groq.js';
import { HttpError } from '../../utils/http.js';
import { catalogFor } from './catalog.js';

let warnedMissingKey = false;
function logFallback(what, err) {
  if (err instanceof AiUnavailableError && /not set/.test(err.message)) {
    if (!warnedMissingKey) console.warn('[ai] GROQ_API_KEY not set — using built-in fallback writer');
    warnedMissingKey = true;
    return;
  }
  console.warn(`[ai] ${what} fallback:`, err.message);
}

const TONES = {
  warm: 'warm, personal and friendly, like a caring owner',
  professional: 'polite, professional and composed',
  playful: 'upbeat and light-hearted, with a touch of personality but never flippant about complaints',
  concise: 'short and to the point — two sentences maximum',
};

function businessContext(business, services = [], faqs = []) {
  const known = (faqs || []).filter((f) => f.answer?.trim()).slice(0, 15);
  const svc = services.length
    ? services.map((s) => `- ${s.name}${s.category ? ` (${s.category})` : ''}${s.price != null ? `, ₹${s.price}` : ''}`).join('\n')
    : '- (no services listed)';
  return [
    `Business: ${business.name}`,
    `Category: ${business.category}`,
    business.address?.city ? `City: ${business.address.city}` : null,
    business.phone ? `Phone: ${business.phone}` : null,
    business.description ? `About: ${business.description}` : null,
    `Services:\n${svc}`,
    known.length ? `Facts from the owner (questions customers ask):\n${known.map((f) => `- Q: ${f.question} A: ${f.answer}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

const SAFETY = `Rules you must always follow:
- Never invent facts, offers, discounts, refunds or policies that are not in the business context.
- Never reveal or ask for private customer data. Do not mention medical details from the review.
- Never argue with, blame, or shame the reviewer.
- Write as the business, in first person plural ("we").`;

/** One writing style for everything the AI writes: plain, human, simple English. */
export const HUMAN_STYLE = `Writing style (very important):
- Write like a real person talking, not like a company or a robot.
- Use simple, everyday English that a 12-year-old understands. Short sentences. Common words.
- Be specific: mention the actual service or detail instead of general praise.
- No fancy or corporate words: never use "delighted", "esteemed", "valued customer", "we apologize for any inconvenience",
  "rest assured", "commitment to excellence", "elevate", "seamless", "top-notch", "hassle-free", "experience was a delight".
- No emojis, no hashtags, no exclamation marks in every sentence (one at most).
- Contractions are good (we're, it's, didn't).`;

const clampList = (v, n = 5) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, n) : []);

/** Structured analysis of a single review. */
export async function analyzeReview({ review, business, services }) {
  const serviceNames = services.map((s) => s.name);
  if (!review.comment?.trim()) {
    const fallback = H.heuristicAnalysis(review, serviceNames);
    return { ...fallback, analyzedAt: new Date() };
  }
  try {
    const { data, model } = await chatJSON({
      fast: false,
      temperature: 0.1,
      maxTokens: 500,
      system: `You analyse Google reviews for a local business and return strict JSON.
Schema:
{"sentiment":"positive|neutral|negative|mixed","score":number between -1 and 1,
 "services":[service names from the provided list that the review mentions],
 "positives":[short themes praised, 2-4 words each],"negatives":[short themes criticised, 2-4 words each],
 "concerns":[specific operational issues, e.g. "Appointment delay"],"keywords":[up to 8 notable words],
 "urgency":"low|medium|high","recommendation":"one sentence on how the business should respond"}
Use consistent theme names such as: Staff behaviour, Service quality, Cleanliness, Waiting time, Pricing, Appointment experience, Ambience, Staff availability, Results, Communication.`,
      user: `${businessContext(business, services)}\n\nReview (${review.rating}/5 stars):\n"""${review.comment}"""`,
    });
    const sentiment = ['positive', 'neutral', 'negative', 'mixed'].includes(data.sentiment) ? data.sentiment : H.heuristicAnalysis(review, serviceNames).sentiment;
    return {
      sentiment,
      score: typeof data.score === 'number' ? Math.max(-1, Math.min(1, data.score)) : undefined,
      services: clampList(data.services).filter((s) => serviceNames.some((n) => n.toLowerCase() === s.toLowerCase())),
      positives: clampList(data.positives),
      negatives: clampList(data.negatives),
      concerns: clampList(data.concerns, 4),
      keywords: clampList(data.keywords, 8),
      urgency: ['low', 'medium', 'high'].includes(data.urgency) ? data.urgency : review.rating <= 2 ? 'high' : 'low',
      recommendation: typeof data.recommendation === 'string' ? data.recommendation.slice(0, 300) : '',
      model,
      analyzedAt: new Date(),
    };
  } catch (err) {
    logFallback('analyze', err);
    return { ...H.heuristicAnalysis(review, serviceNames), analyzedAt: new Date() };
  }
}

/** Draft a reply to a review in the business's voice. */
export async function generateReply({ review, analysis, business, services, previousReplies = [], tone, instruction, faqs = [] }) {
  const voice = tone || business.voice?.tone || 'warm';
  try {
    const examples = previousReplies.filter(Boolean).slice(0, 3);
    const { text, model } = await chat({
      temperature: 0.7,
      maxTokens: 350,
      system: `You write replies to Google reviews on behalf of a local business.
Tone: ${TONES[voice] || TONES.warm}. Language: ${business.voice?.language || 'English'}.
Length: 2–4 sentences (under 90 words). Mention the specific service or detail the customer referred to.
For criticism: acknowledge the specific issue, apologise sincerely without making excuses, and invite them to get in touch${business.phone ? ` (phone: ${business.phone})` : ''}.
Use the reviewer's first name only if it looks like a real first name.
${business.voice?.signOff ? `End with this sign-off on its own line: ${business.voice.signOff}` : 'Do not add a signature.'}
${business.voice?.avoid ? `Avoid: ${business.voice.avoid}` : ''}
${HUMAN_STYLE}
${SAFETY}
Return only the reply text — no quotes, no preamble.`,
      user: `${businessContext(business, services, faqs)}

${examples.length ? `Previous replies from this business (match the style, do not copy):\n${examples.map((e) => `- ${e}`).join('\n')}\n\n` : ''}Review by ${review.reviewer?.name || 'a customer'} — ${review.rating}/5 stars:
"""${review.comment || '(rating only, no text)'}"""
${analysis ? `Analysis: sentiment=${analysis.sentiment}; praised=${(analysis.positives || []).join(', ') || 'none'}; criticised=${(analysis.negatives || []).join(', ') || 'none'}` : ''}
${instruction ? `Owner's instruction for this reply: ${instruction}` : ''}`,
    });
    const clean = text.replace(/^["'“]|["'”]$/g, '').trim();
    if (!clean) throw new Error('empty reply');
    return { text: clean.slice(0, 4000), model, tone: voice };
  } catch (err) {
    throw new HttpError(503, 'Groq could not generate a reply. Check the AI configuration and try again.');
  }
}

/** Personalised review-request message. Never conditions the ask on the customer being happy. */
export async function generateRequestMessage({ customer, serviceName, visitDate, business, link, channel }) {
  const lengths = { whatsapp: 'under 60 words, friendly', sms: 'under 300 characters total including the link', email: 'a short email body (3–5 sentences) with a greeting and sign-off', copy: 'under 60 words' };
  try {
    const { text, model } = await chat({
      temperature: 0.8,
      maxTokens: 250,
      system: `You write review-request messages that a local business sends to a customer after a visit.
Rules:
- Ask for honest feedback. Never ask only happy customers to review, never offer incentives, never suggest what rating to give.
- Never write review text for the customer.
- Mention the service they had, if given. Use their first name.
- Include this exact link once, on its own or at the end: ${link}
- Length: ${lengths[channel] || lengths.copy}. Tone: ${TONES[business.voice?.tone] || TONES.warm}. Language: ${business.voice?.language || 'English'}.
${HUMAN_STYLE}
Return only the message text.`,
      user: `Business: ${business.name} (${business.category})
Customer: ${customer.name}
Service: ${serviceName || 'not specified'}
Visit date: ${visitDate ? new Date(visitDate).toDateString() : 'recent'}`,
    });
    let msg = text.replace(/^["'“]|["'”]$/g, '').trim();
    if (!msg.includes(link)) msg = `${msg}\n${link}`;
    return { text: msg, model };
  } catch (err) {
    logFallback('request', err);
    return { text: H.heuristicRequestMessage({ customer, serviceName, business, link, channel }), model: 'heuristic' };
  }
}

/** Optional topics a customer could mention. These are prompts, never review content. */
export async function suggestTopics({ serviceName, business }) {
  try {
    const { data } = await chatJSON({
      fast: true,
      temperature: 0.4,
      maxTokens: 150,
      system: 'Return JSON {"topics":[...]} with 4-5 short neutral topics (2-5 words) a customer might choose to mention in a review of the given service. Topics must be neutral (e.g. "Waiting time", not "Short waiting time"). Never write review sentences.',
      user: `Business type: ${business.category}. Service: ${serviceName || 'general visit'}`,
    });
    const topics = clampList(data.topics, 5);
    return topics.length ? topics : H.heuristicTopics(serviceName);
  } catch {
    return H.heuristicTopics(serviceName);
  }
}

/** AI content assistant for profile content. kind: description | service | caption | faq | promo */
export async function generateContent({ kind, business, services, target, instruction }) {
  const ctx = businessContext(business, services);
  const prompts = {
    description: {
      system: `Write a Google Business Profile description (max 700 characters). Plain, factual, specific to the services listed. No URLs, no phone numbers, no prices, no ALL CAPS, no superlatives like "best in town". ${SAFETY}`,
      user: `${ctx}\n${instruction ? `Owner's note: ${instruction}` : ''}`,
      fallback: () => H.heuristicDescription({ business, services }),
      max: 750,
    },
    service: {
      system: `Write a one or two sentence description (max 250 characters) of a single service for a business menu. Factual, no invented claims or prices. ${SAFETY}`,
      user: `${ctx}\n\nService to describe: ${target?.name} (${target?.category || ''}${target?.duration ? `, ${target.duration} min` : ''})`,
      fallback: () => H.heuristicServiceDescription({ service: target || {}, business }),
      max: 300,
    },
    caption: {
      system: 'Write one short, natural caption (max 120 characters) for a business photo. No hashtags, no emojis.',
      user: `${ctx}\n\nPhoto category: ${target?.category}. File name: ${target?.fileName || ''}. ${instruction || ''}`,
      fallback: () => `${business.name} — ${String(target?.category || 'photo').replace('_', ' ')}`,
      max: 150,
    },
    faq: {
      system: `Write 5 short FAQ entries a customer might ask this business, answered only from the context. If the context does not contain the answer, write a neutral answer telling them to call or message. Format each as "Q: ...\\nA: ..." separated by blank lines. ${SAFETY}`,
      user: ctx,
      fallback: () => `Q: Do I need an appointment?\nA: Walk-ins are welcome, but booking ahead guarantees your slot.\n\nQ: What services do you offer?\nA: ${services.map((s) => s.name).join(', ') || 'Please call us for the full list.'}`,
      max: 2000,
    },
    promo: {
      system: `Write a short promotional post (under 60 words) for a Google Business Profile update. No invented discounts. ${SAFETY}`,
      user: `${ctx}\n${instruction ? `Focus: ${instruction}` : ''}`,
      fallback: () => `Visit ${business.name} for ${services.slice(0, 3).map((s) => s.name.toLowerCase()).join(', ') || 'our services'}. Book your slot today.`,
      max: 1500,
    },
  };
  const p = prompts[kind];
  if (!p) throw new Error(`Unknown content kind: ${kind}`);
  try {
    const { text, model } = await chat({ system: `${p.system}\n${HUMAN_STYLE}`, user: p.user, temperature: 0.7, maxTokens: 500 });
    return { text: text.replace(/^["'“]|["'”]$/g, '').trim().slice(0, p.max), model };
  } catch (err) {
    logFallback('content', err);
    return { text: p.fallback().slice(0, p.max), model: 'heuristic' };
  }
}

/** Turns aggregated review themes into business actions. */
export async function generateInsights({ business, praised, criticized, totals, byService }) {
  try {
    const { data, model } = await chatJSON({
      temperature: 0.4,
      maxTokens: 700,
      system: `You are an operations advisor for a local business. From aggregated review data, produce 3-4 insights as JSON:
{"insights":[{"observation":"what the data shows, citing numbers","action":"one concrete thing the owner can do this month","impact":"high|medium|low"}]}
Only use the numbers given. Be specific and practical.`,
      user: `${business.name} (${business.category})
Totals: ${JSON.stringify(totals)}
Most praised: ${JSON.stringify(praised.slice(0, 6))}
Most criticised: ${JSON.stringify(criticized.slice(0, 6))}
Ratings by service: ${JSON.stringify(byService.slice(0, 8))}`,
    });
    const insights = Array.isArray(data.insights) ? data.insights.slice(0, 4) : [];
    if (!insights.length) throw new Error('no insights');
    return { insights, model };
  } catch {
    return { insights: H.heuristicInsights({ praised, criticized, totals }), model: 'heuristic' };
  }
}


/* ------------------------------------------------------------------------- */
/* Service discovery                                                          */
/* ------------------------------------------------------------------------- */

const norm = (x = '') => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cleanServices(list, existing = []) {
  const seen = new Set(existing.map((e) => norm(e.name)));
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw?.name || '').trim().slice(0, 140);
    if (!name || seen.has(norm(name))) continue;
    seen.add(norm(name));
    const price = Number(raw.price);
    const duration = Number(raw.duration);
    out.push({
      name,
      category: String(raw.category || 'General').trim().slice(0, 60) || 'General',
      price: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
      description: String(raw.description || '').trim().slice(0, 300),
    });
  }
  return out;
}

/**
 * Suggests the full list of services a business is likely to offer.
 * source 'ai'      — from business type, description and city
 * source 'website' — extracted from the text of the business's own website
 */
export async function discoverServices({ business, existing = [], source = 'ai', websiteText = '' }) {
  if (source === 'website') {
    const { data, model } = await chatJSON({
      temperature: 0.1,
      maxTokens: 2500,
      system: `You extract the services (or menu items/packages) a local business offers from the text of its website.
Return JSON {"services":[{"name":"...","category":"group like Hair, Skin, Classes","price":number or null,"duration":minutes or null,"description":"one short simple sentence or empty"}]}.
Only include services that actually appear in the text. Prices in INR as plain numbers (no symbols). Keep names short and clear (e.g. "Hair spa", not "Our signature hair spa experience"). Up to 60 items.`,
      user: `Business: ${business.name} (${business.category})\n\nWebsite text:\n"""${websiteText.slice(0, 14000)}"""`,
    });
    return { services: cleanServices(data.services, existing), model, source };
  }

  const fallback = () => ({ services: cleanServices(catalogFor(business.category), existing), model: 'catalog', source });
  try {
    const { data, model } = await chatJSON({
      temperature: 0.3,
      maxTokens: 2500,
      system: `You help a local business in India list every service it offers.
Return JSON {"services":[{"name":"...","category":"group","price":typical starting price in INR as a number or null,"duration":typical minutes or null,"description":"one short, simple sentence"}]}.
Give a complete, realistic list for this type of business: 20 to 40 services, grouped into sensible categories.
Use the names customers actually say (e.g. "Haircut", "Hair spa", "Root canal", "Monthly membership").
Prices should be typical for the city if given. Descriptions in plain simple English.`,
      user: `Business: ${business.name}
Type: ${business.category}
${business.address?.city ? `City: ${business.address.city}` : ''}
${business.description ? `About: ${business.description}` : ''}
Already listed (do not repeat): ${existing.map((e) => e.name).join(', ') || 'none'}`,
    });
    const services = cleanServices(data.services, existing);
    if (!services.length) return fallback();
    return { services, model, source };
  } catch (err) {
    logFallback('discover', err);
    return fallback();
  }
}

/* ------------------------------------------------------------------------- */
/* Review writing helper for customers                                        */
/* ------------------------------------------------------------------------- */

/**
 * Turns the customer's OWN choices (rating, services taken, what they liked or not,
 * optional note) into a short review draft in simple human English. The customer edits
 * it, copies it, and posts it on Google themselves. Nothing is invented.
 */
export async function composeCustomerReview({ business, rating, services = [], liked = [], disliked = [], note = '', staff = '', length = 'short', variant = 0 }) {
  const lengthRule = length === 'detailed' ? '4 to 6 sentences' : '2 to 3 sentences';
  try {
    const { text, model } = await chat({
      temperature: 0.9,
      maxTokens: 300,
      system: `You help a customer put THEIR OWN experience into words for a Google review. You write as the customer, in first person ("I").
Strict rules:
- Use ONLY the facts the customer gave you (rating, services, liked, could be better, their note, staff name). Do not add any detail, number, feeling or claim they did not give.
- Match the star rating honestly. If they chose things that could be better, include them plainly and politely. Never make it more positive than their choices.
- Do not mention discounts, being asked to review, or AI.
- Length: ${lengthRule}.
${HUMAN_STYLE}
- It should read like a normal person typed it on their phone. Vary sentence starts. Don't start with "I recently visited".
Return only the review text.`,
      user: `Business: ${business.name} (${business.category})
Star rating the customer chose: ${rating}/5
Services they took: ${services.join(', ') || 'not specified'}
What they liked: ${liked.join(', ') || 'nothing specific'}
What could be better: ${disliked.join(', ') || 'nothing'}
${staff ? `Staff who served them: ${staff}` : ''}
Their own words (most important — keep their meaning): ${note || '(none)'}
Write version #${variant + 1}${variant ? ' — make it clearly different in wording from a typical version' : ''}.`,
    });
    const clean = text.replace(/^["'“]|["'”]$/g, '').trim();
    if (!clean) throw new Error('empty');
    return { text: clean.slice(0, 1500), model };
  } catch (err) {
    throw new HttpError(503, 'Groq could not generate a review draft. Please try again or write your own review.');
  }
}


/* ------------------------------------------------------------------------- */
/* Google posts                                                               */
/* ------------------------------------------------------------------------- */

const THEME_BRIEF = {
  service: (f) => `Spotlight one service: "${f?.name}"${f?.description ? ` (${f.description})` : ''}${f?.price ? `, from ₹${f.price}` : ''}. Say what it is, who it's for and how it feels. Use the price only if given.`,
  tip: (f) => `Share one genuinely useful, practical tip related to ${f?.name ? `"${f.name}"` : 'the services'} that a customer can use at home. Then one line on how the business can help.`,
  reviews: (f) => `Thank customers in general for their reviews and share what they say they like most: ${(f?.praised || []).join(', ') || 'friendly service'}. Do not quote anyone or use names. Do not invent ratings.`,
  team: () => 'A warm "behind the scenes" post about the team and the place, based only on the business context.',
  faq: (f) => `Answer a question customers often ask. Question: "${f?.question}". Answer (use only this): "${f?.answer}". Start with the question.`,
  festival: (f) => `A short greeting for ${f?.name} (${f?.date}).${f?.hoursNote ? ` Clearly mention the hours for that day: ${f.hoursNote}.` : ''} Keep it warm and inclusive.`,
  custom: (f) => f?.instruction || 'A short update that makes people want to visit.',
};

const POST_RULES = `Rules for Google posts:
- 40 to 110 words. Plain text. One or two short paragraphs. No hashtags, no emojis, no ALL CAPS.
- Never include phone numbers or links in the text (Google rejects them) — the button handles that.
- Never invent offers, discounts, prices, awards or claims that aren't in the business context.
- End with a simple, natural nudge (e.g. "Book your slot this week.").`;

export async function generatePost({ business, services = [], faqs = [], theme = 'custom', featured, type = 'STANDARD', instruction }) {
  const brief = (THEME_BRIEF[theme] || THEME_BRIEF.custom)({ ...(featured || {}), instruction });
  const needsTitle = type === 'OFFER' || type === 'EVENT';
  try {
    const { data, model } = await chatJSON({
      temperature: 0.8,
      maxTokens: 500,
      system: `You write Google Business Profile posts for a local business, in its own voice ("we").
Tone: ${TONES[business.voice?.tone] || TONES.warm}. Language: ${business.voice?.language || 'English'}.
${POST_RULES}
${HUMAN_STYLE}
${SAFETY}
Return JSON {"title": "${needsTitle ? `short ${type === 'OFFER' ? 'offer' : 'event'} title, max 58 characters` : ''}", "summary": "the post text"}.`,
      user: `${businessContext(business, services, faqs)}

Post type: ${type === 'OFFER' ? 'Offer' : type === 'EVENT' ? 'Event' : 'Update'}
What to write: ${brief}
${instruction && theme !== 'custom' ? `Owner's note: ${instruction}` : ''}`,
    });
    const summary = String(data.summary || '').replace(/^["'“]|["'”]$/g, '').trim();
    if (!summary) throw new Error('empty post');
    return { summary: summary.slice(0, 1500), title: String(data.title || '').trim().slice(0, 58), model };
  } catch (err) {
    logFallback('post', err);
    return { ...H.heuristicPost({ business, services, theme, featured, instruction }), model: 'heuristic' };
  }
}

/* ------------------------------------------------------------------------- */
/* Customer questions                                                         */
/* ------------------------------------------------------------------------- */

const QA_RULES = `Answer ONLY from the business context and the owner's facts. If the context does not contain the answer, return an empty answer and needsInput true — never guess times, prices, parking, payment methods or policies.`;

export async function suggestQuestions({ business, services = [], faqs = [], reviewSnippets = [], existing = [] }) {
  try {
    const { data, model } = await chatJSON({
      temperature: 0.4,
      maxTokens: 1500,
      system: `You list the questions customers most often ask a local business before visiting, and draft answers.
Return JSON {"questions":[{"question":"...","answer":"...","needsInput":true|false,"fromReviews":true|false}]} with 8 items.
Questions should be short and practical (booking, timings, prices, parking, payment, duration, hygiene, kids, home service, etc.) and specific to this type of business.
Use the customer reviews to spot real questions and worries (set fromReviews true for those).
${QA_RULES}
Answers: 1–2 short sentences, friendly, simple English.`,
      user: `${businessContext(business, services, faqs)}

Recent customer reviews:
${reviewSnippets.slice(0, 15).map((r) => `- ${r}`).join('\n') || '(none)'}

Already listed (don't repeat): ${existing.join(' | ') || 'none'}`,
    });
    const seen = new Set(existing.map((q) => q.toLowerCase().trim()));
    const list = (Array.isArray(data.questions) ? data.questions : [])
      .map((q) => ({
        question: String(q.question || '').trim().slice(0, 300),
        answer: String(q.answer || '').trim().slice(0, 1500),
        needsInput: Boolean(q.needsInput) || !String(q.answer || '').trim(),
        fromReviews: Boolean(q.fromReviews),
      }))
      .filter((q) => q.question && !seen.has(q.question.toLowerCase()));
    if (!list.length) throw new Error('no questions');
    return { questions: list.slice(0, 10), model };
  } catch (err) {
    logFallback('questions', err);
    return { questions: H.heuristicQuestions({ business, services }).filter((q) => !existing.map((e) => e.toLowerCase()).includes(q.question.toLowerCase())), model: 'heuristic' };
  }
}

export async function answerQuestion({ business, services = [], faqs = [], question }) {
  try {
    const { data, model } = await chatJSON({
      temperature: 0.3,
      maxTokens: 300,
      system: `You answer a customer's question for a local business, as the business ("we"). Return JSON {"answer":"...","needsInput":true|false}.
${QA_RULES}
Answer in 1–2 short sentences.
${HUMAN_STYLE}`,
      user: `${businessContext(business, services, faqs)}\n\nQuestion: ${question}`,
    });
    const answer = String(data.answer || '').trim().slice(0, 1500);
    return { answer, needsInput: Boolean(data.needsInput) || !answer, model };
  } catch (err) {
    logFallback('answer', err);
    return { answer: '', needsInput: true, model: 'heuristic' };
  }
}
