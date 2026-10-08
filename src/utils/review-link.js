/**
 * The business's Google review link — where customers are sent to post their review.
 *
 * It works without Google API access, so it is the main path until Google approves the app.
 * Rules: the owner's link is never cleared by the app (disconnecting Google keeps it), and a
 * Google connection only fills it in when it is empty or still the demo placeholder.
 */

const PLACE_ID = /^ChI[A-Za-z0-9_-]{10,}$/;

/** Accepts a full link, or a bare Google Place ID (turned into the review-form link). */
export function normalizeReviewLink(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (PLACE_ID.test(v)) return `https://search.google.com/local/writereview?placeid=${v}`;
  if (/^(www\.)?(g\.page|maps\.app\.goo\.gl|search\.google\.com|google\.[a-z.]+)\//i.test(v)) return `https://${v}`;
  return v;
}

/** The sample link the demo connection used to save. It leads nowhere real. */
export const isPlaceholderLink = (link) => /DEMO_PLACE_ID/.test(String(link || ''));

/** A link we can actually send customers to. */
export const usableReviewLink = (link) => (link && !isPlaceholderLink(link) ? link : '');

/**
 * Where the "Post on Google" button goes. The exact review form when the business saved its link;
 * otherwise a Google search for the business, whose profile has a "Write a review" button.
 */
export function googleReviewTarget(business) {
  const exact = usableReviewLink(business?.reviewLink);
  if (exact) return { url: exact, exact: true };
  const q = [business?.name, business?.address?.city, 'reviews'].filter(Boolean).join(' ');
  return { url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, exact: false };
}
