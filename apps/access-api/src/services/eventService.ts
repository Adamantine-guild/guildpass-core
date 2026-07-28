import type { AttendanceMethod } from "@guildpass/shared-types";
import { logOutboxEventTx } from "./outboxService";

export class EventServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "EventServiceError";
  }
}

export interface EventMutationInput {
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date;
}

export interface AttendanceCheckInInput {
  communityId: string;
  eventId: string;
  wallet: string;
  method: AttendanceMethod;
  now?: Date;
}

function validateEventWindow(input: EventMutationInput): void {
  if (!input.title.trim()) {
    throw new EventServiceError("Event title is required", 400, "VALIDATION_ERROR");
  }
  if (
    Number.isNaN(input.startsAt.getTime()) ||
    Number.isNaN(input.endsAt.getTime()) ||
    input.endsAt <= input.startsAt
  ) {
    throw new EventServiceError(
      "endsAt must be later than startsAt",
      400,
      "INVALID_EVENT_WINDOW",
    );
  }
}

export class EventService {
  // Kept structurally typed so transaction-scoped Prisma clients and test
  // doubles can use the same service without widening the public API.
  constructor(private readonly prisma: any) {}

  async create(communityId: string, input: EventMutationInput) {
    validateEventWindow(input);
    return this.prisma.$transaction(async (tx: any) => {
      const event = await tx.event.create({
        data: { communityId, ...input, title: input.title.trim() },
      });
      await logOutboxEventTx(tx, {
        eventType: "EVENT_CREATED",
        entityId: event.id,
        entityType: "Event",
        communityId,
        payload: {
          eventId: event.id,
          title: event.title,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
        },
      });
      return event;
    });
  }

  async list(communityId: string) {
    return this.prisma.event.findMany({
      where: { communityId },
      orderBy: { startsAt: "desc" },
    });
  }

  async get(communityId: string, eventId: string) {
    return this.prisma.event.findFirst({
      where: { id: eventId, communityId },
    });
  }

  async update(
    communityId: string,
    eventId: string,
    input: EventMutationInput,
  ) {
    validateEventWindow(input);
    return this.prisma.$transaction(async (tx: any) => {
      const existing = await tx.event.findFirst({
        where: { id: eventId, communityId },
      });
      if (!existing) {
        throw new EventServiceError("Event not found", 404, "NOT_FOUND");
      }
      const event = await tx.event.update({
        where: { id: eventId },
        data: { ...input, title: input.title.trim() },
      });
      await logOutboxEventTx(tx, {
        eventType: "EVENT_UPDATED",
        entityId: event.id,
        entityType: "Event",
        communityId,
        payload: {
          eventId: event.id,
          title: event.title,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
        },
      });
      return event;
    });
  }

  async remove(communityId: string, eventId: string): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      const existing = await tx.event.findFirst({
        where: { id: eventId, communityId },
      });
      if (!existing) {
        throw new EventServiceError("Event not found", 404, "NOT_FOUND");
      }
      await tx.event.delete({ where: { id: eventId } });
      await logOutboxEventTx(tx, {
        eventType: "EVENT_DELETED",
        entityId: eventId,
        entityType: "Event",
        communityId,
        payload: { eventId, title: existing.title },
      });
    });
  }

  async checkIn(input: AttendanceCheckInInput) {
    const now = input.now ?? new Date();
    const wallet = input.wallet.toLowerCase();

    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const event = await tx.event.findFirst({
          where: { id: input.eventId, communityId: input.communityId },
        });
        if (!event) {
          throw new EventServiceError("Event not found", 404, "NOT_FOUND");
        }
        if (now < event.startsAt || now > event.endsAt) {
          throw new EventServiceError(
            "Check-in is only available while the event is active",
            409,
            "EVENT_NOT_ACTIVE",
          );
        }

        const member = await tx.member.findFirst({
          where: {
            communityId: input.communityId,
            wallet: { address: wallet },
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
        if (!member) {
          throw new EventServiceError(
            "An active community membership is required",
            404,
            "ACTIVE_MEMBER_NOT_FOUND",
          );
        }

        const attendance = await tx.eventAttendance.create({
          data: {
            eventId: event.id,
            walletId: member.walletId,
            checkedInAt: now,
            method: input.method,
          },
        });

        await logOutboxEventTx(tx as any, {
          eventType: "EVENT_ATTENDANCE_RECORDED",
          entityId: attendance.id,
          entityType: "EventAttendance",
          communityId: input.communityId,
          payload: {
            attendanceId: attendance.id,
            eventId: event.id,
            wallet,
            walletId: member.walletId,
            checkedInAt: attendance.checkedInAt.toISOString(),
            method: attendance.method,
          },
        });

        return { ...attendance, wallet };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw new EventServiceError(
          "Member has already checked in to this event",
          409,
          "DUPLICATE_CHECK_IN",
        );
      }
      throw error;
    }
  }

  async listMemberAttendance(communityId: string, walletAddress: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { address: walletAddress.toLowerCase() },
    });
    if (!wallet) return [];

    const records = await this.prisma.eventAttendance.findMany({
      where: {
        walletId: wallet.id,
        event: { communityId },
      },
      include: { event: true },
      orderBy: { checkedInAt: "desc" },
    });
    return records.map((record: any) => ({
      ...record,
      wallet: wallet.address,
    }));
  }
}
