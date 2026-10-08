import { env } from '../config/env.js';
import { User } from '../models/index.js';

/**
 * Makes sure the admin login in .env exists and works:
 *   ADMIN_EMAIL=you@example.com
 *   ADMIN_PASSWORD=your-strong-password
 *   ADMIN_NAME=Your Name           (optional)
 * Creates the user if needed, gives it admin access, and sets the password from .env
 * whenever it differs. Change ADMIN_PASSWORD and restart to change the password.
 */
export async function ensureAdminFromEnv() {
  const { email, password, name } = env.admin;
  if (!email && !password) return null;
  if (!email || !password) {
    console.warn('[admin] Set both ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the admin login');
    return null;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    console.warn(`[admin] ADMIN_EMAIL "${email}" is not a valid email — admin login not created`);
    return null;
  }
  if (password.length < 8) {
    console.warn('[admin] ADMIN_PASSWORD must be at least 8 characters — admin login not created');
    return null;
  }
  let user = await User.findOne({ email }).select('+passwordHash');
  let action = 'ready';
  if (!user) {
    user = new User({ email, name: name || email.split('@')[0], role: 'admin' });
    await user.setPassword(password);
    action = 'created';
  } else {
    if (user.role !== 'admin') {
      user.role = 'admin';
      action = 'updated';
    }
    if (!(await user.checkPassword(password))) {
      await user.setPassword(password);
      action = 'updated';
    }
    if (name && user.name !== name) {
      user.name = name;
      action = 'updated';
    }
  }
  if (action !== 'ready') await user.save();
  console.log(`[admin] Admin login ${action}: ${email}`);
  return user;
}
