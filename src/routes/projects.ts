import type { Request } from "express";
import { Router } from "express";

import {
  getAssetExport,
  getProjectAssetDetail,
  getProjectAssets,
  getProjectFilterOptions,
  getProjectMetadata,
  getProjectOverview,
} from "../services/dashboard.service";
import { sendData } from "../utils/api-response";
import { asyncHandler } from "../utils/async-handler";
import {
  parseAssetFilters,
  parseExportLimit,
  parseObjectId,
  parseOptionCategories,
  type QueryValue,
  publicFilters,
} from "../utils/filters";
import { toCsv } from "../utils/csv";

function projectId(request: Request) {
  return parseObjectId(request.params.id, "project id");
}

function assetId(request: Request) {
  return parseObjectId(request.params.assetId, "asset id");
}

function query(request: Request): Record<string, QueryValue> {
  return request.query as unknown as Record<string, QueryValue>;
}

function boolForCsv(value: boolean | null): string {
  return value === null ? "" : value ? "true" : "false";
}

export const projectsRouter = Router();

projectsRouter.get(
  "/projects/:id/overview",
  asyncHandler(async (request, response) => {
    const overview = await getProjectOverview(projectId(request));
    return sendData(response, 200, overview, { generatedAt: new Date().toISOString() });
  }),
);

projectsRouter.get(
  "/projects/:id/filter-options",
  asyncHandler(async (request, response) => {
    const options = await getProjectFilterOptions(
      projectId(request),
      parseOptionCategories(query(request)),
    );
    return sendData(response, 200, options, { generatedAt: new Date().toISOString() });
  }),
);

// Must precede /assets/:assetId because `export.csv` is not an ObjectId.
projectsRouter.get(
  "/projects/:id/assets/export.csv",
  asyncHandler(async (request, response) => {
    const filters = parseAssetFilters(query(request));
    const limit = parseExportLimit(query(request));
    const result = await getAssetExport(projectId(request), filters, limit);

    const csv = toCsv(
      [
        "id",
        "externalAssetId",
        "displayName",
        "category",
        "type",
        "condition",
        "source",
        "location",
        "quantity",
        "isPresent",
        "isDone",
        "hasNotes",
        "updatedAt",
      ],
      result.assets.map((asset) => [
        asset.id,
        asset.externalAssetId,
        asset.displayName,
        asset.category,
        asset.type,
        asset.condition,
        asset.source,
        asset.location,
        asset.quantity,
        boolForCsv(asset.isPresent),
        boolForCsv(asset.isDone),
        boolForCsv(asset.hasNotes),
        asset.updatedAt,
      ]),
    );

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="assets-${projectId(request).toHexString()}.csv"`,
    );
    response.setHeader("X-Export-Limit", String(limit));
    response.setHeader("X-Export-Truncated", String(result.truncated));
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).send(`\uFEFF${csv}`);
  }),
);

projectsRouter.get(
  "/projects/:id/assets/:assetId",
  asyncHandler(async (request, response) => {
    const detail = await getProjectAssetDetail(projectId(request), assetId(request));
    return sendData(response, 200, detail, { generatedAt: new Date().toISOString() });
  }),
);

projectsRouter.get(
  "/projects/:id/assets",
  asyncHandler(async (request, response) => {
    const filters = parseAssetFilters(query(request));
    const result = await getProjectAssets(projectId(request), filters);
    return sendData(response, 200, {
      assets: result.assets,
      total: result.total,
      nextCursor: result.nextCursor,
      pagination: result.pagination,
    }, {
      generatedAt: new Date().toISOString(),
      pagination: result.pagination,
      total: result.total,
      nextCursor: result.nextCursor,
      appliedFilters: publicFilters(filters),
    });
  }),
);

projectsRouter.get(
  "/projects/:id",
  asyncHandler(async (request, response) => {
    const metadata = await getProjectMetadata(projectId(request));
    return sendData(response, 200, metadata, { generatedAt: new Date().toISOString() });
  }),
);
