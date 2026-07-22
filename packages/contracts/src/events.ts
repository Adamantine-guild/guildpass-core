/**
 * MembershipNFT event types, ABI, and typed log decoders.
 *
 * This module is the **single source of truth** for the MembershipNFT
 * contract's event schema.  The ABI is extracted from the Solidity source
 * (`contracts/src/MembershipNFT.sol`) and the TypeScript types are derived
 * from it so that any contract event field change surfaces as a type error
 * here — and therefore in every consumer (e.g. `apps/access-api`).
 */

import { keccak256 as keccak } from 'js-sha3';

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

import abiJson from './abi/MembershipNFT.json';

/** Full MembershipNFT ABI (events only). Generated from Solidity source. */
export const MembershipNFTAbi = abiJson as readonly AbiEvent[];

// ---------------------------------------------------------------------------
// ABI types (minimal, self-contained)
// ---------------------------------------------------------------------------

export interface AbiEventParameter {
  readonly indexed: boolean;
  readonly internalType: string;
  readonly name: string;
  readonly type: string;
}

export interface AbiEvent {
  readonly anonymous: boolean;
  readonly inputs: readonly AbiEventParameter[];
  readonly name: string;
  readonly type: 'event';
}

// ---------------------------------------------------------------------------
// Decoded event interfaces — mirrors the Solidity events 1-to-1
// ---------------------------------------------------------------------------

/** On-chain metadata attached to every decoded event. */
export interface EventMetadata {
  readonly chainId?: number;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly transactionHash?: string;
  readonly txHash?: string;
  readonly logIndex?: number;
}

export interface DecodedMembershipMintedEvent extends EventMetadata {
  readonly type: 'MembershipMinted';
  readonly to: string;
  readonly tokenId: number;
  readonly communityId: string;
  readonly expiresAt: number;
}

export interface DecodedMembershipRenewedEvent extends EventMetadata {
  readonly type: 'MembershipRenewed';
  readonly tokenId: number;
  readonly newExpiresAt: number;
}

export interface DecodedMembershipSuspendedEvent extends EventMetadata {
  readonly type: 'MembershipSuspended';
  readonly tokenId: number;
  readonly isSuspended: boolean;
}

export interface DecodedAdminUpdatedEvent extends EventMetadata {
  readonly type: 'AdminUpdated';
  readonly admin: string;
  readonly enabled: boolean;
}

export interface DecodedOwnershipTransferProposedEvent extends EventMetadata {
  readonly type: 'OwnershipTransferProposed';
  readonly currentOwner: string;
  readonly proposedOwner: string;
}

export interface DecodedOwnershipTransferredEvent extends EventMetadata {
  readonly type: 'OwnershipTransferred';
  readonly previousOwner: string;
  readonly newOwner: string;
}

export interface DecodedMembershipMerkleRootUpdatedEvent extends EventMetadata {
  readonly type: 'MembershipMerkleRootUpdated';
  readonly communityId: string;
  readonly previousRoot: string;
  readonly newRoot: string;
}

export interface DecodedMembershipClaimedEvent extends EventMetadata {
  readonly type: 'MembershipClaimed';
  readonly wallet: string;
  readonly tokenId: number;
  readonly communityId: string;
  readonly index: number;
  readonly expiresAt: number;
}

/** Union of all decoded MembershipNFT events. */
export type DecodedContractEvent =
  | DecodedMembershipMintedEvent
  | DecodedMembershipRenewedEvent
  | DecodedMembershipSuspendedEvent
  | DecodedAdminUpdatedEvent
  | DecodedOwnershipTransferProposedEvent
  | DecodedOwnershipTransferredEvent
  | DecodedMembershipMerkleRootUpdatedEvent
  | DecodedMembershipClaimedEvent;

// ---------------------------------------------------------------------------
// Raw log shape (what an ethers/viem provider returns)
// ---------------------------------------------------------------------------

export interface RawLog {
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber?: number | string;
  readonly blockHash?: string;
  readonly transactionHash?: string;
  readonly logIndex?: number;
}

// ---------------------------------------------------------------------------
// Topic hashes — keccak256 of the canonical event signature
// ---------------------------------------------------------------------------

function topicHash(signature: string): string {
  return '0x' + keccak(signature);
}

export const EVENT_TOPICS = {
  MembershipMinted: topicHash('MembershipMinted(address,uint256,string,uint256)'),
  MembershipRenewed: topicHash('MembershipRenewed(uint256,uint256)'),
  MembershipSuspended: topicHash('MembershipSuspended(uint256,bool)'),
  AdminUpdated: topicHash('AdminUpdated(address,bool)'),
  OwnershipTransferProposed: topicHash('OwnershipTransferProposed(address,address)'),
  OwnershipTransferred: topicHash('OwnershipTransferred(address,address)'),
  MembershipMerkleRootUpdated: topicHash('MembershipMerkleRootUpdated(string,bytes32,bytes32)'),
  MembershipClaimed: topicHash('MembershipClaimed(address,uint256,string,uint256,uint256)'),
} as const;

// Build a reverse lookup: topic hash → event name
const TOPIC_TO_NAME = new Map<string, keyof typeof EVENT_TOPICS>(
  (Object.entries(EVENT_TOPICS) as [keyof typeof EVENT_TOPICS, string][]).map(
    ([name, hash]) => [hash, name],
  ),
);

// ---------------------------------------------------------------------------
// ABI data decoder (zero extra dependencies beyond js-sha3)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readUint256(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 32; i++) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }
  return value;
}

function readAddress(data: Uint8Array, offset: number): string {
  // Address is 20 bytes, right-aligned in a 32-byte word
  const slice = data.subarray(offset + 12, offset + 32);
  return '0x' + Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join('');
}

function readBool(data: Uint8Array, offset: number): boolean {
  return data[offset + 31] !== 0;
}

function readBytes32(data: Uint8Array, offset: number): string {
  return bytesToHex(data.subarray(offset, offset + 32));
}

function readString(data: Uint8Array, wordOffset: number): string {
  // Dynamic type: first word at wordOffset is a pointer (byte offset into data)
  const dataOffset = Number(readUint256(data, wordOffset * 32));
  const length = Number(readUint256(data, dataOffset));
  const bytes = data.subarray(dataOffset + 32, dataOffset + 32 + length);
  return new TextDecoder().decode(bytes);
}

/**
 * Decode non-indexed parameters from the `data` field of an ABI-encoded log.
 *
 * Non-indexed params are laid out in declaration order.  Dynamic types (string)
 * use an offset pointer to the actual payload at the end of the data section.
 */
function decodeNonIndexedParams(
  dataBytes: Uint8Array,
  abiEvent: AbiEvent,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const nonIndexed = abiEvent.inputs.filter((p) => !p.indexed);

  let wordOffset = 0;
  for (const param of nonIndexed) {
    switch (param.type) {
      case 'uint256':
        result[param.name] = Number(readUint256(dataBytes, wordOffset * 32));
        wordOffset++;
        break;
      case 'address':
        result[param.name] = readAddress(dataBytes, wordOffset * 32);
        wordOffset++;
        break;
      case 'bool':
        result[param.name] = readBool(dataBytes, wordOffset * 32);
        wordOffset++;
        break;
      case 'bytes32':
        result[param.name] = readBytes32(dataBytes, wordOffset * 32);
        wordOffset++;
        break;
      case 'string':
        result[param.name] = readString(dataBytes, wordOffset);
        wordOffset++;
        break;
      default:
        throw new Error(`Unsupported ABI type: ${param.type}`);
    }
  }

  return result;
}

/** Decode an indexed parameter from a topic (32 bytes). */
function decodeIndexedTopic(topic: string, param: AbiEventParameter): unknown {
  const bytes = hexToBytes(topic);
  switch (param.type) {
    case 'uint256':
      return Number(readUint256(bytes, 0));
    case 'address':
      return readAddress(bytes, 0);
    case 'bool':
      return readBool(bytes, 0);
    case 'bytes32':
      return readBytes32(bytes, 0);
    case 'string':
      // Indexed string = keccak256 of the string value (not the string itself)
      return topic;
    default:
      throw new Error(`Unsupported indexed ABI type: ${param.type}`);
  }
}

// ---------------------------------------------------------------------------
// Public decoder API
// ---------------------------------------------------------------------------

/**
 * Decode a raw EVM log into a typed event object.
 *
 * @param log  The raw log (topics + data) from an ethers/viem provider.
 * @returns A `DecodedContractEvent` with the event type and decoded fields,
 *          or `null` if the topic doesn't match any MembershipNFT event.
 * @throws If the log data is malformed or contains an unsupported ABI type.
 */
export function decodeEventLog(log: RawLog): DecodedContractEvent | null {
  const topic0 = log.topics[0];
  const eventName = TOPIC_TO_NAME.get(topic0);
  if (!eventName) return null;

  const abiEvent = abiJson.find((e) => e.name === eventName) as AbiEvent | undefined;
  if (!abiEvent) return null;

  const dataBytes = hexToBytes(log.data);

  // Decode non-indexed params from data
  const args = decodeNonIndexedParams(dataBytes, abiEvent);

  // Decode indexed params from topics[1..]
  let topicIdx = 1;
  for (const param of abiEvent.inputs) {
    if (param.indexed) {
      args[param.name] = decodeIndexedTopic(log.topics[topicIdx], param);
      topicIdx++;
    }
  }

  // Attach metadata
  const meta: EventMetadata = {
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : undefined,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };

  return { type: eventName, ...args, ...meta } as DecodedContractEvent;
}

/**
 * Get the ABI event definition for a given event name.
 */
export function getAbiEvent(eventName: string): AbiEvent | undefined {
  return abiJson.find((e) => e.name === eventName) as AbiEvent | undefined;
}

/**
 * Get the topic hash for a given event name.
 */
export function getTopicHash(eventName: keyof typeof EVENT_TOPICS): string {
  return EVENT_TOPICS[eventName];
}
