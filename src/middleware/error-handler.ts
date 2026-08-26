import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";

import { env } from "../config/env";
import { AppError } from "../errors/app-error";
import type { ApiErrorEnvelope } from "../types/api";

function errorPayload(error: AppError, requestId: string): ApiErrorEnvelope {
  return {
    data: null,
    meta: { requestId },
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export const notFoundHandler = (
  request: Request,
  _response: Response,
  next: NextFunction,
): void => {
  next(new AppError(404, "ROUTE_NOT_FOUND", `No route matches ${request.method} ${request.path}.`));
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const requestId = String(response.locals.requestId ?? "unknown");
  const appError = error instanceof AppError
    ? error
    : error instanceof SyntaxError && "status" in error && Number((error as { status?: unknown }).status) === 400
      ? new AppError(400, "INVALID_JSON", "Request JSON is invalid.")
      : new AppError(500, "INTERNAL_ERROR", "An unexpected server error occurred.");

  if (appError.statusCode >= 500) {
    // Intentionally omit MongoDB error text, connection details, and stack traces.
    console.error(JSON.stringify({
      level: "error",
      requestId,
      code: appError.code,
      statusCode: appError.statusCode,
      message: env.isProduction ? undefined : error instanceof Error ? error.message : String(error),
    }));
  }

  response.status(appError.statusCode).json(errorPayload(appError, requestId));
};
