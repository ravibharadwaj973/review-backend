import { GeneratedReview } from '../../models/GeneratedReview.js';
import { HttpError } from '../../utils/http.js';

export async function recordGeneratedReview({ business, body, result, source, reviewRequest }) {
  if (!result.model?.startsWith('groq:') || !result.text?.trim()) {
    throw new HttpError(503, 'A successful Groq draft is required to save a generated review');
  }
  return GeneratedReview.create({
    business: business._id,
    reviewRequest,
    source,
    text: result.text,
    model: result.model,
    rating: body.rating,
    services: body.services,
  });
}
