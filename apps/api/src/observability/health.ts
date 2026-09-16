import type { FastifyInstance, FastifyPluginAsync } from "fastify";

export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean> | boolean;
}

export interface HealthPluginOptions {
  serviceName?: string;
  version?: string;
  readinessChecks?: ReadinessCheck[];
}

export const healthRoutes: FastifyPluginAsync<HealthPluginOptions> = async (
  fastify: FastifyInstance,
  options: HealthPluginOptions = {}
) => {
  const serviceName = options.serviceName || "guildpass-core-api";
  const version = options.version || "2.0.0";
  const readinessChecks = options.readinessChecks || [];

  // Liveness probe: returns 200 if process is running and event loop is responsive
  fastify.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      status: "ok",
      service: serviceName,
    });
  });

  // Readiness probe: verifies internal subsystems, memory limits, and external dependencies
  fastify.get("/ready", async (_request, reply) => {
    const memory = process.memoryUsage();
    const heapUsedMb = Math.round(memory.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(memory.heapTotal / 1024 / 1024);
    const memoryHealthy = heapUsedMb < 1500; // Under 1.5GB

    const checkResults: Record<string, { status: "pass" | "fail"; error?: string }> = {
      memory: {
        status: memoryHealthy ? "pass" : "fail",
      },
    };

    let allReady = memoryHealthy;

    for (const item of readinessChecks) {
      try {
        const passed = await item.check();
        checkResults[item.name] = { status: passed ? "pass" : "fail" };
        if (!passed) allReady = false;
      } catch (err) {
        checkResults[item.name] = {
          status: "fail",
          error: err instanceof Error ? err.message : "Check failed",
        };
        allReady = false;
      }
    }

    const statusCode = allReady ? 200 : 503;
    return reply.status(statusCode).send({
      status: allReady ? "ready" : "degraded",
      service: serviceName,
      version,
      timestamp: new Date().toISOString(),
      metrics: {
        heapUsedMb,
        heapTotalMb,
        uptimeSeconds: Math.floor(process.uptime()),
      },
      checks: checkResults,
    });
  });
};

(healthRoutes as any)[Symbol.for("skip-override")] = true;

export default healthRoutes;
