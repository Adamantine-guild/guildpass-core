import { createHmac } from 'node:crypto';
import {
  getAttendanceService,
  ManualAttendanceAdapter,
  WebhookAttendanceAdapter,
} from '../src/services/attendance/attendanceService';

// ---------------------------------------------------------------------------
// Mock Prisma Client
// ---------------------------------------------------------------------------

const mockPrisma: any = {
  attendanceRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  outboxEvent: {
    create: jest.fn(),
  },
};

mockPrisma.$transaction = jest.fn((cb: any) => cb(mockPrisma));

jest.mock('../src/services/prisma', () => ({
  getPrisma: () => mockPrisma,
}));

describe('Event Attendance Ingestion Pipeline', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const communityId = 'community-test';
  const eventId = 'event-123';
  const secret = 'webhook-signing-secret';

  let attendanceService: ReturnType<typeof getAttendanceService>;

  beforeEach(() => {
    attendanceService = getAttendanceService(mockPrisma as any);
    jest.clearAllMocks();
  });

  describe('ManualAttendanceAdapter', () => {
    const adapter = new ManualAttendanceAdapter();

    test('should parse and verify valid manual payload', async () => {
      const payload = {
        walletAddress: wallet,
        communityId,
        eventId,
        timestamp: '2026-07-01T12:00:00Z',
      };

      const result = await adapter.parseAndVerify(payload);

      expect(result.walletAddress).toBe(wallet);
      expect(result.eventId).toBe(eventId);
      expect(result.source).toBe('manual');
      expect(result.timestamp.toISOString()).toBe('2026-07-01T12:00:00.000Z');
    });

    test('should reject manual payload if missing walletAddress', async () => {
      const payload = {
        communityId,
        eventId,
      };

      await expect(adapter.parseAndVerify(payload)).rejects.toThrow('missing walletAddress');
    });
  });

  describe('WebhookAttendanceAdapter', () => {
    const adapter = new WebhookAttendanceAdapter(secret);

    test('should parse and verify webhook with valid signature and headers', async () => {
      const payload = {
        walletAddress: wallet,
        communityId,
        eventId,
        timestamp: '2026-07-01T12:00:00Z',
      };

      const bodyString = JSON.stringify(payload);
      const timestamp = '1782800000000';
      const nonce = 'random-uuid';
      const dataToSign = `${timestamp}.${nonce}.${bodyString}`;
      const signature = createHmac('sha256', secret).update(dataToSign).digest('hex');

      const headers = {
        'x-guildpass-signature': signature,
        'x-guildpass-timestamp': timestamp,
        'x-guildpass-nonce': nonce,
      };

      const result = await adapter.parseAndVerify(payload, headers);

      expect(result.walletAddress).toBe(wallet);
      expect(result.eventId).toBe(eventId);
      expect(result.source).toBe('webhook');
    });

    test('should reject webhook with invalid signature', async () => {
      const payload = {
        walletAddress: wallet,
        communityId,
        eventId,
      };

      const headers = {
        'x-guildpass-signature': 'invalid-sig',
        'x-guildpass-timestamp': '1782800000000',
        'x-guildpass-nonce': 'random-uuid',
      };

      await expect(adapter.parseAndVerify(payload, headers)).rejects.toThrow('invalid signature');
    });
  });

  describe('Ingestion Service & Idempotency', () => {
    const manualAdapter = new ManualAttendanceAdapter();

    test('should create attendance record and emit outbox event on first ingestion', async () => {
      mockPrisma.attendanceRecord.findUnique.mockResolvedValue(null);
      mockPrisma.attendanceRecord.create.mockResolvedValue({
        id: 'record-abc',
        walletId: wallet.toLowerCase(),
        communityId,
        eventId,
        source: 'manual',
        timestamp: new Date('2026-07-01T12:00:00Z'),
      });

      const payload = {
        walletAddress: wallet,
        communityId,
        eventId,
        timestamp: '2026-07-01T12:00:00Z',
      };

      const result = await attendanceService.ingest(manualAdapter, payload);

      expect(result.id).toBe('record-abc');
      expect(mockPrisma.attendanceRecord.create).toHaveBeenCalled();
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'MEMBER_ATTENDED',
          entityType: 'AttendanceRecord',
          communityId,
        }),
      }));
    });

    test('should return existing record idempotently and skip outbox creation on duplicate', async () => {
      const existingRecord = {
        id: 'record-abc',
        walletId: wallet.toLowerCase(),
        communityId,
        eventId,
        source: 'manual',
      };

      mockPrisma.attendanceRecord.findUnique.mockResolvedValue(existingRecord);

      const payload = {
        walletAddress: wallet,
        communityId,
        eventId,
      };

      const result = await attendanceService.ingest(manualAdapter, payload);

      expect(result).toBe(existingRecord);
      expect(mockPrisma.attendanceRecord.create).not.toHaveBeenCalled();
      expect(mockPrisma.outboxEvent.create).not.toHaveBeenCalled();
    });
  });
});
