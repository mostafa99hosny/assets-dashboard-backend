import type { CorsOptions } from "cors";

import { env } from "./env";
import { AppError } from "../errors/app-error";

/**
 * Shared browser-origin policy for both Express and Socket.IO. Keeping this in
 * one module prevents a separately deployed frontend from being allowed by one
 * transport and rejected by the other.
 */
export function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return env.corsAllowNoOrigin;
  }

  return env.corsOrigins.includes(origin);
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (isCorsOriginAllowed(origin)) {
      callback(null, true);
      return;
    }

    callback(
      new AppError(403, "CORS_ORIGIN_DENIED", "This browser origin is not allowed."),
    );
  },
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Request-Id"],
  exposedHeaders: [
    "Content-Disposition",
    "X-Export-Limit",
    "X-Export-Truncated",
    "X-Request-Id",
  ],
  maxAge: 600,
  optionsSuccessStatus: 204,
};
