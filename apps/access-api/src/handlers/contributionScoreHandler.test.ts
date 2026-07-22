import { createContributionScoreHandler } from './contributionScoreHandler';

jest.mock('../services/contributionService', () => ({
  recomputeAndPersist: jest.fn().mockResolvedValue({
    wallet: '0xabc123',
    communityId: 'community-1',
    score: { total: 10, breakdown: { tenure: 10 }, explanations: {} },
  }),
}));

import { recomputeAndPersist } from '../services/contributionService';

const mockRecompute = recomputeAndPersist as jest.MockedFunction<typeof recomputeAndPersist>;

describe('createContributionScoreHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should recompute score on BADGE_ASSIGNED event', async () => {
    const handler = createContributionScoreHandler({ db: {} as any });
    await handler({
      id: 'evt-1',
      eventType: 'BADGE_ASSIGNED',
      entityId: 'badge-1',
      entityType: 'Badge',
      communityId: 'community-1',
      payload: { wallet: '0xabc123', label: 'contributor' },
      createdAt: new Date(),
    });

    expect(mockRecompute).toHaveBeenCalledWith(
      expect.anything,
      '0xabc123',
      'community-1',
    );
  });

  it('should recompute score on ROLE_ASSIGNED event', async () => {
    const handler = createContributionScoreHandler({ db: {} as any });
    await handler({
      id: 'evt-2',
      eventType: 'ROLE_ASSIGNED',
      entityId: 'role-1',
      entityType: 'RoleAssignment',
      communityId: 'community-1',
      payload: { wallet: '0xabc123', role: 'contributor' },
      createdAt: new Date(),
    });

    expect(mockRecompute).toHaveBeenCalled();
  });

  it('should recompute score on MEMBER_ATTENDED event', async () => {
    const handler = createContributionScoreHandler({ db: {} as any });
    await handler({
      id: 'evt-3',
      eventType: 'MEMBER_ATTENDED',
      entityId: 'att-1',
      entityType: 'AttendanceRecord',
      communityId: 'community-1',
      payload: { wallet: '0xabc123', eventId: 'event-1' },
      createdAt: new Date(),
    });

    expect(mockRecompute).toHaveBeenCalled();
  });

  it('should not recompute on irrelevant events', async () => {
    const handler = createContributionScoreHandler({ db: {} as any });
    await handler({
      id: 'evt-4',
      eventType: 'RESOURCE_CREATED',
      entityId: 'res-1',
      entityType: 'Resource',
      communityId: 'community-1',
      payload: { wallet: '0xabc123' },
      createdAt: new Date(),
    });

    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('should not throw if recomputation fails', async () => {
    mockRecompute.mockRejectedValueOnce(new Error('DB error'));
    const handler = createContributionScoreHandler({ db: {} as any });

    await expect(
      handler({
        id: 'evt-5',
        eventType: 'BADGE_ASSIGNED',
        entityId: 'badge-1',
        entityType: 'Badge',
        communityId: 'community-1',
        payload: { wallet: '0xabc123', label: 'test' },
        createdAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('should skip events without wallet in payload', async () => {
    const handler = createContributionScoreHandler({ db: {} as any });
    await handler({
      id: 'evt-6',
      eventType: 'BADGE_ASSIGNED',
      entityId: 'badge-1',
      entityType: 'Badge',
      communityId: 'community-1',
      payload: {},
      createdAt: new Date(),
    });

    expect(mockRecompute).not.toHaveBeenCalled();
  });
});
