/**
 * Gives a user platform-admin access (the /admin section).
 *   npm run make-admin -- you@example.com
 * The user must already have signed up. ADMIN_EMAILS in .env works too, without this script.
 */
const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- you@example.com');
  process.exit(1);
}
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { User } = await import('../src/models/index.js');
await connectDB();
const user = await User.findOne({ email });
if (!user) {
  console.error(`No user with email ${email}. Sign up in the app first.`);
} else {
  user.role = 'admin';
  await user.save();
  console.log(`${email} is now an admin. Open /admin after signing in.`);
}
await disconnectDB();
