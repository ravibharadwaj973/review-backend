import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'manager', 'admin'], default: 'owner' },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function setPassword(password) {
  this.passwordHash = await bcrypt.hash(password, 11);
};
userSchema.methods.checkPassword = function checkPassword(password) {
  return bcrypt.compare(password, this.passwordHash);
};
/** Platform admins: role "admin", or an email listed in ADMIN_EMAILS. */
userSchema.methods.isAdmin = function isAdmin() {
  return this.role === 'admin' || env.adminEmails.includes(String(this.email).toLowerCase());
};
userSchema.methods.toJSON = function toJSON() {
  const { _id, name, email, role, createdAt, lastLoginAt } = this;
  return { id: _id, name, email, role, createdAt, lastLoginAt, isAdmin: this.isAdmin() };
};

export const User = mongoose.model('User', userSchema, 'users');
