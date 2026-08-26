import cors from "cors";
import express from "express";

import { corsOptions } from "./config/cors";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { requestContext } from "./middleware/request-context";
import { apiRouter } from "./routes";

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", env.trustProxy);
app.use(requestContext);
app.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(cors(corsOptions));
app.use(express.json({ limit: "100kb" }));
app.use("/api/v1", apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);
