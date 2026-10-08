import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { unauthorized, notFound, forbidden, HttpError } from '../utils/http.js';

export function signToken(user, { impersonatedBy } = {}) {
  if (impersonatedBy) return jwt.sign({ sub: String(user._id), imp: String(impersonatedBy) }, env.jwtSecret, { expiresIn: '2h' });
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
    // An admin opened this business with "Open as business"
    if (payload.imp) {
      const admin = await User.findById(payload.imp);
      if (!admin?.isAdmin()) throw unauthorized('Admin access ended. Sign in again.');
      req.impersonatedBy = admin;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Requires a platform admin (not an admin who is viewing a business). */
export function requireAdmin(req, _res, next) {
  if (!req.user?.isAdmin() || req.impersonatedBy) return next(forbidden('Admins only'));
  next();
}

async function loadBusiness(req, { allowSuspended }) {
  const business = await Business.findOne({ owner: req.user._id });
  if (!business) throw notFound('Business');
  // Paused accounts can't use the app (admins viewing the account still can)
  if (!allowSuspended && business.account?.status === 'suspended' && !req.impersonatedBy) {
    throw new HttpError(403, business.account.suspendedReason ? `Your account is paused: ${business.account.suspendedReason}` : 'Your account is paused. Contact us to continue.', undefined, 'account_suspended');
  }
  req.business = business;
}

/** Requires the signed-in user to have an active business; attaches req.business. */
export async function requireBusiness(req, _res, next) {
  try {
    await loadBusiness(req, { allowSuspended: false });
    next();
  } catch (err) {
    next(err);
  }
}

/** Same, but also lets a paused account through (billing page). */
export async function requireBusinessAnyStatus(req, _res, next) {
  try {
    await loadBusiness(req, { allowSuspended: true });
    next();
  } catch (err) {
    next(err);
  }
}
