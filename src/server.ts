import { createServer } from "node:http";

import { app } from "./app";
import { env } from "./config/env";
import { closeDatabaseConnection, verifyDatabaseConnection } from "./db/mongo";
import { createLiveUpdates } from "./realtime/live-updates";

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(env.port);
  });
}

async function start(): Promise<void> {
  // Fail the deployment early rather than accepting requests with an invalid DB setup.
  await verifyDatabaseConnection();

  const server = createServer(app);
  const liveUpdates = createLiveUpdates(server);
  try {
    await liveUpdates.start();
    await listen(server);
  } catch (error) {
    await liveUpdates.stop().catch(() => undefined);
    throw error;
  }
  console.info(`Assets Dashboard API listening on port ${env.port}.`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`Received ${signal}; closing API server.`);

    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();

    // Socket.IO owns the same HTTP server and closes it as part of `close()`.
    // End streams first so the database is never closed beneath an active watch.
    void (async () => {
      let exitCode = 0;

      try {
        await liveUpdates.stop();
      } catch {
        exitCode = 1;
      }

      try {
        await closeDatabaseConnection();
      } catch {
        exitCode = 1;
      }

      clearTimeout(forceExit);
      process.exit(exitCode);
    })();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void start().catch((error: unknown) => {
  // Do not print the connection string; Error messages are enough for deployment logs.
  console.error("Unable to start Assets Dashboard API.", error instanceof Error ? error.message : error);
  void closeDatabaseConnection().finally(() => process.exit(1));
});
