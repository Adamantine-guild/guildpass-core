module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],

  // pnpm hoists packages; include the root node_modules so Jest can find
  // transitive dependencies (e.g. zod) that are not in the local
  // node_modules of the workspace member.
  moduleDirectories: [
    'node_modules',
    '<rootDir>/../../node_modules',
  ],

  // Ensure TypeScript files are transformed for Jest.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
  },

  // Resolve workspace packages via their built dist output.
  moduleNameMapper: {
    '^@guildpass/shared-types$': '<rootDir>/../../packages/shared-types/dist',
    '^@guildpass/policy-engine$': '<rootDir>/../../packages/policy-engine/dist/src',
    '^@guildpass/governance-engine$': '<rootDir>/../../packages/governance-engine/dist/src',
    '^@guildpass/contribution-engine$': '<rootDir>/../../packages/contribution-engine/dist/src',
  },
};



