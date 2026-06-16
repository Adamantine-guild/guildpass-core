import { PrismaClient } from '@prisma/client';
import { config } from '../config';

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  }
  return prisma;
}
