import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, ZodSchema } from 'zod';

/**
 * Wallet (Stellar public key) format:
 * - 56 characters
 * - Base32 alphabet: A-Z and 2-7 (no 0, 1, 8, 9)
 */
const STELLAR_WALLET_REGEX = /^[A-Z2-7]{56}$/i;

export const walletParamSchema = z.object({
  wallet: z
    .string({
      required_error: 'wallet is required',
      invalid_type_error: 'wallet must be a string',
    })
    .regex(STELLAR_WALLET_REGEX, 'wallet must be a valid 56-char Stellar public key (A-Z, 2-7)'),
});

export const communityIdParamSchema = z.object({
  communityId: z
    .string({
      required_error: 'communityId is required',
      invalid_type_error: 'communityId must be a string',
    })
    .min(1, 'communityId must not be empty')
    .max(256, 'communityId must be at most 256 characters'),
});

export const roleQuerySchema = z.object({
  role: z
    .enum(['admin', 'member', 'contributor'], {
      errorMap: () => ({ message: "role must be one of 'admin', 'member', or 'contributor'" }),
    })
    .optional(),
});

export const accessCheckBodySchema = z.object({
  wallet: z
    .string({
      required_error: 'wallet is required',
      invalid_type_error: 'wallet must be a string',
    })
    .regex(STELLAR_WALLET_REGEX, 'wallet must be a valid 56-char Stellar public key (A-Z, 2-7)'),
  communityId: z
    .string({
      required_error: 'communityId is required',
      invalid_type_error: 'communityId must be a string',
    })
    .min(1, 'communityId must not be empty')
    .max(256, 'communityId must be at most 256 characters'),
  resource: z
    .string({
      required_error: 'resource is required',
      invalid_type_error: 'resource must be a string',
    })
    .min(1, 'resource must not be empty')
    .max(256, 'resource must be at most 256 characters'),
});

export type WalletParam = z.infer<typeof walletParamSchema>;
export type CommunityIdParam = z.infer<typeof communityIdParamSchema>;
export type RoleQuery = z.infer<typeof roleQuerySchema>;
export type AccessCheckBody = z.infer<typeof accessCheckBodySchema>;

/**
 * Format a ZodError into the 400 response body used by the API.
 */
function formatZodError(error: ZodError) {
  return {
    message: 'Validation failed',
    errors: error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/**
 * Parse `req.params` with the given schema. On failure send a 400 reply
 * and return `null` so handlers can early-return.
 */
export function parseParams<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: ZodSchema<T>
): T | null {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    reply.code(400).send(formatZodError(result.error));
    return null;
  }
  return result.data;
}

/**
 * Parse `req.query` with the given schema.
 */
export function parseQuery<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: ZodSchema<T>
): T | null {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    reply.code(400).send(formatZodError(result.error));
    return null;
  }
  return result.data;
}

/**
 * Parse `req.body` with the given schema.
 */
export function parseBody<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: ZodSchema<T>
): T | null {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    reply.code(400).send(formatZodError(result.error));
    return null;
  }
  return result.data;
}
