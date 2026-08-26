import type { Response } from "express";

import type { ApiEnvelope, ApiMeta } from "../types/api";

function baseMeta(res: Response): ApiMeta {
  return {
    requestId: String(res.locals.requestId ?? "unknown"),
  };
}

export function sendData<T>(
  res: Response,
  statusCode: number,
  data: T,
  meta: Omit<ApiMeta, "requestId"> = {},
): Response<ApiEnvelope<T>> {
  return res.status(statusCode).json({
    data,
    meta: {
      ...baseMeta(res),
      ...meta,
    },
  });
}
