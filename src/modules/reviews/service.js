import { Review, AiResponse, Service, Customer, ReviewRequest, GoogleAccount } from '../../models/index.js';
import { analyzeReview, generateReply } from '../ai/service.js';
import * as google from '../google/client.js';
import { HttpError } from '../../utils/http.js';

/**
 * Upserts reviews coming from Google (or the demo source).
 * Returns the list of reviews that were newly created.
 */
export async function ingestReviews(business, items, { source = 'google', locationId } = {}) {
  const created = [];
  for (const item of items) {
    const existing = await Review.findOne({ business: business._id, googleReviewId: item.googleReviewId });
    if (existing) {
      // Update text/rating/reply if the customer or owner edited on Google
      existing.rating = item.rating;
      existing.comment = item.comment;
      existing.updateTime = item.updateTime;
      if (item.reply?.comment) {
        existing.reply = { comment: item.reply.comment, updateTime: item.reply.updateTime, by: existing.reply?.by || 'google' };
        existing.status = 'answered';
      } else if (existing.status === 'answered' && existing.reply?.by === 'google') {
        existing.reply = undefined;
        existing.status = 'unanswered';
      }
      await existing.save();
      continue;
    }
    const review = await Review.create({
      business: business._id,
      location: locationId,
      source,
      ...item,
      status: item.reply?.comment ? 'answered' : 'unanswered',
    });
    created.push(review);
  }
  return created;
}

/** Map a Google v4 review resource to our shape. */
export function fromGoogleReview(r) {
  return {
    googleReviewName: r.name,
    googleReviewId: r.reviewId,
    reviewer: {
      name: r.reviewer?.isAnonymous ? 'Anonymous' : r.reviewer?.displayName || 'Google user',
      photoUrl: r.reviewer?.profilePhotoUrl,
      isAnonymous: Boolean(r.reviewer?.isAnonymous),
    },
    rating: google.starToNumber(r.starRating) || 1,
    comment: (r.comment || '').replace(/\(Translated by Google\)[\s\S]*$/, '').trim(),
    createTime: new Date(r.createTime),
    updateTime: r.updateTime ? new Date(r.updateTime) : undefined,
    reply: r.reviewReply ? { comment: r.reviewReply.comment, updateTime: new Date(r.reviewReply.updateTime) } : undefined,
  };
}

export async function analyzeAndStore(review, business, services) {
  const svc = services || (await Service.find({ business: business._id, active: true }).lean());
  review.analysis = await analyzeReview({ review, business, services: svc });
  await review.save();
  return review;
}

export async function recentReplies(business) {
  const replied = await Review.find({ business: business._id, 'reply.comment': { $exists: true, $ne: '' } })
    .sort({ 'reply.updateTime': -1 })
    .limit(3)
    .select('reply')
    .lean();
  return replied.map((r) => r.reply?.comment).filter(Boolean);
}

export async function draftReply(review, business, { tone, instruction } = {}) {
  const services = await Service.find({ business: business._id, active: true }).lean();
  if (!review.analysis?.analyzedAt) await analyzeAndStore(review, business, services);
  const previousReplies = await recentReplies(business);
  const { text, model, tone: usedTone } = await generateReply({
    review, analysis: review.analysis, business, services, previousReplies, tone, instruction,
  });
  // Only one live draft per review
  await AiResponse.updateMany({ review: review._id, status: 'draft' }, { status: 'discarded' });
  const draft = await AiResponse.create({ business: business._id, review: review._id, text, model, tone: usedTone });
  if (review.status === 'unanswered') {
    review.status = 'drafted';
    await review.save();
  }
  return draft;
}

/**
 * Publishes a reply. For live connections it is sent to Google; the review is only
 * marked answered after Google accepts it. Demo connections never claim Google publishing.
 */
export async function publishReply({ review, business, user, text, aiResponseId }) {
  const comment = String(text || '').trim();
  if (!comment) throw new HttpError(400, 'Write a reply before publishing');
  if (comment.length > 4096) throw new HttpError(400, 'Replies must be under 4,096 characters');

  const account = await GoogleAccount.findOne({ business: business._id }).select('+accessTokenEnc +refreshTokenEnc');
  // Direct (in-app) reviews have no Google counterpart: the reply is stored in Starling only
  let publishedTo = review.source === 'direct' ? 'app' : 'demo';

  let aiResponse = aiResponseId ? await AiResponse.findOne({ _id: aiResponseId, business: business._id }) : null;

  if (review.source === 'google') {
    if (!account || account.mode !== 'live') throw new HttpError(409, 'Connect your Google Business Profile to publish replies');
    try {
      await google.putReply(account, review.googleReviewId, comment);
      publishedTo = 'google';
    } catch (err) {
      if (aiResponse) {
        aiResponse.status = 'failed';
        aiResponse.error = err.message;
        await aiResponse.save();
      }
      throw err;
    }
  }

  review.reply = { comment, updateTime: new Date(), by: 'app' };
  review.status = 'answered';
  await review.save();

  if (aiResponse) {
    aiResponse.finalText = comment;
    aiResponse.edited = comment !== aiResponse.text;
    aiResponse.status = 'published';
    aiResponse.approvedBy = user?._id;
    aiResponse.approvedAt = aiResponse.approvedAt || new Date();
    aiResponse.publishedAt = new Date();
    aiResponse.publishedTo = publishedTo;
    await aiResponse.save();
  }
  return { review, aiResponse, publishedTo };
}

/**
 * Links a new review to a customer who was recently sent a review request,
 * when the reviewer's name matches. This is a best-effort attribution.
 */
export async function attributeReview(review, business) {
  const reviewerName = (review.reviewer?.name || '').toLowerCase().trim();
  if (!reviewerName || review.reviewer?.isAnonymous) return null;
  const since = new Date(review.createTime.getTime() - 45 * 864e5);
  const requests = await ReviewRequest.find({
    business: business._id,
    status: { $in: ['sent', 'clicked'] },
    sentAt: { $gte: since, $lte: review.createTime },
  }).populate('customer');

  const [first, ...rest] = reviewerName.split(/\s+/);
  const last = rest.at(-1);
  const match = requests.find((r) => {
    const cn = (r.customer?.name || '').toLowerCase().trim();
    if (!cn) return false;
    if (cn === reviewerName) return true;
    const [cf, ...cr] = cn.split(/\s+/);
    const cl = cr.at(-1);
    return cf === first && (!last || !cl || cl[0] === last[0]);
  });
  if (!match) return null;

  match.status = 'reviewed';
  match.reviewedAt = review.createTime;
  match.review = review._id;
  match.attribution = 'name_match';
  await match.save();
  await Customer.updateOne({ _id: match.customer._id }, { reviewStatus: 'reviewed', googleReview: review._id });
  review.customer = match.customer._id;
  review.reviewRequest = match._id;
  await review.save();
  return match;
}

/** Full pipeline for freshly detected reviews: analyse → attribute → draft (→ optional auto-publish). */
export async function processNewReviews(business, reviews) {
  if (!reviews.length) return;
  const services = await Service.find({ business: business._id, active: true }).lean();
  for (const review of reviews) {
    try {
      if (business.automation?.autoAnalyze !== false) await analyzeAndStore(review, business, services);
      await attributeReview(review, business);
      if (review.status === 'unanswered' && business.automation?.autoDraftReplies !== false) {
        const draft = await draftReply(review, business);
        if (business.automation?.autoPublishFiveStar && review.rating === 5 && review.analysis?.sentiment === 'positive') {
          await publishReply({ review, business, text: draft.text, aiResponseId: draft._id });
        }
      }
    } catch (err) {
      console.warn(`[reviews] pipeline failed for ${review._id}:`, err.message);
    }
  }
}
