# Assets Dashboard API

Standalone, **read-only** Express API for the Assets Dashboard. It is designed to be deployed on a different server from the frontend.

```
Browser → independently deployed frontend → HTTPS /api/v1 → this API → MongoDB Atlas
```

The browser never receives `MONGO_URL_SCRAPPING`, `MONGO_DBNAME_SCRAPPING`, or `DEFAULT_COMPANY_ID`. The frontend should contain only a public base URL, for example:

```env
NEXT_PUBLIC_API_BASE_URL=https://api.example.com
```

## Setup

Requires Node.js 20+.

```bash
cd backend
copy .env.example .env
npm install
npm run dev
```

Replace every placeholder in `.env` before starting. The server validates its environment at startup and pings MongoDB before accepting traffic.

| Variable | Purpose |
| --- | --- |
| `MONGO_URL_SCRAPPING` | Atlas connection string; backend-only secret. |
| `MONGO_DBNAME_SCRAPPING` | MongoDB database name. |
| `DEFAULT_COMPANY_ID` | 24-hex-character ObjectId for the dashboard's company. Backend-only scope. |
| `CORS_ORIGINS` | Comma-separated exact frontend origins, such as `https://dashboard.example.com`. |
| `PORT` | API port; defaults to `4000`. |
| `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `MAX_PAGE` | Paginated table limits. |
| `EXPORT_MAX_ROWS` | Per-export maximum; defaults to `10000`. |
| `FILTER_OPTIONS_LIMIT` | Maximum values returned for each filter group. |
| `MONGO_QUERY_TIMEOUT_MS` | Per-query Mongo time limit; defaults to `10000`. |
| `REALTIME_RETRY_INITIAL_MS`, `REALTIME_RETRY_MAX_MS` | Initial and maximum retry backoff, in milliseconds, for MongoDB Change Streams. |

Scripts:

```bash
npm run dev        # watch TypeScript source
npm run typecheck  # strict TypeScript check
npm run build      # emit dist/
npm start          # run dist/server.js
```

## Live updates (Socket.IO)

Socket.IO runs on the **same origin and port as this API** (for example,
`https://api.example.com`), not under `/api/v1`. Its CORS policy is the exact
same `CORS_ORIGINS` allowlist used by the REST API; the socket handshake is also
rejected server-side when its browser `Origin` is not on that list.

Every connected client automatically joins the `dashboard` room. A project page
can then subscribe only after the backend confirms that the project belongs to
the configured `DEFAULT_COMPANY_ID`:

```ts
socket.emit("subscribe:project", "66e...", (result) => {
  // { ok: true, projectId: "66e..." }
});

// The object form is accepted as well.
socket.emit("unsubscribe:project", { projectId: "66e..." });
```

`subscribe:project` and `unsubscribe:project` accept either a 24-character
ObjectId string or `{ projectId }`. An acknowledgement is optional. Invalid or
out-of-scope IDs receive `{ ok: false, error: "INVALID_PROJECT_ID" | "PROJECT_NOT_FOUND" }`.

The backend sends invalidation events only; clients should re-fetch their normal
REST data rather than treating the event as a complete document:

```ts
type LiveUpdateEvent = {
  projectId?: string;
  assetId?: string;
  entity: "asset" | "project" | "item" | "company" | "user";
  operation: "insert" | "update" | "replace" | "delete";
  occurredAt: string; // ISO-8601
};

socket.on("dashboard:changed", (event: LiveUpdateEvent) => { /* refresh dashboard */ });
socket.on("project:changed", (event: LiveUpdateEvent) => { /* refresh subscribed project */ });
```

MongoDB Change Streams observe `assets`, `mv_projects`, `items`, `companies`,
and `users`. Events are scope-checked against the default company, carry no raw
Mongo document, and are coalesced for roughly 200 ms (one dashboard invalidation
and one per affected project) to prevent a bulk import from causing a request
storm. If Change Streams are temporarily unavailable, the REST API remains up
and the backend reconnects with exponential backoff. Change Streams require a
replica set/Atlas deployment and a database role with Change Stream permission.

## API contract

Base path: `/api/v1`. All successful JSON responses use the envelope:

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "generatedAt": "2026-08-24T12:00:00.000Z"
  }
}
```

Errors keep the envelope and never reveal Mongo connection details:

```json
{
  "data": null,
  "meta": { "requestId": "uuid" },
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "pageSize must be between 1 and 100."
  }
}
```

`ObjectId` values are serialized as strings and valid dates as ISO-8601 strings. `null` means the underlying flexible Mongo document did not provide a usable value.

### Health

`GET /api/v1/healthz` returns `{ "data": { "status": "ok" } }` without a DB call.

`GET /api/v1/readyz` pings MongoDB and returns `{ "data": { "status": "ready" } }` when the API is ready to serve traffic.

### Company dashboard

`GET /companies/default/dashboard`

`default` is deliberately literal: it resolves only from backend-only `DEFAULT_COMPANY_ID`, never from a query parameter.

```json
{
  "data": {
    "company": {
      "id": "66d...",
      "name": "اسم الشركة",
      "logoDataUrl": "data:image/...",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-02T00:00:00.000Z"
    },
    "summary": {
      "projectCount": 3,
      "assetCount": 143,
      "completedAssetCount": 95,
      "completedPercent": 66.43,
      "presentAssetCount": 121,
      "presentPercent": 84.62
    },
    "projects": [
      {
        "id": "66e...",
        "name": "المشروع",
        "displayNumber": 12,
        "workflowStatus": "new",
        "assetCount": 34,
        "completedAssetCount": 22,
        "completedPercent": 64.71,
        "presentAssetCount": 29,
        "presentPercent": 85.29,
        "updatedAt": "2026-01-02T00:00:00.000Z"
      }
    ],
    "total": 143,
    "nextCursor": "2",
    "pagination": { "page": 1, "pageSize": 25, "total": 143, "totalPages": 6 }
  },
  "meta": { "requestId": "uuid", "generatedAt": "..." }
}
```

### Project metadata and statistics

`GET /projects/:id`

Returns `data.company` and `data.project`. A project is returned only when its `companyId` equals `DEFAULT_COMPANY_ID`.

`GET /projects/:id/overview`

Returns the same scoped company/project header plus:

```json
{
  "data": {
    "stats": {
      "totalAssets": 143,
      "bySource": [{ "value": "تطبيق", "count": 70 }],
      "byCondition": [{ "value": "Good", "count": 90 }],
      "completion": { "count": 95, "percent": 66.43 },
      "presence": { "count": 121, "percent": 84.62 },
      "hasNotesCount": 9,
      "pendingReviewCount": 4,
      "topCategories": [{ "value": "معدات", "count": 41 }]
    }
  }
}
```

Missing `asset_source`, `condition`, or `category` values are kept in the Arabic `غير محدد` bucket rather than silently discarded.

### Paginated asset table

`GET /projects/:id/assets`

Canonical query parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | Case-insensitive literal search (maximum 100 characters). Searches scalar name, `lable`, string/object description, category, type, codes, and employer fields. |
| `source`, `condition`, `category`, `type`, `employer` | Repeatable or comma-separated exact filters. |
| `isPresent`, `isDone`, `hasNotes` | `true` or `false`; omit for all. |
| `status` | Repeatable/comma-separated exact workflow/import status, e.g. `pending_review`. |
| `folderId` | Project-scoped item ObjectId. |
| `includeDescendants` | `true` by default; applies folder descendants through a project-restricted graph lookup. |
| `updatedFrom`, `updatedTo` | ISO-8601 UTC timestamps or `YYYY-MM-DD`; date-only end dates are inclusive. |
| `page`, `pageSize` | Positive page number and size; page is capped by `MAX_PAGE`, size by `MAX_PAGE_SIZE`. |
| `sortBy` | `displayName`, `updatedAt`, `condition`, `category`, `type`, `source`, or `quantity`. |
| `sortDir` | `asc` or `desc`. |

For compatibility with the separately built frontend, aliases are accepted: `search` for `q`, `present` for `isPresent`, `done` for `isDone`, `limit` for `pageSize`, `cursor` for a numeric page, and `sort=<field>:<asc|desc>` for `sortBy`/`sortDir` (`name` maps to `displayName`). The response publishes canonical filters plus `present` and `done` in `meta.appliedFilters`.

```json
{
  "data": {
    "assets": [
      {
        "id": "66f...",
        "externalAssetId": "66f...",
        "displayName": "سيارة خدمة",
        "category": "مركبات",
        "type": "سيارة",
        "condition": "Good",
        "source": "تطبيق",
        "location": "الرياض",
        "quantity": 1,
        "isPresent": true,
        "isDone": false,
        "hasNotes": false,
        "parentId": "670...",
        "thumbnailUrl": "https://...",
        "imageUrl": "https://...",
        "updatedAt": "2026-01-02T00:00:00.000Z"
      }
    ]
  },
  "meta": {
    "requestId": "uuid",
    "pagination": { "page": 1, "pageSize": 25, "total": 143, "totalPages": 6 },
    "total": 143,
    "nextCursor": "2",
    "appliedFilters": { "q": null, "source": [], "present": null, "done": null }
  }
}
```

`nextCursor` is a compatibility page token, not a Mongo cursor. Every sort has `_id` as a stable secondary key. Folder hierarchy is read from `items`; the API does not exclude documents by `isAssetFolder`, because some historical imports mark ordinary assets with that flag.

### Filter options

`GET /projects/:id/filter-options?category=معدات&category=مركبات`

Returns project-scoped option arrays:

```json
{
  "data": {
    "sources": [{ "value": "تطبيق", "count": 70 }],
    "conditions": [{ "value": "Good", "count": 90 }],
    "categories": [{ "value": "مركبات", "count": 41 }],
    "types": [{ "value": "سيارة", "category": "مركبات", "count": 20 }],
    "employers": [{ "value": "الإدارة", "count": 11 }],
    "folders": [{ "id": "...", "name": "الدور الأرضي", "parentId": "...", "path": [{ "id": "...", "name": "المبنى" }, { "id": "...", "name": "الدور الأرضي" }] }],
    "optionLimit": 250
  }
}
```

When `category` is supplied, only `types` is narrowed to those categories; the other option groups remain project-wide. Folder paths are root-to-folder and traversal is restricted to the same project.

### Asset detail

`GET /projects/:id/assets/:assetId`

Both IDs must be 24-character ObjectIds. The result is intentionally allowlisted rather than a raw Mongo document:

```json
{
  "data": {
    "asset": {
      "id": "...",
      "externalAssetId": "...",
      "displayName": "سيارة خدمة",
      "description": "...",
      "source": "عميل",
      "classification": { "category": "...", "categoryId": null, "type": "...", "typeId": null, "nameId": null },
      "quantity": 1,
      "condition": "Good",
      "brand": null,
      "model": null,
      "manufactureYear": null,
      "kilometersDriven": null,
      "codes": { "code": null, "clientCode": null },
      "employer": null,
      "location": null,
      "flags": { "isPresent": true, "isDone": false, "hasNotes": false, "isAssetFolder": false },
      "notes": null,
      "images": {},
      "voiceNotes": [],
      "audit": {
        "createdAt": "...",
        "updatedAt": "...",
        "createdBy": { "id": "...", "displayName": "اسم أو هاتف" },
        "updatedBy": null
      },
      "breadcrumb": [{ "id": "...", "name": "المبنى" }],
      "sourceData": {
        "clientCode": null,
        "importId": null,
        "sheetName": null,
        "rowIndex": null,
        "status": "pending_review",
        "importedAt": null,
        "normalizedData": {},
        "rawData": {}
      }
    }
  }
}
```

`sourceData.rawData` is returned only for assets whose source is `عميل`, because the brief explicitly requires it. It may contain imported personal or business information; see the security warning below.

Because imported records are schema-flexible, `manufactureYear` and `kilometersDriven` may be a number, a non-empty string, or `null`; the API preserves valid string values rather than coercing or discarding them.

### CSV export

`GET /projects/:id/assets/export.csv?<same filters>&limit=10000`

Uses the same validated filters and sort as the table. It returns UTF-8 CSV with a BOM for Excel compatibility, not the JSON envelope. It sends:

- `X-Export-Limit`: requested/effective limit.
- `X-Export-Truncated`: `true` if more matching data existed than the cap.
- `Content-Disposition`: safe attachment filename.

Cells beginning with `=`, `+`, `-`, or `@` are prefixed to protect spreadsheet users from formula injection. Raw imported data, notes, and audio URLs are not exported.

## Error and access rules

- Invalid IDs, booleans, dates, sort fields, caps, and malformed repeated parameters return `400` / `VALIDATION_ERROR`.
- A valid but cross-company or absent project/asset/folder returns `404`, avoiding cross-company existence disclosure.
- MongoDB is used only for reads. This project has no write routes and never creates indexes at startup.
- All project and asset endpoints first resolve the project with `{ _id, companyId: DEFAULT_COMPANY_ID }`; assets are never queried by a bare unscoped project ID.
- `CORS_ORIGINS` is an exact allowlist for browsers. **CORS is not authentication or authorization**: direct HTTP callers are not blocked by CORS.

This dashboard intentionally has no login. Therefore all fields sent by the API are effectively public to anyone who can reach it. If `rawData`, phone numbers, notes, audio URLs, or asset records are not intended to be public, put the API behind authentication, an IP/network allowlist, or a gateway before publishing it.

Apply TLS, request-rate limits, and any IP/authentication controls at the reverse proxy or API gateway. That is more reliable than an in-process limiter when the backend is deployed on multiple instances.

## Database operations and performance

The runtime Atlas account should have a `read` role only. No credentials are placed in client code, and the API does not perform `insert`, `update`, `delete`, `createIndex`, or migrations.

The data layer uses MongoDB aggregation rather than pulling full collections into Node:

- company dashboard: project-to-assets `$lookup` plus `$facet` summary;
- project KPIs: one asset `$facet` for totals and distributions;
- table: filtered `$match`, normalized fields, `$facet` rows and count;
- details/folders: project-restricted `$lookup` and `$graphLookup` with depth 20.

Ask a DBA to validate query plans and separately provision appropriate indexes, for example `mv_projects { companyId: 1, updatedAt: -1 }`, `assets { projectId: 1, updatedAt: -1, _id: 1 }`, and `items { projectId: 1, parent: 1 }`. Do not grant the API write permission merely to create indexes. For Arabic/fuzzy search at large scale, evaluate Atlas Search or a tested text-index strategy; the current search is an escaped, capped literal regex fallback for a read-only deployment.

## Deployment split

Deploy `backend/` as its own Node service and set its server-only environment variables in that platform. Deploy the frontend elsewhere and set only its public API base URL. Add the exact frontend production origin to `CORS_ORIGINS`; do not include a path or wildcard. Terminate TLS at the API host/reverse proxy and set `TRUST_PROXY=true` only when that proxy is trusted.
