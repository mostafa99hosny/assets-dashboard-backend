import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export function requestContext(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
}
