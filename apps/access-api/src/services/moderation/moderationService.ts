import { PrismaClient, AppealStatus } from '@prisma/client';
import { logEventTx } from '../auditService';

export class ModerationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ModerationError';
    this.statusCode = statusCode;
  }
}

export function getModerationService(prisma: PrismaClient) {
  /**
   * File an appeal for a suspended member
   */
  async function fileAppeal(walletAddress: string, communityId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      // Find member
      const member = await tx.member.findFirst({
        where: {
          communityId,
          wallet: { address: walletAddress.toLowerCase() },
        },
        include: {
          membership: true,
          wallet: true,
        },
      });

      if (!member) {
        throw new ModerationError('Member not found', 404);
      }

      if (!member.membership || member.membership.state !== 'suspended') {
        throw new ModerationError('Membership is not suspended', 400);
      }

      // Check if there's already an active appeal
      const existingAppeal = await tx.appeal.findFirst({
        where: {
          memberId: member.id,
          status: { in: ['filed', 'under_review'] },
        },
      });

      if (existingAppeal) {
        throw new ModerationError('An active appeal already exists for this member', 409);
      }

      const appeal = await tx.appeal.create({
        data: {
          memberId: member.id,
          reason,
          status: 'filed',
        },
      });

      // Log audit event
      await logEventTx(tx as any, {
        eventType: 'OTHER',
        walletId: walletAddress.toLowerCase(),
        communityId,
        decision: 'DENY',
        reasonCode: 'APPEAL_FILED',
        beforeState: { status: 'suspended' },
        afterState: { appealId: appeal.id, status: 'filed' },
      });

      return appeal;
    });
  }

  /**
   * Transition appeal status according to state machine rules
   */
  async function transitionAppeal(
    appealId: string,
    toStatus: AppealStatus,
    adminComment?: string,
    adminWallet?: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const appeal = await tx.appeal.findUnique({
        where: { id: appealId },
        include: {
          member: {
            include: {
              wallet: true,
              membership: true,
            },
          },
        },
      });

      if (!appeal) {
        throw new ModerationError('Appeal not found', 404);
      }

      const fromStatus = appeal.status;

      // Validate transition
      let isValid = false;
      if (fromStatus === 'filed' && toStatus === 'under_review') {
        isValid = true;
      } else if (fromStatus === 'under_review' && (toStatus === 'upheld' || toStatus === 'reinstated')) {
        isValid = true;
      }

      if (!isValid) {
        throw new ModerationError(`Invalid transition from ${fromStatus} to ${toStatus}`, 400);
      }

      // Update appeal
      const updatedAppeal = await tx.appeal.update({
        where: { id: appealId },
        data: {
          status: toStatus,
          adminComment: adminComment ?? appeal.adminComment,
        },
      });

      // Log transition audit event
      await logEventTx(tx as any, {
        eventType: 'OTHER',
        walletId: appeal.member.wallet.address,
        communityId: appeal.member.communityId,
        decision: toStatus === 'reinstated' ? 'ALLOW' : 'DENY',
        reasonCode: `APPEAL_TRANSITION_${toStatus.toUpperCase()}`,
        beforeState: { appealStatus: fromStatus },
        afterState: { appealStatus: toStatus, adminComment },
      });

      // If reinstated, trigger off-chain state change & outbox event
      if (toStatus === 'reinstated') {
        if (appeal.member.membership) {
          await tx.membership.update({
            where: { id: appeal.member.membership.id },
            data: { state: 'active' },
          });
        }

        // Emit outbox event
        await tx.outboxEvent.create({
          data: {
            eventType: 'MEMBERSHIP_REINSTATED',
            entityId: appeal.memberId,
            entityType: 'Member',
            communityId: appeal.member.communityId,
            status: 'pending',
            retryCount: 0,
            maxRetries: 5,
            nextRetryAt: new Date(),
            payload: {
              walletAddress: appeal.member.wallet.address,
              communityId: appeal.member.communityId,
              reinstatedAt: new Date().toISOString(),
              adminComment,
            },
          },
        });
      }

      return updatedAppeal;
    });
  }

  return {
    fileAppeal,
    transitionAppeal,
  };
}
