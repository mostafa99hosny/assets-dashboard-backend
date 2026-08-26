import { Router } from "express";

import { verifyDatabaseConnection } from "../db/mongo";
import { sendData } from "../utils/api-response";
import { asyncHandler } from "../utils/async-handler";
import { companiesRouter } from "./companies";
import { projectsRouter } from "./projects";

export const apiRouter = Router();

apiRouter.get("/healthz", (_request, response) =>
  sendData(response, 200, { status: "ok" }),
);

apiRouter.get(
  "/readyz",
  asyncHandler(async (_request, response) => {
    await verifyDatabaseConnection();
    return sendData(response, 200, { status: "ready" });
  }),
);

apiRouter.use(companiesRouter);
apiRouter.use(projectsRouter);
