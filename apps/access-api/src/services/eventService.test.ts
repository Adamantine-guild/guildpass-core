import { EventService, EventServiceError } from "./eventService";

const now = new Date("2026-07-28T12:00:00.000Z");
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

function makePrisma() {
  const tx: any = {
    event: {
      findFirst: jest.fn().mockResolvedValue(event),
      create: jest.fn().mockResolvedValue(event),
      update: jest.fn().mockResolvedValue(event),
      delete: jest.fn().mockResolvedValue(event),
    },
    member: {
      findFirst: jest.fn().mockResolvedValue({
        id: "member-1",
        walletId: "wallet-id-1",
        wallet: { id: "wallet-id-1", address: "0x1111111111111111111111111111111111111111" },
      }),
    },
    eventAttendance: {
      create: jest.fn().mockResolvedValue({
        id: "attendance-1",
        eventId: event.id,
        walletId: "wallet-id-1",
        checkedInAt: now,
        method: "qr",
      }),
      findMany: jest.fn(),
    },
    outboxEvent: {
      create: jest.fn().mockResolvedValue({ id: "outbox-1" }),
    },
  };
  const prisma: any = {
    ...tx,
    event: {
      ...tx.event,
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback: (client: any) => unknown) => callback(tx)),
    _tx: tx,
  };
  return prisma;
}

describe("EventService check-in pipeline", () => {
  test("creates an event and its outbox event in one transaction", async () => {
    const prisma = makePrisma();
    const service = new EventService(prisma);

    await expect(service.create(event.communityId, {
      title: event.title,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    })).resolves.toEqual(event);

    expect(prisma._tx.event.create).toHaveBeenCalled();
    expect(prisma._tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "EVENT_CREATED",
        entityId: event.id,
        entityType: "Event",
        communityId: event.communityId,
      }),
    });
  });

  test("records attendance and writes its outbox event transactionally", async () => {
    const prisma = makePrisma();
    const service = new EventService(prisma);

    const result = await service.checkIn({
      communityId: event.communityId,
      eventId: event.id,
      wallet: "0x1111111111111111111111111111111111111111",
      method: "qr",
      now,
    });

    expect(result.id).toBe("attendance-1");
    expect(prisma._tx.member.findFirst).toHaveBeenCalledWith({
      where: {
        communityId: event.communityId,
        wallet: { address: "0x1111111111111111111111111111111111111111" },
        membership: {
          state: "active",
          OR: [
            { expiresAt: null },
            { expiresAt: { gte: now } },
          ],
        },
      },
      include: { wallet: true },
    });
    expect(prisma._tx.eventAttendance.create).toHaveBeenCalledWith({
      data: {
        eventId: event.id,
        walletId: "wallet-id-1",
        checkedInAt: now,
        method: "qr",
      },
    });
    expect(prisma._tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "EVENT_ATTENDANCE_RECORDED",
        entityId: "attendance-1",
        entityType: "EventAttendance",
        communityId: event.communityId,
        status: "pending",
        payload: expect.objectContaining({
          eventId: event.id,
          walletId: "wallet-id-1",
          method: "qr",
        }),
      }),
    });
  });

  test.each([
    ["before", new Date("2026-07-28T10:59:59.999Z")],
    ["after", new Date("2026-07-28T13:00:00.001Z")],
  ])("rejects check-in %s the active event window", async (_label, checkInTime) => {
    const prisma = makePrisma();
    const service = new EventService(prisma);

    await expect(service.checkIn({
      communityId: event.communityId,
      eventId: event.id,
      wallet: "0x1111111111111111111111111111111111111111",
      method: "manual",
      now: checkInTime,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "EVENT_NOT_ACTIVE",
    });
    expect(prisma._tx.eventAttendance.create).not.toHaveBeenCalled();
  });

  test("permits check-in exactly at both event boundaries", async () => {
    for (const checkInTime of [event.startsAt, event.endsAt]) {
      const prisma = makePrisma();
      const service = new EventService(prisma);
      await expect(service.checkIn({
        communityId: event.communityId,
        eventId: event.id,
        wallet: "0x1111111111111111111111111111111111111111",
        method: "manual",
        now: checkInTime,
      })).resolves.toMatchObject({ id: "attendance-1" });
    }
  });

  test("rejects wallets without an active community membership", async () => {
    const prisma = makePrisma();
    prisma._tx.member.findFirst.mockResolvedValue(null);
    const service = new EventService(prisma);

    await expect(service.checkIn({
      communityId: event.communityId,
      eventId: event.id,
      wallet: "0x1111111111111111111111111111111111111111",
      method: "manual",
      now,
    })).rejects.toMatchObject({
      statusCode: 404,
      code: "ACTIVE_MEMBER_NOT_FOUND",
    });
    expect(prisma._tx.eventAttendance.create).not.toHaveBeenCalled();
  });

  test("maps the unique event/member constraint to duplicate check-in conflict", async () => {
    const prisma = makePrisma();
    prisma._tx.eventAttendance.create.mockRejectedValue({ code: "P2002" });
    const service = new EventService(prisma);

    await expect(service.checkIn({
      communityId: event.communityId,
      eventId: event.id,
      wallet: "0x1111111111111111111111111111111111111111",
      method: "signed_message",
      now,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "DUPLICATE_CHECK_IN",
    });
    expect(prisma._tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  test("lists attendance scoped to both wallet and community", async () => {
    const prisma = makePrisma();
    prisma.wallet.findUnique.mockResolvedValue({
      id: "wallet-id-1",
      address: "0x1111111111111111111111111111111111111111",
    });
    prisma.eventAttendance.findMany.mockResolvedValue([{
      id: "attendance-1",
      eventId: event.id,
      walletId: "wallet-id-1",
      checkedInAt: now,
      method: "manual",
      event,
    }]);
    const service = new EventService(prisma);

    const history = await service.listMemberAttendance(
      event.communityId,
      "0x1111111111111111111111111111111111111111",
    );

    expect(prisma.eventAttendance.findMany).toHaveBeenCalledWith({
      where: {
        walletId: "wallet-id-1",
        event: { communityId: event.communityId },
      },
      include: { event: true },
      orderBy: { checkedInAt: "desc" },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      eventId: event.id,
      wallet: "0x1111111111111111111111111111111111111111",
    });
  });

  test("validates event windows on creation", async () => {
    const prisma = makePrisma();
    const service = new EventService(prisma);

    await expect(service.create("community-1", {
      title: "Invalid",
      startsAt: now,
      endsAt: now,
    })).rejects.toBeInstanceOf(EventServiceError);
    expect(prisma._tx.event.create).not.toHaveBeenCalled();
  });
});
