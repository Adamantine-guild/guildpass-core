import type { PrismaClient } from '@prisma/client';


export class ResourceServiceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'ResourceServiceError';
  }
}

function normalizeCommunityId(communityId: string): string {
  return communityId.trim();
}

function isValidCommunityId(communityId: string): boolean {
  return typeof communityId === 'string' && communityId.trim().length > 0;
}

function isValidResourceId(resourceId: string): boolean {
  // allow stable IDs that clients can reference; restrict to safe chars
  // (No slashes to avoid path segment ambiguity)
  return (
    typeof resourceId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(resourceId)
  );
}

function normalizeResourceId(resourceId: string): string {
  return resourceId.trim();
}

export type CreateResourceInput = {
  requesterWallet: string;
  communityId: string;
  resourceId: string;
  name: string;
  metadata?: unknown;
};

export type UpdateResourceInput = {
  requesterWallet: string;
  communityId: string;
  resourceId: string;
  name?: string;
  metadata?: unknown;
};

export type ArchiveResourceInput = {
  requesterWallet: string;
  communityId: string;
  resourceId: string;
};

export function getResourceService(prisma: PrismaClient) {
  const db = prisma;

  // Minimal auth helper: validate requester is an ACTIVE community admin.
  // We intentionally avoid importing memberService here to prevent circular deps.
  async function assertRequesterIsAdmin(communityId: string, requesterWallet: string) {
    const normalizedRequester = requesterWallet.trim().toLowerCase();
    const requesterWalletRecord = await db.wallet.findUnique({
      where: { address: normalizedRequester },
    });

    if (!requesterWalletRecord) {
      throw new ResourceServiceError('Unauthorized', 401);
    }

    const requesterMember = await db.member.findFirst({
      where: {
        walletId: requesterWalletRecord.id,
        communityId,
      },
      include: { roles: true },
    });

    const isAdmin =
      requesterMember?.roles?.some((r: any) => r.active && r.role === 'admin') ?? false;

    if (!isAdmin) {
      throw new ResourceServiceError('Forbidden', 403);
    }
  }

  return {
    async listResources(communityId: string): Promise<{
      communityId: string;
      resources: Array<{
        resourceId: string;
        name: string;
        metadata: any;
        archived: boolean;
      }>;
    }> {
      const normalizedCommunityId = normalizeCommunityId(communityId);
      if (!isValidCommunityId(normalizedCommunityId)) {
        throw new ResourceServiceError('Invalid community ID', 400);
      }

      const resources = await db.resource.findMany({
        where: { communityId: normalizedCommunityId },
        orderBy: { createdAt: 'desc' },
      });


      return {
        communityId: normalizedCommunityId,
        resources: resources.map((r: Resource) => ({
          resourceId: r.resourceId,
          name: r.name,
          metadata: r.metadata,
          archived: r.archived,
        })),
      };
    },

    async upsertResource(input: CreateResourceInput): Promise<{
      communityId: string;
      resourceId: string;
      name: string;
      metadata: any;
      archived: boolean;
      created: boolean;
    }> {
      const normalizedCommunityId = normalizeCommunityId(input.communityId);
      if (!isValidCommunityId(normalizedCommunityId)) {
        throw new ResourceServiceError('Invalid community ID', 400);
      }
      if (!isValidResourceId(input.resourceId)) {
        throw new ResourceServiceError('Invalid resourceId', 400);
      }
      const normalizedResourceId = normalizeResourceId(input.resourceId);
      const name = input.name?.trim();
      if (!name) {
        throw new ResourceServiceError('Invalid name', 400);
      }
      if (!input.requesterWallet || input.requesterWallet.trim().length === 0) {
        throw new ResourceServiceError('Unauthorized', 401);
      }

      await assertRequesterIsAdmin(normalizedCommunityId, input.requesterWallet);

      const existing = await db.resource.findUnique({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
      });

      const nowMetadata = input.metadata ?? null;

      if (existing) {
        await db.resource.update({
          where: {
            communityId_resourceId: {
              communityId: normalizedCommunityId,
              resourceId: normalizedResourceId,
            },
          },
          data: {
            name,
            metadata: nowMetadata,
            archived: false,
          },
        });

        const updated = await db.resource.findUnique({
          where: {
            communityId_resourceId: {
              communityId: normalizedCommunityId,
              resourceId: normalizedResourceId,
            },
          },
        });

        return {
          communityId: normalizedCommunityId,
          resourceId: normalizedResourceId,
          name: updated!.name,
          metadata: updated!.metadata,
          archived: updated!.archived,
          created: false,
        };
      }

      const created = await db.resource.create({
        data: {
          communityId: normalizedCommunityId,
          resourceId: normalizedResourceId,
          name,
          metadata: nowMetadata,
        },
      });

      return {
        communityId: normalizedCommunityId,
        resourceId: created.resourceId,
        name: created.name,
        metadata: created.metadata,
        archived: created.archived,
        created: true,
      };
    },

    async updateResource(input: UpdateResourceInput): Promise<{
      communityId: string;
      resourceId: string;
      name: string;
      metadata: any;
      archived: boolean;
    }> {
      const normalizedCommunityId = normalizeCommunityId(input.communityId);
      if (!isValidCommunityId(normalizedCommunityId)) {
        throw new ResourceServiceError('Invalid community ID', 400);
      }
      if (!isValidResourceId(input.resourceId)) {
        throw new ResourceServiceError('Invalid resourceId', 400);
      }
      const normalizedResourceId = normalizeResourceId(input.resourceId);

      if (!input.requesterWallet || input.requesterWallet.trim().length === 0) {
        throw new ResourceServiceError('Unauthorized', 401);
      }
      await assertRequesterIsAdmin(normalizedCommunityId, input.requesterWallet);

      const existing = await db.resource.findUnique({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
      });

      if (!existing) {
        throw new ResourceServiceError('Resource not found', 404);
      }

      const name = input.name != null ? input.name.trim() : undefined;
      if (name != null && !name) {
        throw new ResourceServiceError('Invalid name', 400);
      }

      const updated = await db.resource.update({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
        data: {
          ...(name != null ? { name } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      });

      return {
        communityId: normalizedCommunityId,
        resourceId: updated.resourceId,
        name: updated.name,
        metadata: updated.metadata,
        archived: updated.archived,
      };
    },

    async archiveResource(input: ArchiveResourceInput): Promise<{
      communityId: string;
      resourceId: string;
      archived: boolean;
    }> {
      const normalizedCommunityId = normalizeCommunityId(input.communityId);
      if (!isValidCommunityId(normalizedCommunityId)) {
        throw new ResourceServiceError('Invalid community ID', 400);
      }
      if (!isValidResourceId(input.resourceId)) {
        throw new ResourceServiceError('Invalid resourceId', 400);
      }
      const normalizedResourceId = normalizeResourceId(input.resourceId);

      if (!input.requesterWallet || input.requesterWallet.trim().length === 0) {
        throw new ResourceServiceError('Unauthorized', 401);
      }
      await assertRequesterIsAdmin(normalizedCommunityId, input.requesterWallet);

      const existing = await db.resource.findUnique({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
      });

      if (!existing) {
        throw new ResourceServiceError('Resource not found', 404);
      }

      await db.resource.update({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
        data: { archived: true },
      });

      return { communityId: normalizedCommunityId, resourceId: normalizedResourceId, archived: true };
    },

    async isResourceActive(communityId: string, resourceId: string): Promise<boolean> {
      const normalizedCommunityId = normalizeCommunityId(communityId);
      if (!isValidCommunityId(normalizedCommunityId)) return false;
      if (!isValidResourceId(resourceId)) return false;
      const normalizedResourceId = normalizeResourceId(resourceId);

      const res = await db.resource.findUnique({
        where: {
          communityId_resourceId: {
            communityId: normalizedCommunityId,
            resourceId: normalizedResourceId,
          },
        },
        select: { archived: true },
      });

      return !!res && !res.archived;
    },
  };
}

