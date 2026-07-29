import Fastify from "fastify";
import { registerEventRoutes } from "./eventRoutes";
import { EventServiceError } from "../services/eventService";

const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const event = {
  id: "event-1",
  communityId: "community-1",
  title: "Community call",
  description: null,
  startsAt: new Date("2026-07-28T11:00:00.000Z"),
  endsAt: new Date("2026-07-28T13:00:00.000Z"),
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

function buildTestApp(serviceOverrides: Record<string, unknown> = {}) {
  const app = Fastify();
  const service: any = {
    create: jest.fn().mockResolvedValue(event),
    list: jest.fn().mockResolvedValue([event]),
    get: jest.fn().mockResolvedValue(event),
    update: jest.fn().mockResolvedValue(event),
    remove: jest.fn().mockResolvedValue(undefined),
    checkIn: jest.fn().mockResolvedValue({
      id: "attendance-1",
      eventId: event.id,
      walletId: "wallet-id-1",
      wallet: MEMBER,
      checkedInAt: new Date("2026-07-28T12:00:00.000Z"),
      method: "manual",
    }),
    listMemberAttendance: jest.fn().mockResolvedValue([]),
    ...serviceOverrides,
  };
  registerEventRoutes(app, {
    service,
    requireCommunityAdmin: async (_communityId, wallet) =>
      wallet.toLowerCase() === ADMIN,
    getRequesterWallet: (request) => String(request.headers["x-wallet"] ?? ""),
  });
  return { app, service };
}

const auth = (wallet: string) => ({
  "x-api-key": "test-api-key",
  "x-wallet": wallet,
});

describe("event routes", () => {
  test("allows a community admin to create an event", async () => {
    const { app, service } = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/events",
      headers: auth(ADMIN),
      payload: {
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      "community-1",
      expect.objectContaining({
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
      }),
    );
    await app.close();
  });

  test("rejects non-admin event creation", async () => {
    const { app, service } = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/communities/community-1/events",
      headers: auth(MEMBER),
      payload: {
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
    await app.close();
  });

  test("checks a member into an event", async () => {
    const { app, service } = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/v1/communities/community-1/events/${event.id}/attend`,
      headers: auth(MEMBER),
      payload: { method: "manual" },
    });

    expect(response.statusCode).toBe(201);
    expect(service.checkIn).toHaveBeenCalledWith({
      communityId: "community-1",
      eventId: event.id,
      wallet: MEMBER,
      method: "manual",
    });
    await app.close();
  });

  test("returns 409 for a duplicate check-in", async () => {
    const duplicate = new EventServiceError(
      "Member has already checked in to this event",
      409,
      "DUPLICATE_CHECK_IN",
    );
    const { app } = buildTestApp({
      checkIn: jest.fn().mockRejectedValue(duplicate),
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/communities/community-1/events/${event.id}/attend`,
      headers: auth(MEMBER),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "DUPLICATE_CHECK_IN" },
    });
    await app.close();
  });

  test("prevents a member from checking in another wallet", async () => {
    const { app, service } = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/v1/communities/community-1/events/${event.id}/attend`,
      headers: auth(MEMBER),
      payload: { wallet: ADMIN },
    });

    expect(response.statusCode).toBe(403);
    expect(service.checkIn).not.toHaveBeenCalled();
    await app.close();
  });
});
