import type { Server as HttpServer } from "node:http";

import {
  type ChangeStream,
  type ChangeStreamDocument,
  type Db,
  type Document,
  ObjectId,
} from "mongodb";
import { Server, type Socket } from "socket.io";

import { isCorsOriginAllowed } from "../config/cors";
import { env } from "../config/env";
import { getDatabase } from "../db/mongo";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const DEFAULT_COMPANY_OBJECT_ID = new ObjectId(env.defaultCompanyId);
const DASHBOARD_ROOM = "dashboard";

const WATCHED_COLLECTIONS = {
  asset: "assets",
  project: "mv_projects",
  item: "items",
  company: "companies",
  user: "users",
} as const;

type RealtimeEntity = keyof typeof WATCHED_COLLECTIONS;
type WatchedCollection = (typeof WATCHED_COLLECTIONS)[RealtimeEntity];
type RealtimeOperation = "insert" | "update" | "replace" | "delete";

export interface LiveUpdateEvent {
  projectId?: string;
  assetId?: string;
  entity: RealtimeEntity;
  operation: RealtimeOperation;
  occurredAt: string;
}

interface SubscriptionResult {
  ok: boolean;
  projectId?: string;
  error?: "INVALID_PROJECT_ID" | "PROJECT_NOT_FOUND";
}

type SubscriptionCallback = (result: SubscriptionResult) => void;

interface AssetScopeCache {
  assetProjectIds: Map<string, string>;
  assetUserIds: Map<string, string[]>;
  userAssetIds: Map<string, Set<string>>;
}

function projectRoom(projectId: string): string {
  return `project:${projectId}`;
}

function objectIdValue(value: unknown): string | undefined {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }

  if (typeof value === "string" && OBJECT_ID_PATTERN.test(value)) {
    return value.toLowerCase();
  }

  return undefined;
}

function idFromDocumentKey(change: ChangeStreamDocument<Document>): string | undefined {
  return "documentKey" in change ? objectIdValue(change.documentKey._id) : undefined;
}

function fullDocument(change: ChangeStreamDocument<Document>): Document | undefined {
  return "fullDocument" in change && change.fullDocument
    ? change.fullDocument
    : undefined;
}

function documentId(document: Document | undefined, field: string): string | undefined {
  return document ? objectIdValue(document[field]) : undefined;
}

function userIdsForAsset(asset: Document | undefined): string[] {
  const ids = [
    documentId(asset, "createdBy"),
    documentId(asset, "updatedBy"),
  ].filter((id): id is string => Boolean(id));

  return [...new Set(ids)];
}

function changeOperation(change: ChangeStreamDocument<Document>): RealtimeOperation | undefined {
  switch (change.operationType) {
    case "insert":
    case "update":
    case "replace":
    case "delete":
      return change.operationType;
    default:
      return undefined;
  }
}

function occurredAt(change: ChangeStreamDocument<Document>): string {
  const wallTime = (change as unknown as { wallTime?: unknown }).wallTime;
  return wallTime instanceof Date && !Number.isNaN(wallTime.getTime())
    ? wallTime.toISOString()
    : new Date().toISOString();
}

function projectIdFromSubscription(value: unknown): string | undefined {
  if (typeof value === "string") {
    return objectIdValue(value);
  }

  if (value && typeof value === "object" && "projectId" in value) {
    return objectIdValue((value as { projectId?: unknown }).projectId);
  }

  return undefined;
}

function acknowledge(callback: unknown, result: SubscriptionResult): void {
  if (typeof callback === "function") {
    (callback as SubscriptionCallback)(result);
  }
}

/**
 * Bridges scoped MongoDB Change Streams to Socket.IO rooms. It never writes to
 * MongoDB: the small in-memory maps exist solely to retain scope information
 * for delete events, whose Change Stream payload has no full document.
 */
export class LiveUpdates {
  private readonly streams = new Map<WatchedCollection, ChangeStream<Document>>();
  private defaultProjectIds = new Set<string>();
  private assetProjectIds = new Map<string, string>();
  private itemProjectIds = new Map<string, string>();
  private assetUserIds = new Map<string, string[]>();
  private userAssetIds = new Map<string, Set<string>>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private changeFlushTimer: NodeJS.Timeout | undefined;
  private pendingDashboardEvent: LiveUpdateEvent | undefined;
  private readonly pendingProjectEvents = new Map<string, LiveUpdateEvent>();
  private reconnectAttempt = 0;
  private restarting = false;
  private stopped = false;

  public constructor(private readonly io: Server) {
    this.io.on("connection", (socket) => {
      void socket.join(DASHBOARD_ROOM);

      socket.on("subscribe:project", (payload: unknown, callback?: SubscriptionCallback) => {
        void this.subscribeToProject(socket, payload, callback);
      });

      socket.on("unsubscribe:project", (payload: unknown, callback?: SubscriptionCallback) => {
        const projectId = projectIdFromSubscription(payload);
        if (!projectId) {
          acknowledge(callback, { ok: false, error: "INVALID_PROJECT_ID" });
          return;
        }

        void socket.leave(projectRoom(projectId));
        acknowledge(callback, { ok: true, projectId });
      });
    });
  }

  /** Starts Change Streams without making their availability a startup dependency. */
  public async start(): Promise<void> {
    this.stopped = false;
    await this.connectStreams();
  }

  /** Closes Socket.IO, all streams, and any scheduled reconnection attempt. */
  public async stop(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.changeFlushTimer) {
      clearTimeout(this.changeFlushTimer);
      this.changeFlushTimer = undefined;
    }
    this.pendingDashboardEvent = undefined;
    this.pendingProjectEvents.clear();

    await this.closeStreams();
    await this.io.close();
  }

  private async subscribeToProject(
    socket: Socket,
    payload: unknown,
    callback?: SubscriptionCallback,
  ): Promise<void> {
    const projectId = projectIdFromSubscription(payload);
    if (!projectId) {
      acknowledge(callback, { ok: false, error: "INVALID_PROJECT_ID" });
      return;
    }

    try {
      if (!(await this.isDefaultCompanyProject(projectId))) {
        acknowledge(callback, { ok: false, error: "PROJECT_NOT_FOUND" });
        return;
      }

      await socket.join(projectRoom(projectId));
      acknowledge(callback, { ok: true, projectId });
    } catch {
      // Keep the answer generic and avoid exposing database or tenancy details.
      acknowledge(callback, { ok: false, error: "PROJECT_NOT_FOUND" });
    }
  }

  private async connectStreams(): Promise<void> {
    if (this.stopped || this.streams.size > 0) {
      return;
    }

    try {
      const database = await getDatabase();
      await this.hydrateScopeCache(database);

      if (this.stopped) {
        return;
      }

      for (const collection of Object.values(WATCHED_COLLECTIONS)) {
        this.openStream(database, collection);
      }

      this.reconnectAttempt = 0;
      console.info("Live MongoDB updates are active.");
    } catch {
      await this.closeStreams();
      console.warn("Live MongoDB updates are unavailable; retrying in the background.");
      this.scheduleReconnect();
    }
  }

  private openStream(database: Db, collection: WatchedCollection): void {
    const stream = database.collection<Document>(collection).watch([], {
      fullDocument: "updateLookup",
      maxAwaitTimeMS: 30_000,
    });

    this.streams.set(collection, stream);

    stream.on("change", (change: ChangeStreamDocument<Document>) => {
      void this.handleChange(collection, change).catch(() => {
        // A single malformed change must not terminate a healthy Change Stream.
        console.warn("A live MongoDB update could not be processed.");
      });
    });

    const restart = (): void => {
      if (this.streams.get(collection) !== stream) {
        return;
      }

      void this.restartStreams();
    };

    stream.on("error", restart);
    stream.on("close", restart);
    stream.on("end", restart);
  }

  private async restartStreams(): Promise<void> {
    if (this.stopped || this.restarting) {
      return;
    }

    this.restarting = true;
    try {
      await this.closeStreams();
    } finally {
      this.restarting = false;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const exponent = Math.min(this.reconnectAttempt, 8);
    const delay = Math.min(
      env.realtimeRetryInitialMs * 2 ** exponent,
      env.realtimeRetryMaxMs,
    );
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectStreams();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async closeStreams(): Promise<void> {
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.allSettled(streams.map((stream) => stream.close()));
  }

  private async hydrateScopeCache(database: Db): Promise<void> {
    const defaultProjectIds = new Set<string>();
    const projectCursor = database
      .collection<Document>(WATCHED_COLLECTIONS.project)
      .find(
        { companyId: DEFAULT_COMPANY_OBJECT_ID },
        { projection: { _id: 1 }, maxTimeMS: env.mongoQueryTimeoutMs },
      );

    for await (const project of projectCursor) {
      const projectId = documentId(project, "_id");
      if (projectId) {
        defaultProjectIds.add(projectId);
      }
    }

    const assetScopeCache = await this.assetScopeCache(database, defaultProjectIds);
    const itemProjectIds = await this.projectDocumentMap(
      database,
      WATCHED_COLLECTIONS.item,
      defaultProjectIds,
    );

    this.defaultProjectIds = defaultProjectIds;
    this.assetProjectIds = assetScopeCache.assetProjectIds;
    this.itemProjectIds = itemProjectIds;
    this.assetUserIds = assetScopeCache.assetUserIds;
    this.userAssetIds = assetScopeCache.userAssetIds;
  }

  private async assetScopeCache(
    database: Db,
    projectIds: ReadonlySet<string>,
  ): Promise<AssetScopeCache> {
    const assetProjectIds = new Map<string, string>();
    const assetUserIds = new Map<string, string[]>();
    const userAssetIds = new Map<string, Set<string>>();
    const ids = [...projectIds].map((id) => new ObjectId(id));

    if (ids.length === 0) {
      return { assetProjectIds, assetUserIds, userAssetIds };
    }

    const cursor = database.collection<Document>(WATCHED_COLLECTIONS.asset).find(
      { projectId: { $in: ids } },
      {
        projection: { _id: 1, projectId: 1, createdBy: 1, updatedBy: 1 },
        maxTimeMS: env.mongoQueryTimeoutMs,
      },
    );

    for await (const asset of cursor) {
      const assetId = documentId(asset, "_id");
      const projectId = documentId(asset, "projectId");
      if (!assetId || !projectId) {
        continue;
      }

      assetProjectIds.set(assetId, projectId);
      const userIds = userIdsForAsset(asset);
      if (userIds.length > 0) {
        assetUserIds.set(assetId, userIds);
        for (const userId of userIds) {
          const assets = userAssetIds.get(userId) ?? new Set<string>();
          assets.add(assetId);
          userAssetIds.set(userId, assets);
        }
      }
    }

    return { assetProjectIds, assetUserIds, userAssetIds };
  }

  private async projectDocumentMap(
    database: Db,
    collection: typeof WATCHED_COLLECTIONS.asset | typeof WATCHED_COLLECTIONS.item,
    projectIds: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const ids = [...projectIds].map((id) => new ObjectId(id));

    if (ids.length === 0) {
      return map;
    }

    const cursor = database.collection<Document>(collection).find(
      { projectId: { $in: ids } },
      {
        projection: { _id: 1, projectId: 1 },
        maxTimeMS: env.mongoQueryTimeoutMs,
      },
    );

    for await (const document of cursor) {
      const id = documentId(document, "_id");
      const projectId = documentId(document, "projectId");
      if (id && projectId) {
        map.set(id, projectId);
      }
    }

    return map;
  }

  private async isDefaultCompanyProject(projectId: string): Promise<boolean> {
    if (this.defaultProjectIds.has(projectId)) {
      return true;
    }

    const database = await getDatabase();
    const project = await database.collection<Document>(WATCHED_COLLECTIONS.project).findOne(
      { _id: new ObjectId(projectId), companyId: DEFAULT_COMPANY_OBJECT_ID },
      { projection: { _id: 1 }, maxTimeMS: env.mongoQueryTimeoutMs },
    );

    if (!project) {
      return false;
    }

    this.defaultProjectIds.add(projectId);
    return true;
  }

  private async handleChange(
    collection: WatchedCollection,
    change: ChangeStreamDocument<Document>,
  ): Promise<void> {
    const operation = changeOperation(change);
    if (!operation) {
      return;
    }

    switch (collection) {
      case WATCHED_COLLECTIONS.asset:
        await this.handleProjectDocumentChange(
          change,
          operation,
          "asset",
          this.assetProjectIds,
          true,
        );
        return;
      case WATCHED_COLLECTIONS.item:
        await this.handleProjectDocumentChange(
          change,
          operation,
          "item",
          this.itemProjectIds,
          false,
        );
        return;
      case WATCHED_COLLECTIONS.project:
        await this.handleProjectChange(change, operation);
        return;
      case WATCHED_COLLECTIONS.company:
        this.handleCompanyChange(change, operation);
        return;
      case WATCHED_COLLECTIONS.user:
        await this.handleUserChange(change, operation);
        return;
    }
  }

  private async handleProjectDocumentChange(
    change: ChangeStreamDocument<Document>,
    operation: RealtimeOperation,
    entity: "asset" | "item",
    documentProjects: Map<string, string>,
    includeAssetId: boolean,
  ): Promise<void> {
    const id = idFromDocumentKey(change);
    if (!id) {
      return;
    }

    const document = fullDocument(change);
    const previousProjectId = documentProjects.get(id);
    const currentProjectId = documentId(document, "projectId");
    const previousIsInScope = previousProjectId
      ? await this.isDefaultCompanyProject(previousProjectId)
      : false;
    const currentIsInScope = currentProjectId
      ? await this.isDefaultCompanyProject(currentProjectId)
      : false;
    const payloadBase = {
      ...(includeAssetId ? { assetId: id } : {}),
      entity,
      operation,
      occurredAt: occurredAt(change),
    } as const;

    if (operation === "delete") {
      documentProjects.delete(id);
      if (includeAssetId) {
        this.replaceAssetUserReferences(id, []);
      }

      if (previousProjectId && previousIsInScope) {
        this.emitChange({ projectId: previousProjectId, ...payloadBase });
      }
      return;
    }

    // `updateLookup` normally supplies the post-image. If the database cannot
    // provide one for a non-delete operation, retain the last known scope and
    // still invalidate it instead of discarding a valid cache entry.
    if (!document && previousProjectId && previousIsInScope) {
      this.emitChange({ projectId: previousProjectId, ...payloadBase });
      return;
    }

    if (currentProjectId && currentIsInScope) {
      documentProjects.set(id, currentProjectId);
      if (includeAssetId && document) {
        this.replaceAssetUserReferences(id, userIdsForAsset(document));
      }

      // A moved asset/folder changes both project views. The dashboard event is
      // coalesced, while each affected project room receives one invalidation.
      if (
        previousProjectId &&
        previousProjectId !== currentProjectId &&
        previousIsInScope
      ) {
        this.emitChange({ projectId: previousProjectId, ...payloadBase });
      }

      this.emitChange({ projectId: currentProjectId, ...payloadBase });
      return;
    }

    if (previousProjectId && previousIsInScope) {
      documentProjects.delete(id);
      if (includeAssetId) {
        this.replaceAssetUserReferences(id, []);
      }
      this.emitChange({ projectId: previousProjectId, ...payloadBase });
    }
  }

  private async handleProjectChange(
    change: ChangeStreamDocument<Document>,
    operation: RealtimeOperation,
  ): Promise<void> {
    const projectId = idFromDocumentKey(change);
    if (!projectId) {
      return;
    }

    const document = fullDocument(change);
    const wasDefaultProject = this.defaultProjectIds.has(projectId);
    const belongsToDefaultCompany = document
      ? documentId(document, "companyId") === env.defaultCompanyId
      : wasDefaultProject;

    if (!belongsToDefaultCompany && !wasDefaultProject) {
      return;
    }

    if (operation === "delete" || !belongsToDefaultCompany) {
      this.defaultProjectIds.delete(projectId);
      this.removeProjectDocuments(projectId);
    } else {
      this.defaultProjectIds.add(projectId);
    }

    this.emitChange({
      projectId,
      entity: "project",
      operation,
      occurredAt: occurredAt(change),
    });
  }

  private handleCompanyChange(
    change: ChangeStreamDocument<Document>,
    operation: RealtimeOperation,
  ): void {
    const companyId = idFromDocumentKey(change);
    if (companyId !== env.defaultCompanyId) {
      return;
    }

    this.emitChange({
      entity: "company",
      operation,
      occurredAt: occurredAt(change),
    });
  }

  private async handleUserChange(
    change: ChangeStreamDocument<Document>,
    operation: RealtimeOperation,
  ): Promise<void> {
    const userId = idFromDocumentKey(change);
    if (!userId) {
      return;
    }

    const projectIds = await this.projectIdsForUser(userId);
    for (const projectId of projectIds) {
      this.emitChange({
        projectId,
        entity: "user",
        operation,
        occurredAt: occurredAt(change),
      });
    }
  }

  private async projectIdsForUser(userId: string): Promise<Set<string>> {
    const projectIds = new Set<string>();
    const cachedAssets = this.userAssetIds.get(userId);

    if (cachedAssets) {
      for (const assetId of cachedAssets) {
        const projectId = this.assetProjectIds.get(assetId);
        if (projectId) {
          projectIds.add(projectId);
        }
      }
    }

    if (projectIds.size > 0 || this.defaultProjectIds.size === 0) {
      return projectIds;
    }

    // The cache covers delete events and normal operation. This fallback also
    // catches a user change that arrives while a newly imported asset is not
    // yet present in the local cache.
    const database = await getDatabase();
    const defaultProjectObjectIds = [...this.defaultProjectIds].map(
      (projectId) => new ObjectId(projectId),
    );
    const cursor = database.collection<Document>(WATCHED_COLLECTIONS.asset).find(
      {
        projectId: { $in: defaultProjectObjectIds },
        $or: [{ createdBy: new ObjectId(userId) }, { updatedBy: new ObjectId(userId) }],
      },
      {
        projection: { _id: 1, projectId: 1, createdBy: 1, updatedBy: 1 },
        maxTimeMS: env.mongoQueryTimeoutMs,
      },
    );

    for await (const asset of cursor) {
      const assetId = documentId(asset, "_id");
      const projectId = documentId(asset, "projectId");
      if (!assetId || !projectId) {
        continue;
      }

      this.assetProjectIds.set(assetId, projectId);
      this.replaceAssetUserReferences(assetId, userIdsForAsset(asset));
      projectIds.add(projectId);
    }

    return projectIds;
  }

  private removeProjectDocuments(projectId: string): void {
    for (const [id, mappedProjectId] of this.assetProjectIds) {
      if (mappedProjectId === projectId) {
        this.assetProjectIds.delete(id);
        this.replaceAssetUserReferences(id, []);
      }
    }

    for (const [id, mappedProjectId] of this.itemProjectIds) {
      if (mappedProjectId === projectId) {
        this.itemProjectIds.delete(id);
      }
    }
  }

  private replaceAssetUserReferences(assetId: string, userIds: readonly string[]): void {
    const previousUserIds = this.assetUserIds.get(assetId) ?? [];
    for (const userId of previousUserIds) {
      const assetIds = this.userAssetIds.get(userId);
      if (!assetIds) {
        continue;
      }

      assetIds.delete(assetId);
      if (assetIds.size === 0) {
        this.userAssetIds.delete(userId);
      }
    }

    if (userIds.length === 0) {
      this.assetUserIds.delete(assetId);
      return;
    }

    const uniqueUserIds = [...new Set(userIds)];
    this.assetUserIds.set(assetId, uniqueUserIds);
    for (const userId of uniqueUserIds) {
      const assetIds = this.userAssetIds.get(userId) ?? new Set<string>();
      assetIds.add(assetId);
      this.userAssetIds.set(userId, assetIds);
    }
  }

  private emitChange(event: LiveUpdateEvent): void {
    this.pendingDashboardEvent = event;

    if (event.projectId) {
      this.pendingProjectEvents.set(event.projectId, event);
    }

    if (this.changeFlushTimer) {
      return;
    }

    this.changeFlushTimer = setTimeout(() => this.flushChanges(), 200);
    this.changeFlushTimer.unref();
  }

  private flushChanges(): void {
    this.changeFlushTimer = undefined;
    const dashboardEvent = this.pendingDashboardEvent;
    const projectEvents = [...this.pendingProjectEvents.entries()];
    this.pendingDashboardEvent = undefined;
    this.pendingProjectEvents.clear();

    if (this.stopped) {
      return;
    }

    if (dashboardEvent) {
      this.io.to(DASHBOARD_ROOM).emit("dashboard:changed", dashboardEvent);
    }

    for (const [projectId, event] of projectEvents) {
      this.io.to(projectRoom(projectId)).emit("project:changed", event);
    }
  }
}

/** Creates Socket.IO on the same HTTP server that serves the Express API. */
export function createLiveUpdates(httpServer: HttpServer): LiveUpdates {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        callback(null, isCorsOriginAllowed(origin));
      },
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "X-Request-Id"],
      maxAge: 600,
    },
    allowRequest(request, callback) {
      const origin = Array.isArray(request.headers.origin)
        ? request.headers.origin[0]
        : request.headers.origin;
      callback(null, isCorsOriginAllowed(origin));
    },
  });

  return new LiveUpdates(io);
}
