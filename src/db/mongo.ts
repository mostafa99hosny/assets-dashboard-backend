import { Db, MongoClient } from "mongodb";

import { env } from "../config/env";

let client: MongoClient | undefined;
let connectionPromise: Promise<Db> | undefined;

/**
 * Creates one process-wide MongoClient. This module intentionally exposes only
 * a Db handle for read queries; repositories must not run write operations.
 * Atlas permissions remain the real enforcement boundary: use a read-only user.
 */
export function getDatabase(): Promise<Db> {
  if (connectionPromise) {
    return connectionPromise;
  }

  client = new MongoClient(env.mongoUrl, {
    appName: "assets-dashboard-api",
    maxPoolSize: env.mongoMaxPoolSize,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    retryReads: true,
  });

  connectionPromise = client.connect().then(() => client!.db(env.mongoDbName));

  connectionPromise.catch(() => {
    // Allow a later request/restart attempt if the first connection fails.
    connectionPromise = undefined;
    client = undefined;
  });

  return connectionPromise;
}

export async function verifyDatabaseConnection(): Promise<void> {
  const database = await getDatabase();
  await database.command({ ping: 1 });
}

export async function closeDatabaseConnection(): Promise<void> {
  const existingClient = client;
  client = undefined;
  connectionPromise = undefined;

  if (existingClient) {
    await existingClient.close();
  }
}
