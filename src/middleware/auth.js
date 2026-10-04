import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { unauthorized, notFound } from '../utils/http.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/** Requires a valid Bearer token; attaches req.user. */
export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }
    const user = await User.findById(payload.sub);
    if (!user) throw unauthorized();
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires the signed-in user to have a business; attaches req.business. */
export async function requireBusiness(req, _res, next) {
  try {
    const business = await Business.findOne({ owner: req.user._id });
    if (!business) throw notFound('Business');
    req.business = business;
    next();
  } catch (err) {
    next(err);
  }
}
