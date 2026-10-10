import { GoogleAccount } from '../../models/index.js';
import { HttpError } from '../../utils/http.js';

export const realReviewFilter = { source: { $in: ['google', 'direct'] } };

export const isLiveConnection = (account) => Boolean(
  account?.mode === 'live' && account.status === 'connected' && account.locationName
);

export async function requireReplyConnection(businessId, review) {
  const account = await GoogleAccount.findOne({ business: businessId }).select('+accessTokenEnc +refreshTokenEnc');
  if (!isLiveConnection(account)) throw new HttpError(409, 'Connect your Google Business Profile and select a location before replying');
  if (review && !['google', 'direct'].includes(review.source)) throw new HttpError(409, 'Replies are only available for real customer reviews');
  return account;
}
