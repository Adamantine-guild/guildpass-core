import { ethers } from "ethers";

export interface SiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

/**
 * Parse standard EIP-4361 (Sign-In with Ethereum) messages.
 */
export function parseSiweMessage(message: string): SiweMessage {
  const lines = message.split("\n");
  
  const headerMatch = lines[0].match(/^([^ ]+) wants you to sign in with your Ethereum account:$/);
  if (!headerMatch) {
    throw new Error("Invalid SIWE header format");
  }
  const domain = headerMatch[1];
  
  const address = lines[1]?.trim();
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Invalid SIWE address format");
  }
  
  const uriMatch = message.match(/URI: (.+)/);
  const versionMatch = message.match(/Version: (.+)/);
  const chainIdMatch = message.match(/Chain ID: (\d+)/);
  const nonceMatch = message.match(/Nonce: ([a-zA-Z0-9]+)/);
  const issuedAtMatch = message.match(/Issued At: (.+)/);
  const expirationTimeMatch = message.match(/Expiration Time: (.+)/);
  
  if (!uriMatch || !versionMatch || !chainIdMatch || !nonceMatch || !issuedAtMatch) {
    throw new Error("Missing required SIWE fields");
  }
  
  return {
    domain,
    address,
    uri: uriMatch[1].trim(),
    version: versionMatch[1].trim(),
    chainId: parseInt(chainIdMatch[1].trim(), 10),
    nonce: nonceMatch[1].trim(),
    issuedAt: issuedAtMatch[1].trim(),
    expirationTime: expirationTimeMatch ? expirationTimeMatch[1].trim() : undefined,
  };
}

/**
 * Verifies a SIWE signature and returns the verified Ethereum address on success.
 */
export function verifySiweSignature(message: string, signature: string, expectedNonce: string): string {
  const parsed = parseSiweMessage(message);
  
  if (parsed.nonce !== expectedNonce) {
    throw new Error("Nonce mismatch");
  }
  
  if (parsed.expirationTime && new Date(parsed.expirationTime) < new Date()) {
    throw new Error("Message has expired");
  }
  
  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    throw new Error("Signature verification failed: signer address does not match message address");
  }
  
  return parsed.address;
}

/**
 * Fastify preHandler to authenticate using API key.
 */
export async function authenticateApiKey(
  request: any,
  reply: any,
): Promise<void> {
  const apiKeyHeader = request.headers["x-api-key"];
  const { config } = require("../../config");
  if (!apiKeyHeader || apiKeyHeader !== config.apiKey) {
    return reply.status(401).send({ error: "Unauthorized: Invalid or missing API key" });
  }
}

/**
 * Fastify preHandler to authenticate using either a SIWE Session Token or API key.
 */
export async function authenticateSessionOrApiKey(
  request: any,
  reply: any,
): Promise<void> {
  const apiKeyHeader = request.headers["x-api-key"];
  const { config } = require("../../config");
  if (apiKeyHeader && apiKeyHeader === config.apiKey) {
    return; // Authorized via API key
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Unauthorized: Invalid or missing credentials" });
  }

  const token = authHeader.substring(7);
  const { getPrisma } = require("../../services/prisma");
  const prisma = getPrisma();
  
  const session = await prisma.session.findUnique({
    where: { token },
  });

  if (!session || new Date(session.expiresAt) < new Date()) {
    if (session) {
      prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    return reply.status(401).send({ error: "Unauthorized: Session has expired or is invalid" });
  }

  request.authenticatedWallet = session.walletAddress;
}

