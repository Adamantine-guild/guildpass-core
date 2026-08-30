import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { correlationPlugin, isValidCorrelationId } from "./correlation.js";
import { buildApp } from "../app.js";

describe("Correlation Plugin", () => {
  it("assigns a generated correlation ID when header is missing", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    const correlationHeader = response.headers["x-correlation-id"];
    assert.ok(typeof correlationHeader === "string");
    assert.ok(isValidCorrelationId(correlationHeader));
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    assert.ok(uuidRegex.test(correlationHeader));
  });

  it("propagates a valid client-provided correlation ID", async () => {
    const app = buildApp();
    const customId = "custom-correlation-id-12345";
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-correlation-id": customId,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-correlation-id"], customId);
  });

  it("rejects excessively long correlation IDs and replaces with generated UUID", async () => {
    const app = buildApp();
    const longId = "a".repeat(200);
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-correlation-id": longId,
      },
    });

    assert.equal(response.statusCode, 200);
    const resultHeader = response.headers["x-correlation-id"];
    assert.notEqual(resultHeader, longId);
    assert.ok(typeof resultHeader === "string");
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    assert.ok(uuidRegex.test(resultHeader));
  });

  it("rejects unsafe/malformed correlation IDs and replaces with generated UUID", async () => {
    const app = buildApp();
    const unsafeIds = [
      "bad\r\nheader: inject",
      "bad id with spaces",
      "<script>alert(1)</script>",
      "id\0withnull",
      "id; drop table;",
    ];

    for (const unsafeId of unsafeIds) {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          "x-correlation-id": unsafeId,
        },
      });

      assert.equal(response.statusCode, 200);
      const resultHeader = response.headers["x-correlation-id"];
      assert.notEqual(resultHeader, unsafeId);
      assert.ok(typeof resultHeader === "string");
      assert.ok(isValidCorrelationId(resultHeader));
    }
  });

  it("verifies that separate requests receive distinct generated IDs", async () => {
    const app = buildApp();
    const res1 = await app.inject({ method: "GET", url: "/health" });
    const res2 = await app.inject({ method: "GET", url: "/health" });

    const id1 = res1.headers["x-correlation-id"];
    const id2 = res2.headers["x-correlation-id"];

    assert.ok(id1);
    assert.ok(id2);
    assert.notEqual(id1, id2);
  });

  it("attaches the correlation ID to the Fastify request context and logger", async () => {
    const app = Fastify({ logger: false });
    let capturedCorrelationId = "";

    app.register(correlationPlugin);
    app.get("/test-context", async (request) => {
      capturedCorrelationId = request.correlationId;
      return { ok: true };
    });

    const customId = "context-test-id-99";
    const response = await app.inject({
      method: "GET",
      url: "/test-context",
      headers: {
        "x-correlation-id": customId,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(capturedCorrelationId, customId);
    assert.equal(response.headers["x-correlation-id"], customId);
  });

  it("preserves unrelated API response bodies", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      service: "guildpass-core-api",
    });
  });
});
