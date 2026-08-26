import { type Document, ObjectId } from "mongodb";

import { env } from "../config/env";
import { getDatabase } from "../db/mongo";
import { NotFoundError } from "../errors/app-error";
import {
  type AssetQueryFilters,
  escapeRegex,
} from "../utils/filters";
import {
  asRecord,
  booleanOrNull,
  numberOrNull,
  numberOrStringOrNull,
  stringOrNull,
  toPlainValue,
} from "../utils/serialize";

const COLLECTION = {
  companies: "companies",
  projects: "mv_projects",
  assets: "assets",
  items: "items",
  users: "users",
} as const;

const UNKNOWN_VALUE = "غير محدد";
const DEFAULT_COMPANY_OBJECT_ID = new ObjectId(env.defaultCompanyId);
const QUERY_OPTIONS = { maxTimeMS: env.mongoQueryTimeoutMs } as const;

type PlainRecord = Record<string, unknown>;

function recordArray(value: unknown): PlainRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item) => Object.keys(item).length > 0)
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function idValue(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" && value ? value : null;
}

function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 10_000) / 100;
}

function projectBase(project: PlainRecord) {
  return {
    id: idValue(project._id),
    name: stringOrNull(project.name) ?? "بدون اسم",
    displayNumber: numberOrNull(project.displayNumber),
    workflowStatus: stringOrNull(project.workflowStatus),
    reportType: stringOrNull(project.reportType),
    createdAt: dateValue(project.createdAt),
    updatedAt: dateValue(project.updatedAt),
    lastSyncedChangeAt: dateValue(project.lastSyncedChangeAt),
    syncVersion: numberOrNull(project.syncVersion),
  };
}

function companyBase(company: PlainRecord) {
  return {
    id: idValue(company._id),
    name: stringOrNull(company.name) ?? "بدون اسم",
    logoDataUrl: stringOrNull(company.logoDataUrl),
    createdAt: dateValue(company.createdAt),
    updatedAt: dateValue(company.updatedAt),
  };
}

function assetBaseMatch(projectId: ObjectId): Document {
  // Folder hierarchy belongs to `items`. Historical asset imports can set
  // `isAssetFolder: true` on ordinary assets, so this flag is not safe to use
  // as an exclusion criterion for dashboard rows or statistics.
  return {
    projectId,
  };
}

async function getProjectForDefaultCompany(projectId: ObjectId): Promise<PlainRecord> {
  const database = await getDatabase();
  const project = await database
    .collection<Document>(COLLECTION.projects)
    .findOne(
      { _id: projectId, companyId: DEFAULT_COMPANY_OBJECT_ID },
      {
        projection: {
          _id: 1,
          companyId: 1,
          name: 1,
          displayNumber: 1,
          workflowStatus: 1,
          reportType: 1,
          createdAt: 1,
          updatedAt: 1,
          lastSyncedChangeAt: 1,
          syncVersion: 1,
        },
        maxTimeMS: env.mongoQueryTimeoutMs,
      },
    );

  if (!project) {
    // Do not reveal whether the ID belongs to a different company.
    throw new NotFoundError("Project not found.");
  }

  return asRecord(project);
}

async function getDefaultCompany(): Promise<PlainRecord> {
  const database = await getDatabase();
  const company = await database
    .collection<Document>(COLLECTION.companies)
    .findOne(
      { _id: DEFAULT_COMPANY_OBJECT_ID },
      {
        projection: { _id: 1, name: 1, logoDataUrl: 1, createdAt: 1, updatedAt: 1 },
        maxTimeMS: env.mongoQueryTimeoutMs,
      },
    );

  if (!company) {
    throw new NotFoundError("Configured default company was not found.");
  }

  return asRecord(company);
}

async function resolveFolderIds(
  projectId: ObjectId,
  folderId: ObjectId,
  includeDescendants: boolean,
): Promise<ObjectId[]> {
  const database = await getDatabase();

  const pipeline: Document[] = [
    { $match: { _id: folderId, projectId } },
  ];

  if (includeDescendants) {
    pipeline.push({
      $graphLookup: {
        from: COLLECTION.items,
        startWith: "$_id",
        connectFromField: "_id",
        connectToField: "parent",
        as: "descendants",
        restrictSearchWithMatch: { projectId },
        maxDepth: 20,
      },
    });
    pipeline.push({
      $project: {
        ids: { $concatArrays: [["$_id"], "$descendants._id"] },
      },
    });
  } else {
    pipeline.push({ $project: { ids: ["$_id"] } });
  }

  const result = await database
    .collection<Document>(COLLECTION.items)
    .aggregate(pipeline, QUERY_OPTIONS)
    .next();

  if (!result) {
    throw new NotFoundError("Folder not found in this project.");
  }

  const ids = asRecord(result).ids;
  return Array.isArray(ids)
    ? ids.filter((entry): entry is ObjectId => entry instanceof ObjectId)
    : [];
}

async function buildAssetMatch(
  projectId: ObjectId,
  filters: AssetQueryFilters,
): Promise<Document> {
  const match = assetBaseMatch(projectId);

  if (filters.sources.length > 0) {
    match.asset_source = { $in: filters.sources };
  }
  if (filters.conditions.length > 0) {
    match.condition = { $in: filters.conditions };
  }
  if (filters.categories.length > 0) {
    match.category = { $in: filters.categories };
  }
  if (filters.types.length > 0) {
    match.type = { $in: filters.types };
  }
  if (filters.employers.length > 0) {
    match.employer = { $in: filters.employers };
  }
  if (filters.statuses.length > 0) {
    match.status = { $in: filters.statuses };
  }
  if (filters.isPresent !== undefined) {
    match.isPresent = filters.isPresent;
  }
  if (filters.isDone !== undefined) {
    match.isDone = filters.isDone;
  }
  if (filters.hasNotes !== undefined) {
    match.hasNotes = filters.hasNotes;
  }
  if (filters.updatedFrom || filters.updatedTo) {
    match.updatedAt = {
      ...(filters.updatedFrom ? { $gte: filters.updatedFrom } : {}),
      ...(filters.updatedTo ? { $lte: filters.updatedTo } : {}),
    };
  }
  if (filters.folderId) {
    const folderIds = await resolveFolderIds(
      projectId,
      filters.folderId,
      filters.includeDescendants,
    );
    match.parent = { $in: folderIds };
  }

  return match;
}

function searchStages(q: string | undefined): Document[] {
  if (!q) {
    return [];
  }

  const safeRegex = new RegExp(escapeRegex(q), "i");
  return [
    {
      $addFields: {
        _searchDescription: {
          $let: {
            vars: { descriptionType: { $type: "$asset_description" } },
            in: {
              $cond: [
                { $eq: ["$$descriptionType", "object"] },
                {
                  $reduce: {
                    input: { $objectToArray: "$asset_description" },
                    initialValue: "",
                    in: {
                      $concat: [
                        "$$value",
                        " ",
                        "$$this.k",
                        " ",
                        {
                          $convert: {
                            input: "$$this.v",
                            to: "string",
                            onError: "",
                            onNull: "",
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  $convert: {
                    input: "$asset_description",
                    to: "string",
                    onError: "",
                    onNull: "",
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      $match: {
        $or: [
          { name: safeRegex },
          { lable: safeRegex },
          { _searchDescription: safeRegex },
          { "asset_description.category": safeRegex },
          { "asset_description.type": safeRegex },
          { "asset_description.name": safeRegex },
          { category: safeRegex },
          { type: safeRegex },
          { code: safeRegex },
          { client_code: safeRegex },
          { employer: safeRegex },
        ],
      },
    },
  ];
}

function listNormalizationStages(): Document[] {
  return [
    {
      $addFields: {
        _displayName: { $ifNull: ["$name", "$lable"] },
        _location: { $ifNull: ["$newAssetLocation", "$asset_location"] },
        _thumbnailUrl: {
          $ifNull: ["$images.main.thumbnailUrl", "$images.main.url"],
        },
      },
    },
  ];
}

function assetSort(filters: AssetQueryFilters): Document {
  const fields: Record<AssetQueryFilters["sortBy"], string> = {
    displayName: "_displayName",
    updatedAt: "updatedAt",
    condition: "condition",
    category: "category",
    type: "type",
    source: "asset_source",
    quantity: "quantity",
  };

  return { [fields[filters.sortBy]]: filters.sortDir, _id: filters.sortDir };
}

function assetListItem(asset: PlainRecord) {
  return {
    id: idValue(asset._id),
    externalAssetId: stringOrNull(asset.assetId),
    displayName: stringOrNull(asset.displayName) ?? "بدون اسم",
    category: stringOrNull(asset.category),
    type: stringOrNull(asset.type),
    condition: stringOrNull(asset.condition),
    source: stringOrNull(asset.asset_source),
    location: stringOrNull(asset.location),
    quantity: numberOrNull(asset.quantity),
    isPresent: booleanOrNull(asset.isPresent),
    isDone: booleanOrNull(asset.isDone),
    hasNotes: booleanOrNull(asset.hasNotes),
    parentId: idValue(asset.parent),
    thumbnailUrl: stringOrNull(asset.thumbnailUrl),
    imageUrl: stringOrNull(asset.imageUrl),
    updatedAt: dateValue(asset.updatedAt),
  };
}

function distribution(value: unknown) {
  return recordArray(value).map((entry) => ({
    value: stringOrNull(entry._id) ?? UNKNOWN_VALUE,
    count: numberValue(entry.count),
  }));
}

function compactProject(project: PlainRecord) {
  const stats = asRecord(project.assetStats);
  const totalAssets = numberValue(stats.totalAssets);
  const completedAssets = numberValue(stats.completedAssets);
  const presentAssets = numberValue(stats.presentAssets);

  return {
    ...projectBase(project),
    assetCount: totalAssets,
    completedAssetCount: completedAssets,
    completedPercent: percent(completedAssets, totalAssets),
    presentAssetCount: presentAssets,
    presentPercent: percent(presentAssets, totalAssets),
  };
}

export async function getCompanyDashboard({
  page = 1,
  pageSize = 12,
}: {
  page?: number;
  pageSize?: number;
} = {}) {
  const database = await getDatabase();
  const skip = (page - 1) * pageSize;
  const [company, aggregation] = await Promise.all([
    getDefaultCompany(),
    database
      .collection<Document>(COLLECTION.projects)
      .aggregate(
        [
          { $match: { companyId: DEFAULT_COMPANY_OBJECT_ID } },
          {
            $lookup: {
              from: COLLECTION.assets,
              let: { projectId: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$projectId", "$$projectId"] },
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalAssets: { $sum: 1 },
                    completedAssets: {
                      $sum: { $cond: [{ $eq: ["$isDone", true] }, 1, 0] },
                    },
                    presentAssets: {
                      $sum: { $cond: [{ $eq: ["$isPresent", true] }, 1, 0] },
                    },
                  },
                },
              ],
              as: "assetStats",
            },
          },
          {
            $set: {
              assetStats: {
                $ifNull: [
                  { $arrayElemAt: ["$assetStats", 0] },
                  { totalAssets: 0, completedAssets: 0, presentAssets: 0 },
                ],
              },
            },
          },
          {
            $facet: {
              projects: [
                { $sort: { updatedAt: -1, _id: 1 } },
                { $skip: skip },
                { $limit: pageSize },
                {
                  $project: {
                    _id: 1,
                    name: 1,
                    displayNumber: 1,
                    workflowStatus: 1,
                    reportType: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    lastSyncedChangeAt: 1,
                    syncVersion: 1,
                    assetStats: 1,
                  },
                },
              ],
              summary: [
                {
                  $group: {
                    _id: null,
                    projectCount: { $sum: 1 },
                    assetCount: { $sum: "$assetStats.totalAssets" },
                    completedAssetCount: { $sum: "$assetStats.completedAssets" },
                    presentAssetCount: { $sum: "$assetStats.presentAssets" },
                  },
                },
              ],
            },
          },
        ],
        QUERY_OPTIONS,
      )
      .next(),
  ]);

  const result = asRecord(aggregation);
  const summary = asRecord(recordArray(result.summary)[0]);
  const projectCount = numberValue(summary.projectCount);
  const assetCount = numberValue(summary.assetCount);
  const completedAssetCount = numberValue(summary.completedAssetCount);
  const presentAssetCount = numberValue(summary.presentAssetCount);

  return {
    company: companyBase(company),
    summary: {
      projectCount,
      assetCount,
      completedAssetCount,
      completedPercent: percent(completedAssetCount, assetCount),
      presentAssetCount,
      presentPercent: percent(presentAssetCount, assetCount),
    },
    projects: recordArray(result.projects).map(compactProject),
    pagination: {
      page,
      pageSize,
      total: projectCount,
      totalPages: projectCount === 0 ? 0 : Math.ceil(projectCount / pageSize),
    },
  };
}

export async function getProjectMetadata(projectId: ObjectId) {
  const [project, company] = await Promise.all([
    getProjectForDefaultCompany(projectId),
    getDefaultCompany(),
  ]);

  return {
    company: companyBase(company),
    project: projectBase(project),
  };
}

export async function getProjectOverview(projectId: ObjectId) {
  // Verify company ownership before touching assets, so project routes are
  // always scoped to DEFAULT_COMPANY_ID rather than to a bare project ID.
  const project = await getProjectForDefaultCompany(projectId);
  const [company, aggregateResult] = await Promise.all([
    getDefaultCompany(),
    (async () => {
      const database = await getDatabase();
      return database
        .collection<Document>(COLLECTION.assets)
        .aggregate(
          [
            { $match: assetBaseMatch(projectId) },
            {
              $facet: {
                summary: [
                  {
                    $group: {
                      _id: null,
                      totalAssets: { $sum: 1 },
                      completedAssets: {
                        $sum: { $cond: [{ $eq: ["$isDone", true] }, 1, 0] },
                      },
                      presentAssets: {
                        $sum: { $cond: [{ $eq: ["$isPresent", true] }, 1, 0] },
                      },
                      hasNotesCount: {
                        $sum: { $cond: [{ $eq: ["$hasNotes", true] }, 1, 0] },
                      },
                      pendingReviewCount: {
                        $sum: {
                          $cond: [
                            {
                              $and: [
                                { $eq: ["$asset_source", "عميل"] },
                                { $eq: ["$status", "pending_review"] },
                              ],
                            },
                            1,
                            0,
                          ],
                        },
                      },
                    },
                  },
                ],
                bySource: [
                  {
                    $group: {
                      _id: { $ifNull: ["$asset_source", UNKNOWN_VALUE] },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1, _id: 1 } },
                ],
                byCondition: [
                  {
                    $group: {
                      _id: { $ifNull: ["$condition", UNKNOWN_VALUE] },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1, _id: 1 } },
                ],
                topCategories: [
                  {
                    $group: {
                      _id: { $ifNull: ["$category", UNKNOWN_VALUE] },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1, _id: 1 } },
                  { $limit: 10 },
                ],
                // Asset descriptions can be free text or a structured record.
                // For records, use only the human-readable `name` field rather
                // than serializing the whole object into an opaque label.
                topDescriptions: [
                  {
                    $project: {
                      _description: {
                        $trim: {
                          input: {
                            $switch: {
                              branches: [
                                {
                                  case: { $eq: [{ $type: "$asset_description" }, "string"] },
                                  then: "$asset_description",
                                },
                                {
                                  case: { $eq: [{ $type: "$asset_description" }, "object"] },
                                  then: {
                                    $convert: {
                                      input: "$asset_description.name",
                                      to: "string",
                                      onError: "",
                                      onNull: "",
                                    },
                                  },
                                },
                              ],
                              default: "",
                            },
                          },
                        },
                      },
                    },
                  },
                  { $match: { _description: { $ne: "" } } },
                  {
                    $group: {
                      _id: "$_description",
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1, _id: 1 } },
                  { $limit: 1 },
                ],
              },
            },
          ],
          QUERY_OPTIONS,
        )
        .next();
    })(),
  ]);

  const result = asRecord(aggregateResult);
  const summary = asRecord(recordArray(result.summary)[0]);
  const totalAssets = numberValue(summary.totalAssets);
  const completedAssets = numberValue(summary.completedAssets);
  const presentAssets = numberValue(summary.presentAssets);

  return {
    company: companyBase(company),
    project: projectBase(project),
    stats: {
      totalAssets,
      bySource: distribution(result.bySource),
      byCondition: distribution(result.byCondition),
      completion: {
        count: completedAssets,
        percent: percent(completedAssets, totalAssets),
      },
      presence: {
        count: presentAssets,
        percent: percent(presentAssets, totalAssets),
      },
      hasNotesCount: numberValue(summary.hasNotesCount),
      pendingReviewCount: numberValue(summary.pendingReviewCount),
      topCategories: distribution(result.topCategories),
      topDescriptions: distribution(result.topDescriptions),
    },
  };
}

export async function getProjectAssets(
  projectId: ObjectId,
  filters: AssetQueryFilters,
) {
  await getProjectForDefaultCompany(projectId);
  const database = await getDatabase();
  const match = await buildAssetMatch(projectId, filters);
  const skip = (filters.page - 1) * filters.pageSize;

  const result = await database
    .collection<Document>(COLLECTION.assets)
    .aggregate(
      [
        { $match: match },
        ...searchStages(filters.q),
        ...listNormalizationStages(),
        {
          $facet: {
            assets: [
              { $sort: assetSort(filters) },
              { $skip: skip },
              { $limit: filters.pageSize },
              {
                $project: {
                  _id: 1,
                  assetId: 1,
                  displayName: "$_displayName",
                  category: 1,
                  type: 1,
                  condition: 1,
                  asset_source: 1,
                  location: "$_location",
                  quantity: 1,
                  isPresent: 1,
                  isDone: 1,
                  hasNotes: 1,
                  parent: 1,
                  thumbnailUrl: "$_thumbnailUrl",
                  imageUrl: "$images.main.url",
                  updatedAt: 1,
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ],
      QUERY_OPTIONS,
    )
    .next();

  const facet = asRecord(result);
  const total = numberValue(asRecord(recordArray(facet.total)[0]).count);

  return {
    assets: recordArray(facet.assets).map(assetListItem),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / filters.pageSize),
    },
    total,
    nextCursor: filters.page * filters.pageSize < total ? String(filters.page + 1) : null,
  };
}

function optionFacet(field: string): Document[] {
  return [
    { $match: { [field]: { $type: "string", $ne: "" } } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: env.filterOptionsLimit },
  ];
}

function optionValues(value: unknown) {
  return recordArray(value).map((entry) => ({
    value: stringOrNull(entry._id) ?? UNKNOWN_VALUE,
    count: numberValue(entry.count),
  }));
}

function typeOptionFacet(categories: string[]): Document[] {
  return [
    ...(categories.length > 0 ? [{ $match: { category: { $in: categories } } }] : []),
    { $match: { type: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: { value: "$type", category: "$category" },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, "_id.category": 1, "_id.value": 1 } },
    { $limit: env.filterOptionsLimit },
  ];
}

function typeOptionValues(value: unknown) {
  return recordArray(value).map((entry) => {
    const key = asRecord(entry._id);
    return {
      value: stringOrNull(key.value) ?? UNKNOWN_VALUE,
      category: stringOrNull(key.category) ?? UNKNOWN_VALUE,
      count: numberValue(entry.count),
    };
  });
}

function folderOption(folder: PlainRecord) {
  const ancestors = recordArray(folder.ancestors)
    .sort((a, b) => numberValue(b.depth) - numberValue(a.depth))
    .map((entry) => ({ id: idValue(entry._id), name: stringOrNull(entry.name) ?? "بدون اسم" }));

  return {
    id: idValue(folder._id),
    name: stringOrNull(folder.name) ?? "بدون اسم",
    parentId: idValue(folder.parent),
    path: [...ancestors, { id: idValue(folder._id), name: stringOrNull(folder.name) ?? "بدون اسم" }],
  };
}

export async function getProjectFilterOptions(
  projectId: ObjectId,
  categories: string[],
) {
  await getProjectForDefaultCompany(projectId);
  const database = await getDatabase();
  const baseMatch = assetBaseMatch(projectId);
  const [assetOptions, folders] = await Promise.all([
    database
      .collection<Document>(COLLECTION.assets)
      .aggregate(
        [
          { $match: baseMatch },
          {
            $facet: {
              sources: optionFacet("asset_source"),
              conditions: optionFacet("condition"),
              categories: optionFacet("category"),
              types: typeOptionFacet(categories),
              employers: optionFacet("employer"),
            },
          },
        ],
        QUERY_OPTIONS,
      )
      .next(),
    database
      .collection<Document>(COLLECTION.items)
      .aggregate(
        [
          { $match: { projectId } },
          { $sort: { name: 1, _id: 1 } },
          { $limit: env.filterOptionsLimit },
          {
            $graphLookup: {
              from: COLLECTION.items,
              startWith: "$parent",
              connectFromField: "parent",
              connectToField: "_id",
              as: "ancestors",
              restrictSearchWithMatch: { projectId },
              depthField: "depth",
              maxDepth: 20,
            },
          },
          { $project: { _id: 1, name: 1, parent: 1, ancestors: 1 } },
        ],
        QUERY_OPTIONS,
      )
      .toArray(),
  ]);

  const result = asRecord(assetOptions);
  return {
    sources: optionValues(result.sources),
    conditions: optionValues(result.conditions),
    categories: optionValues(result.categories),
    types: typeOptionValues(result.types),
    employers: optionValues(result.employers),
    folders: folders.map((folder) => folderOption(asRecord(folder))),
    optionLimit: env.filterOptionsLimit,
  };
}

function auditUser(value: unknown) {
  const user = asRecord(value);
  const id = idValue(user._id);
  const displayName = stringOrNull(user.name) ?? stringOrNull(user.phone);

  return id && displayName ? { id, displayName } : null;
}

function sourceData(asset: PlainRecord) {
  const data: Record<string, unknown> = {};
  const clientCode = stringOrNull(asset.client_code);
  const isClientImport = stringOrNull(asset.asset_source) === "عميل";
  if (clientCode || isClientImport) {
    data.clientCode = clientCode;
  }

  if (isClientImport) {
    data.importId = idValue(asset.importId);
    data.sheetName = stringOrNull(asset.sheetName);
    data.rowIndex = numberOrNull(asset.rowIndex);
    data.status = stringOrNull(asset.status);
    data.importedAt = dateValue(asset.importedAt);
    data.normalizedData = toPlainValue(asset.normalizedData) ?? null;
    data.rawData = toPlainValue(asset.rawData) ?? null;
  }

  return Object.keys(data).length > 0 ? data : null;
}

function assetDetail(asset: PlainRecord) {
  const ancestors = recordArray(asset.ancestors)
    .sort((a, b) => numberValue(b.depth) - numberValue(a.depth))
    .map((entry) => ({
      id: idValue(entry._id),
      name: stringOrNull(entry.name) ?? "بدون اسم",
    }));

  const displayName = stringOrNull(asset.displayName) ?? "بدون اسم";
  return {
    id: idValue(asset._id),
    externalAssetId: stringOrNull(asset.assetId),
    displayName,
    description: toPlainValue(asset.asset_description) ?? null,
    source: stringOrNull(asset.asset_source),
    classification: {
      category: stringOrNull(asset.category),
      categoryId: stringOrNull(asset.categoryId),
      type: stringOrNull(asset.type),
      typeId: stringOrNull(asset.typeId),
      nameId: stringOrNull(asset.nameId),
    },
    quantity: numberOrNull(asset.quantity),
    condition: stringOrNull(asset.condition),
    brand: stringOrNull(asset.brand),
    model: stringOrNull(asset.model),
    manufactureYear: numberOrStringOrNull(asset.manufactureYear),
    kilometersDriven: numberOrStringOrNull(asset.kilometersDriven),
    codes: {
      code: stringOrNull(asset.code),
      clientCode: stringOrNull(asset.client_code),
    },
    employer: stringOrNull(asset.employer),
    location: stringOrNull(asset.location),
    flags: {
      isPresent: booleanOrNull(asset.isPresent),
      isDone: booleanOrNull(asset.isDone),
      hasNotes: booleanOrNull(asset.hasNotes),
      isAssetFolder: booleanOrNull(asset.isAssetFolder),
    },
    notes: stringOrNull(asset.notes),
    images: toPlainValue(asset.images) ?? null,
    voiceNotes: toPlainValue(asset.voiceNotes) ?? [],
    audit: {
      createdAt: dateValue(asset.createdAt),
      updatedAt: dateValue(asset.updatedAt),
      createdBy: auditUser(asset.createdByUser),
      updatedBy: auditUser(asset.updatedByUser),
    },
    breadcrumb: ancestors,
    sourceData: sourceData(asset),
  };
}

export async function getProjectAssetDetail(
  projectId: ObjectId,
  assetId: ObjectId,
) {
  await getProjectForDefaultCompany(projectId);
  const database = await getDatabase();

  const asset = await database
    .collection<Document>(COLLECTION.assets)
    .aggregate(
      [
        { $match: { ...assetBaseMatch(projectId), _id: assetId } },
        {
          $lookup: {
            from: COLLECTION.users,
            let: { userId: "$createdBy" },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
              { $project: { _id: 1, name: 1, phone: 1 } },
            ],
            as: "createdByUser",
          },
        },
        {
          $lookup: {
            from: COLLECTION.users,
            let: { userId: "$updatedBy" },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
              { $project: { _id: 1, name: 1, phone: 1 } },
            ],
            as: "updatedByUser",
          },
        },
        {
          $graphLookup: {
            from: COLLECTION.items,
            startWith: "$parent",
            connectFromField: "parent",
            connectToField: "_id",
            as: "ancestors",
            restrictSearchWithMatch: { projectId },
            depthField: "depth",
            maxDepth: 20,
          },
        },
        {
          $addFields: {
            displayName: { $ifNull: ["$name", "$lable"] },
            location: { $ifNull: ["$newAssetLocation", "$asset_location"] },
            createdByUser: { $arrayElemAt: ["$createdByUser", 0] },
            updatedByUser: { $arrayElemAt: ["$updatedByUser", 0] },
          },
        },
        {
          $project: {
            _id: 1,
            assetId: 1,
            displayName: 1,
            asset_description: 1,
            asset_source: 1,
            category: 1,
            categoryId: 1,
            type: 1,
            typeId: 1,
            nameId: 1,
            quantity: 1,
            condition: 1,
            brand: 1,
            model: 1,
            manufactureYear: 1,
            kilometersDriven: 1,
            code: 1,
            client_code: 1,
            employer: 1,
            location: 1,
            isPresent: 1,
            isDone: 1,
            hasNotes: 1,
            isAssetFolder: 1,
            notes: 1,
            images: 1,
            voiceNotes: 1,
            createdAt: 1,
            updatedAt: 1,
            createdByUser: 1,
            updatedByUser: 1,
            ancestors: 1,
            importId: 1,
            sheetName: 1,
            rowIndex: 1,
            status: 1,
            importedAt: 1,
            normalizedData: 1,
            rawData: 1,
          },
        },
      ],
      QUERY_OPTIONS,
    )
    .next();

  if (!asset) {
    throw new NotFoundError("Asset not found in this project.");
  }

  return { asset: assetDetail(asRecord(asset)) };
}

export async function getAssetExport(
  projectId: ObjectId,
  filters: AssetQueryFilters,
  limit: number,
) {
  await getProjectForDefaultCompany(projectId);
  const database = await getDatabase();
  const match = await buildAssetMatch(projectId, filters);

  const documents = await database
    .collection<Document>(COLLECTION.assets)
    .aggregate(
      [
        { $match: match },
        ...searchStages(filters.q),
        ...listNormalizationStages(),
        { $sort: assetSort(filters) },
        { $limit: limit + 1 },
        {
          $project: {
            _id: 1,
            assetId: 1,
            displayName: "$_displayName",
            category: 1,
            type: 1,
            condition: 1,
            asset_source: 1,
            location: "$_location",
            quantity: 1,
            isPresent: 1,
            isDone: 1,
            hasNotes: 1,
            updatedAt: 1,
          },
        },
      ],
      QUERY_OPTIONS,
    )
    .toArray();

  const truncated = documents.length > limit;
  return {
    assets: documents.slice(0, limit).map((document) => assetListItem(asRecord(document))),
    truncated,
  };
}
