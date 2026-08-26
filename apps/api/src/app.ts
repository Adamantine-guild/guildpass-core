import Fastify from "fastify";
import { correlationPlugin } from "./plugins/correlation.js";

export function buildApp() {
  const app = Fastify({
    logger: true
  });

  app.register(correlationPlugin);

  app.get("/health", async () => {
    return {
      status: "ok",
      service: "guildpass-core-api"
    };
  });

  return app;
}

