import type { PrismaClient } from '@prisma/client';
import type { Permission } from '@guildpass/shared-types';
import { getPrisma } from './prisma';

const PERMISSION_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$/;

export class CustomRoleServiceError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'CustomRoleServiceError';
  }
}

export interface CustomRoleInput {
  name: string;
  description?: string | null;
  parentRoleId?: string | null;
  permissions: Permission[];
}

export class CustomRoleService {
  constructor(private prisma: PrismaClient = getPrisma()) {}

  private present(role: any) {
    return {
      ...role,
      permissions: (role.permissions ?? []).map(
        (entry: { permission: Permission }) => entry.permission,
      ),
    };
  }

  private validate(input: CustomRoleInput): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(input.name)) {
      throw new CustomRoleServiceError('Role name must be 2-64 lowercase characters');
    }
    if (!Array.isArray(input.permissions) || input.permissions.some(
      (permission) => typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission),
    )) {
      throw new CustomRoleServiceError('Permissions must use resource:action names');
    }
  }

  async create(communityId: string, input: CustomRoleInput) {
    this.validate(input);
    if (input.parentRoleId) {
      const parent = await this.prisma.roleDefinition.findFirst({
        where: { id: input.parentRoleId, communityId },
      });
      if (!parent) throw new CustomRoleServiceError('Parent role not found', 404);
    }
    const role = await this.prisma.roleDefinition.create({
      data: {
        communityId,
        name: input.name,
        description: input.description,
        parentRoleId: input.parentRoleId,
        permissions: {
          create: [...new Set(input.permissions)].map((permission) => ({
            communityId,
            permission,
          })),
        },
      },
      include: { permissions: true },
    } as any);
    return this.present(role);
  }

  async list(communityId: string) {
    const roles = await this.prisma.roleDefinition.findMany({
      where: { communityId, builtInRole: null },
      include: { permissions: true },
      orderBy: { name: 'asc' },
    } as any);
    return roles.map((role: any) => this.present(role));
  }

  async get(communityId: string, id: string) {
    const role = await this.prisma.roleDefinition.findFirst({
      where: { id, communityId, builtInRole: null },
      include: { permissions: true },
    } as any);
    return role ? this.present(role) : null;
  }

  async update(communityId: string, id: string, input: CustomRoleInput) {
    this.validate(input);
    const existing = await this.get(communityId, id);
    if (!existing) throw new CustomRoleServiceError('Custom role not found', 404);
    if (input.parentRoleId === id) {
      throw new CustomRoleServiceError('A role cannot inherit from itself');
    }
    if (input.parentRoleId) {
      const parent = await this.prisma.roleDefinition.findFirst({
        where: { id: input.parentRoleId, communityId },
      });
      if (!parent) throw new CustomRoleServiceError('Parent role not found', 404);
    }
    const role = await this.prisma.roleDefinition.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        parentRoleId: input.parentRoleId,
        permissions: {
          deleteMany: {},
          create: [...new Set(input.permissions)].map((permission) => ({
            communityId,
            permission,
          })),
        },
      },
      include: { permissions: true },
    } as any);
    return this.present(role);
  }

  async remove(communityId: string, id: string): Promise<void> {
    const existing = await this.get(communityId, id);
    if (!existing) throw new CustomRoleServiceError('Custom role not found', 404);
    await this.prisma.roleDefinition.delete({ where: { id } });
  }

  async assign(communityId: string, roleId: string, wallet: string) {
    const role = await this.get(communityId, roleId);
    if (!role) throw new CustomRoleServiceError('Custom role not found', 404);
    const member = await this.prisma.member.findFirst({
      where: { communityId, wallet: { address: wallet.toLowerCase() } },
    });
    if (!member) throw new CustomRoleServiceError('Member not found', 404);
    const existing = await this.prisma.roleAssignment.findFirst({
      where: { memberId: member.id, roleDefinitionId: roleId },
    });
    if (existing) {
      return this.prisma.roleAssignment.update({
        where: { id: existing.id },
        data: { active: true },
      });
    }
    return this.prisma.roleAssignment.create({
      data: { memberId: member.id, roleDefinitionId: roleId, source: 'manual' },
    });
  }

  async unassign(communityId: string, roleId: string, wallet: string): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { communityId, wallet: { address: wallet.toLowerCase() } },
    });
    if (!member) throw new CustomRoleServiceError('Member not found', 404);
    await this.prisma.roleAssignment.deleteMany({
      where: { memberId: member.id, roleDefinitionId: roleId },
    });
  }
}
