import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from './env.js';

let embedded = null;

/**
 * Connects to MongoDB. When MONGODB_URI is not set (local development),
 * an embedded MongoDB is started automatically and its data is kept in
 * EMBEDDED_MONGO_PATH so nothing is lost between restarts.
 */
export async function connectDB() {
  mongoose.set('strictQuery', true);
  let uri = env.mongoUri;

  if (!uri) {
    if (env.isProd) throw new Error('MONGODB_URI is required in production');
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = await import('mongodb-memory-server-core'));
    } catch {
      throw new Error(
        'MONGODB_URI is not set and the embedded MongoDB package is unavailable. ' +
          'Set MONGODB_URI (e.g. mongodb://localhost:27017/starling or a MongoDB Atlas URI).'
      );
    }
    const dbPath = path.resolve(env.embeddedMongoPath);
    fs.mkdirSync(dbPath, { recursive: true });
    console.log(`[db] MONGODB_URI not set — starting embedded MongoDB (data: ${dbPath})`);
    console.log('[db] First start downloads the MongoDB binary (~100 MB). This happens once.');
    embedded = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger', port: Number(process.env.EMBEDDED_MONGO_PORT || 27027) },
    });
    uri = embedded.getUri('starling');
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`[db] connected to ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  if (embedded) await embedded.stop({ doCleanup: false });
}
