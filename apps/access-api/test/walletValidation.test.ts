process.env.DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/guildpass";

import Fastify, { FastifyInstance } from "fastify";
import { walletParamGuard } from "../src/app";

// Classic EIP-55 test vector.
const VALID_LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const VALID_CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const MALFORMED = "0xnot-a-valid-address";

// Two representative wallet-bearing routes (real path shapes), mounted on a
// minimal app so the guard is exercised end-to-end. buildApp itself is not used
// here because an unrelated pre-existing bug (undefined resource route schemas)
// currently prevents the full app from booting.
const routes: Array<[string, (w: string) => string]> = [
  ["members/:wallet", (w) => `/v1/communities/comm-1/members/${w}`],
  ["memberships/:wallet", (w) => `/v1/communities/comm-1/memberships/${w}`],
];

describe("#173 walletParamGuard on wallet-bearing routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.addHook("preHandler", walletParamGuard);
    app.get(
      "/v1/communities/:communityId/members/:wallet",
      async () => ({ ok: true }),
    );
    app.get(
      "/v1/communities/:communityId/memberships/:wallet",
      async () => ({ ok: true }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  for (const [name, url] of routes) {
    describe(name, () => {
      it("rejects a malformed wallet with 400 INVALID_WALLET", async () => {
        const res = await app.inject({ method: "GET", url: url(MALFORMED) });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).code).toBe("INVALID_WALLET");
      });

      it("accepts a valid lowercase wallet (200)", async () => {
        const res = await app.inject({ method: "GET", url: url(VALID_LOWER) });
        expect(res.statusCode).toBe(200);
      });

      it("accepts a valid checksummed (mixed-case) wallet (200)", async () => {
        const res = await app.inject({ method: "GET", url: url(VALID_CHECKSUM) });
        expect(res.statusCode).toBe(200);
      });
    });
  }
});
