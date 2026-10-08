/**
 * Creates (or updates) a login for the admin website.
 *
 *   npm run create-admin -- you@example.com                 # makes up a strong password and prints it
 *   npm run create-admin -- you@example.com "MyPass#2026"   # uses your password (8+ characters)
 *   npm run create-admin -- you@example.com "MyPass#2026" "Ravi Jha"
 *
 * If the email already has an account (e.g. a business owner), it becomes an admin too and,
 * if you give a password, that password is set. No business is needed for an admin.
 */
import crypto from 'node:crypto';

const [emailArg, passwordArg, ...nameParts] = process.argv.slice(2);
const email = String(emailArg || '').trim().toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: npm run create-admin -- you@example.com [password] [name]');
  process.exit(1);
}
if (passwordArg && passwordArg.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}
const password = passwordArg || `${crypto.randomBytes(9).toString('base64url')}#7`;

const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { User } = await import('../src/models/index.js');
await connectDB();

let user = await User.findOne({ email }).select('+passwordHash');
const existed = Boolean(user);
if (!user) user = new User({ email, name: nameParts.join(' ') || email.split('@')[0] });
user.role = 'admin';
if (!existed || passwordArg) await user.setPassword(password);
if (nameParts.length) user.name = nameParts.join(' ');
await user.save();

console.log('\nAdmin login ready');
console.log(`  Email:    ${email}`);
if (!existed || passwordArg) console.log(`  Password: ${password}`);
else console.log('  Password: unchanged (the one this account already uses)');
console.log('  Sign in on your admin website. Change the password there under Settings & admins.\n');
await disconnectDB();
