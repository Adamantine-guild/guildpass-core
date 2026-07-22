import { PrismaClient, Wallet, Challenge as PrismaChallenge, LinkedWallet as PrismaLinkedWallet } from "@prisma/client";
import { Challenge, LinkWalletInput, LinkedWallet, WalletAddress } from "@guildpass/shared-types";
import crypto from "crypto";
import { ethers } from "ethers";

export class IdentityServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = "IdentityServiceError";
    this.statusCode = statusCode;
  }
}

function normaliseWallet(wallet: string): string {
  return wallet.toLowerCase();
}

export function getIdentityService(prisma: PrismaClient) {
  /**
   * Generate a new challenge for linking a secondary wallet to a primary identity
   */
  async function generateChallenge(
    primaryWalletAddress: WalletAddress,
    secondaryWalletAddress: WalletAddress,
    expirySeconds: number = 300 // Default 5 minutes
  ): Promise<Challenge> {
    const normalisedPrimary = normaliseWallet(primaryWalletAddress);
    const normalisedSecondary = normaliseWallet(secondaryWalletAddress);

    if (normalisedPrimary === normalisedSecondary) {
      throw new IdentityServiceError("Primary and secondary wallets cannot be the same", 400);
    }

    // Get or create both wallets
    const [primaryWallet, secondaryWallet] = await Promise.all([
      prisma.wallet.upsert({
        where: { address: normalisedPrimary },
        update: {},
        create: { address: normalisedPrimary },
      }),
      prisma.wallet.upsert({
        where: { address: normalisedSecondary },
        update: {},
        create: { address: normalisedSecondary },
      }),
    ]);

    // Check if secondary is already linked to someone else
    const existingLink = await prisma.linkedWallet.findUnique({
      where: { secondaryWalletId: secondaryWallet.id },
    });
    if (existingLink) {
      throw new IdentityServiceError("Secondary wallet is already linked to another identity", 409);
    }

    // Generate nonce
    const nonce = crypto.randomBytes(32).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expirySeconds * 1000);

    // Store challenge in DB
    await prisma.challenge.create({
      data: {
        nonce,
        primaryWalletId: primaryWallet.id,
        secondaryWalletId: secondaryWallet.id,
        expiresAt,
      },
    });

    return {
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      primaryWallet: primaryWalletAddress,
      secondaryWallet: secondaryWalletAddress,
    };
  }

  /**
   * Verify a challenge response and link the wallets
   */
  async function linkWallet(input: LinkWalletInput): Promise<LinkedWallet> {
    const { challenge, signature } = input;
    const normalisedPrimary = normaliseWallet(challenge.primaryWallet);
    const normalisedSecondary = normaliseWallet(challenge.secondaryWallet);

    // Validate the challenge exists and is not expired/used
    const storedChallenge = await prisma.challenge.findUnique({
      where: { nonce: challenge.nonce },
      include: {
        primaryWallet: true,
        secondaryWallet: true,
      },
    });

    if (!storedChallenge) {
      throw new IdentityServiceError("Challenge not found", 404);
    }

    if (storedChallenge.used) {
      throw new IdentityServiceError("Challenge has already been used", 400);
    }

    if (new Date() > new Date(challenge.expiresAt)) {
      throw new IdentityServiceError("Challenge has expired", 400);
    }

    // Verify the wallet addresses match
    if (
      storedChallenge.primaryWallet.address !== normalisedPrimary ||
      storedChallenge.secondaryWallet.address !== normalisedSecondary
    ) {
      throw new IdentityServiceError("Challenge wallet addresses do not match", 400);
    }

    // Verify the signature against the secondary wallet address
    const message = `GuildPass Link Wallet Request\n` +
      `Primary Wallet: ${normalisedPrimary}\n` +
      `Secondary Wallet: ${normalisedSecondary}\n` +
      `Nonce: ${challenge.nonce}\n` +
      `Issued At: ${challenge.issuedAt}\n` +
      `Expires At: ${challenge.expiresAt}`;

    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      if (recoveredAddress.toLowerCase() !== normalisedSecondary) {
        throw new IdentityServiceError("Signature verification failed: signer address does not match secondary wallet", 400);
      }
    } catch (err) {
      throw new IdentityServiceError(
        err instanceof Error ? `Invalid signature: ${err.message}` : "Invalid signature format",
        400
      );
    }

    // Mark challenge as used and create the link in a transaction
    const linkedWallet = await prisma.$transaction(async (tx) => {
      await tx.challenge.update({
        where: { id: storedChallenge.id },
        data: { used: true },
      });

      return tx.linkedWallet.create({
        data: {
          primaryWalletId: storedChallenge.primaryWalletId,
          secondaryWalletId: storedChallenge.secondaryWalletId,
          primaryWalletAddress: normalisedPrimary,
          secondaryWalletAddress: normalisedSecondary,
        },
      });
    });

    return {
      id: linkedWallet.id,
      primaryWalletId: linkedWallet.primaryWalletId,
      secondaryWalletId: linkedWallet.secondaryWalletId,
      primaryWalletAddress: linkedWallet.primaryWalletAddress as WalletAddress,
      secondaryWalletAddress: linkedWallet.secondaryWalletAddress as WalletAddress,
      linkedAt: linkedWallet.linkedAt.toISOString(),
    };
  }

  /**
   * Get all wallets linked to a primary wallet (including the primary itself)
   */
  async function getLinkedWallets(primaryWalletAddress: WalletAddress): Promise<WalletAddress[]> {
    const normalisedPrimary = normaliseWallet(primaryWalletAddress);

    const primaryWallet = await prisma.wallet.findUnique({
      where: { address: normalisedPrimary },
      include: {
        primaryLinkedWallets: {
          include: {
            secondaryWallet: true,
          },
        },
      },
    });

    if (!primaryWallet) {
      return [primaryWalletAddress];
    }

    // Return primary + all linked secondary wallets
    return [
      primaryWalletAddress,
      ...(primaryWallet.primaryLinkedWallets || []).map(
        (lw) => lw.secondaryWalletAddress as WalletAddress
      ),
    ];
  }

  /**
   * Get all primary linked wallets (if a wallet is a secondary, find its primary)
   */
  async function getPrimaryWallet(walletAddress: WalletAddress): Promise<WalletAddress> {
    const normalised = normaliseWallet(walletAddress);

    // First check if this is a secondary wallet linked to a primary
    const linkedAsSecondary = await prisma.linkedWallet.findFirst({
      where: { secondaryWalletAddress: normalised },
    });

    if (linkedAsSecondary) {
      return linkedAsSecondary.primaryWalletAddress as WalletAddress;
    }

    // If not, it's its own primary
    return walletAddress;
  }

  return {
    generateChallenge,
    linkWallet,
    getLinkedWallets,
    getPrimaryWallet,
  };
}
