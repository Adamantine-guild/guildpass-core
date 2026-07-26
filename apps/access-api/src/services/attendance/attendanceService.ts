import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, AttendanceRecord } from '@prisma/client';

export interface IngestedAttendance {
  walletAddress: string;
  communityId: string;
  eventId: string;
  source: string;
  timestamp: Date;
}

export interface AttendanceSource {
  parseAndVerify(payload: unknown, headers?: Record<string, string>): Promise<IngestedAttendance>;
}

/**
 * Adapter for manual check-ins (e.g. from admin panel)
 */
export class ManualAttendanceAdapter implements AttendanceSource {
  async parseAndVerify(payload: any): Promise<IngestedAttendance> {
    if (!payload.walletAddress || !payload.communityId || !payload.eventId) {
      throw new Error('Invalid manual check-in payload: missing walletAddress, communityId, or eventId');
    }

    return {
      walletAddress: payload.walletAddress,
      communityId: payload.communityId,
      eventId: payload.eventId,
      source: 'manual',
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    };
  }
}

/**
 * Adapter for webhook ingestion with HMAC-SHA256 signature verification
 */
export class WebhookAttendanceAdapter implements AttendanceSource {
  constructor(private readonly secret: string) {}

  async parseAndVerify(payload: any, headers?: Record<string, string>): Promise<IngestedAttendance> {
    if (!headers) {
      throw new Error('Signature verification failed: missing headers');
    }

    const signature = headers['x-guildpass-signature'];
    const timestamp = headers['x-guildpass-timestamp'];
    const nonce = headers['x-guildpass-nonce'];

    if (!signature || !timestamp || !nonce) {
      throw new Error('Signature verification failed: missing required headers (signature, timestamp, nonce)');
    }

    const bodyString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const dataToSign = `${timestamp}.${nonce}.${bodyString}`;
    const expectedSignature = createHmac('sha256', this.secret).update(dataToSign).digest('hex');

    // Prevent timing attacks using constant-time comparison
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      throw new Error('Signature verification failed: invalid signature');
    }

    const parsedBody = typeof payload === 'string' ? JSON.parse(payload) : payload;

    if (!parsedBody.walletAddress || !parsedBody.communityId || !parsedBody.eventId) {
      throw new Error('Invalid webhook payload: missing walletAddress, communityId, or eventId');
    }

    return {
      walletAddress: parsedBody.walletAddress,
      communityId: parsedBody.communityId,
      eventId: parsedBody.eventId,
      source: 'webhook',
      timestamp: parsedBody.timestamp ? new Date(parsedBody.timestamp) : new Date(),
    };
  }
}

/**
 * Attendance ingestion pipeline service
 */
export function getAttendanceService(prisma: PrismaClient) {
  async function ingest(adapter: AttendanceSource, payload: unknown, headers?: Record<string, string>): Promise<AttendanceRecord> {
    const normalized = await adapter.parseAndVerify(payload, headers);
    const walletId = normalized.walletAddress.toLowerCase();

    return prisma.$transaction(async (tx) => {
      // Idempotency check: see if record already exists
      const existing = await tx.attendanceRecord.findUnique({
        where: {
          walletId_eventId_source: {
            walletId,
            eventId: normalized.eventId,
            source: normalized.source,
          },
        },
      });

      if (existing) {
        return existing;
      }

      // Create attendance record
      const record = await tx.attendanceRecord.create({
        data: {
          walletId,
          communityId: normalized.communityId,
          eventId: normalized.eventId,
          source: normalized.source,
          timestamp: normalized.timestamp,
        },
      });

      // Emit "MEMBER_ATTENDED" outbox event
      await tx.outboxEvent.create({
        data: {
          eventType: 'MEMBER_ATTENDED',
          entityId: record.id,
          entityType: 'AttendanceRecord',
          communityId: record.communityId,
          payload: {
            walletId: record.walletId,
            communityId: record.communityId,
            eventId: record.eventId,
            source: record.source,
            timestamp: record.timestamp.toISOString(),
          },
        },
      });

      return record;
    });
  }

  return {
    ingest,
  };
}
