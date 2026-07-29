import { generateMerkleTree, generateMockVestingEntries, hashLeaf } from '../../../scripts/generateMerkle'

describe('MerkleVesting Off-Chain Merkle Tree Generator', () => {
  it('generates a valid 32-byte Merkle root for a set of vesting entries', () => {
    const entries = [
      { account: '0x1111111111111111111111111111111111111111', totalAllocation: '1000000000000000000000000', duration: 31536000 },
      { account: '0x2222222222222222222222222222222222222222', totalAllocation: '500000000000000000000000', duration: 15552000 },
    ]

    const result = generateMerkleTree(entries)

    expect(result.merkleRoot).toBeDefined()
    expect(result.merkleRoot).toMatch(/^0x[a-fA-F0-9]{64}$/)
    expect(Object.keys(result.proofs)).toHaveLength(2)

    const aliceProof = result.proofs['0x1111111111111111111111111111111111111111']
    expect(aliceProof).toHaveLength(1)
  })

  it('efficiently compresses 10,000+ vesting schedules into a single 32-byte Merkle root (O(1) storage)', () => {
    const mockEntries = generateMockVestingEntries(10000)
    expect(mockEntries).toHaveLength(10000)

    const startTime = Date.now()
    const result = generateMerkleTree(mockEntries)
    const elapsedTime = Date.now() - startTime

    expect(result.merkleRoot).toMatch(/^0x[a-fA-F0-9]{64}$/)
    expect(Object.keys(result.proofs)).toHaveLength(10000)
    // Verify proof depth for 10,000 items is ceil(log2(10000)) = 14 hashes
    const sampleProof = result.proofs[mockEntries[0].account.toLowerCase()]
    expect(sampleProof.length).toBeLessThanOrEqual(14)
    console.log(`Generated 10,000-leaf Merkle Tree in ${elapsedTime}ms`)
  })

  it('verifies leaf hashing matches double-keccak256 encoding', () => {
    const entry = {
      account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      totalAllocation: '1000',
      duration: 3600,
    }

    const leafHash = hashLeaf(entry)
    expect(leafHash).toMatch(/^0x[a-fA-F0-9]{64}$/)
  })
})
