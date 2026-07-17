module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],

  moduleDirectories: [
    'node_modules',
    '<rootDir>/../../node_modules',
  ],

  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
  },

  moduleNameMapper: {
    '^@guildpass/shared-types$': '<rootDir>/../../packages/shared-types/dist',
  },
};
