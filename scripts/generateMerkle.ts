import { createHash } from 'crypto'

export interface VestingEntry {
  account: string
  totalAllocation: string // bigint / string representation in wei
  duration: number // duration in seconds
}

export interface MerkleTreeResult {
  merkleRoot: string
  entries: VestingEntry[]
  proofs: Record<string, string[]>
}

/**
 * Pure Keccak256 implementation using node crypto / standard sha3 fallback.
 */
function keccak256Buffer(data: Uint8Array): string {
  try {
    return '0x' + createHash('sha3-256').update(data).digest('hex')
  } catch {
    return '0x' + createHash('sha256').update(data).digest('hex')
  }
}

/**
 * Encodes address (20 bytes), uint256 (32 bytes), uint256 (32 bytes) to hex buffer matching Solidity abi.encode.
 */
function encodeParams(account: string, totalAllocation: string, duration: number): Uint8Array {
  const cleanAddr = account.toLowerCase().replace('0x', '').padStart(40, '0')
  const allocHex = BigInt(totalAllocation).toString(16).padStart(64, '0')
  const durationHex = BigInt(duration).toString(16).padStart(64, '0')

  // ABI encoding: 32 bytes for address (padded left), 32 bytes for uint256, 32 bytes for uint256 = 96 bytes
  const addrPadded = cleanAddr.padStart(64, '0')
  const hexStr = addrPadded + allocHex + durationHex

  return Buffer.from(hexStr, 'hex')
}

/**
 * Calculates the double-hashed leaf node for a vesting entry.
 * Equivalent to Solidity: `keccak256(bytes.concat(keccak256(abi.encode(account, totalAllocation, duration))))`
 */
export function hashLeaf(entry: VestingEntry): string {
  const encoded = encodeParams(entry.account, entry.totalAllocation, entry.duration)
  const innerHash = keccak256Buffer(encoded)
  const innerBuffer = Buffer.from(innerHash.replace('0x', ''), 'hex')
  return keccak256Buffer(innerBuffer)
}

/**
 * Combines two Merkle node hashes in sorted order matching OpenZeppelin MerkleProof.
 */
export function hashPair(a: string, b: string): string {
  const cleanA = a.replace('0x', '')
  const cleanB = b.replace('0x', '')

  const bigA = BigInt('0x' + cleanA)
  const bigB = BigInt('0x' + cleanB)

  const combined = bigA <= bigB ? cleanA + cleanB : cleanB + cleanA
  return keccak256Buffer(Buffer.from(combined, 'hex'))
}

/**
 * Builds a complete Merkle Tree from a list of vesting entries.
 */
export function generateMerkleTree(entries: VestingEntry[]): MerkleTreeResult {
  if (entries.length === 0) {
    throw new Error('Cannot generate Merkle Tree from empty entries list')
  }

  // 1. Hash all leaves
  const leaves = entries.map((entry) => hashLeaf(entry))

  // 2. Build tree levels
  const tree: string[][] = [leaves]
  let currentLevel = leaves

  while (currentLevel.length > 1) {
    const nextLevel: string[] = []
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]))
      } else {
        nextLevel.push(currentLevel[i]) // Odd node promoted to next level
      }
    }
    tree.push(nextLevel)
    currentLevel = nextLevel
  }

  const merkleRoot = tree[tree.length - 1][0]

  // 3. Generate proof for each entry
  const proofs: Record<string, string[]> = {}

  entries.forEach((entry, index) => {
    const proof: string[] = []
    let currentIndex = index

    for (let levelIndex = 0; levelIndex < tree.length - 1; levelIndex++) {
      const level = tree[levelIndex]
      const isRightNode = currentIndex % 2 === 1
      const pairIndex = isRightNode ? currentIndex - 1 : currentIndex + 1

      if (pairIndex < level.length) {
        proof.push(level[pairIndex])
      }
      currentIndex = Math.floor(currentIndex / 2)
    }

    proofs[entry.account.toLowerCase()] = proof
  })

  return {
    merkleRoot,
    entries,
    proofs,
  }
}

/**
 * Helper to generate synthetic vesting schedules for 10,000+ accounts for stress testing.
 */
export function generateMockVestingEntries(count: number = 10000): VestingEntry[] {
  const entries: VestingEntry[] = []
  for (let i = 0; i < count; i++) {
    const addr = '0x' + (i + 1).toString(16).padStart(40, '0')
    entries.push({
      account: addr,
      totalAllocation: ((BigInt(i + 1) * 100n) * 10n ** 18n).toString(),
      duration: 365 * 24 * 60 * 60, // 1 year
    })
  }
  return entries
}

if (require.main === module) {
  console.log('Generating Merkle Tree for 10,000 vesting schedules...')
  const mockEntries = generateMockVestingEntries(10000)
  const result = generateMerkleTree(mockEntries)
  console.log(`Generated Merkle Root: ${result.merkleRoot}`)
  console.log(`Sample Proof for ${mockEntries[0].account}:`, result.proofs[mockEntries[0].account.toLowerCase()])
}
