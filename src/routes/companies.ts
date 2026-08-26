import type { Request } from "express";
import { Router } from "express";

import { getCompanyDashboard } from "../services/dashboard.service";
import { sendData } from "../utils/api-response";
import { asyncHandler } from "../utils/async-handler";
import { parseDashboardPagination, type QueryValue } from "../utils/filters";

function query(request: Request): Record<string, QueryValue> {
  return request.query as unknown as Record<string, QueryValue>;
}

export const companiesRouter = Router();

/** `default` resolves solely from the backend-only DEFAULT_COMPANY_ID setting. */
companiesRouter.get(
  "/companies/default/dashboard",
  asyncHandler(async (request, response) => {
    const pagination = parseDashboardPagination(query(request));
    const dashboard = await getCompanyDashboard(pagination);
    return sendData(response, 200, dashboard, {
      generatedAt: new Date().toISOString(),
      pagination: dashboard.pagination,
    });
  }),
);
