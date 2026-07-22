describe('Config Validation', () => {
  const originalEnv = process.env;

  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit called with "${code}"`);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
  });

  describe('Valid Configuration', () => {
    it('should load config with all required values', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.NODE_ENV = 'production';
      process.env.PORT = '8080';
      process.env.LOG_LEVEL = 'debug';

      jest.spyOn(console, 'log').mockImplementation();

      const { config } = await import('./config');

      expect(config.databaseUrl).toBe(
        'postgresql://user:pass@localhost:5432/test_db'
      );
      expect(config.nodeEnv).toBe('production');
      expect(config.port).toBe(8080);
      expect(config.logLevel).toBe('debug');
    });

    it('should apply defaults when optional values are missing', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      delete process.env.NODE_ENV;

      jest.spyOn(console, 'log').mockImplementation();

      const { config } = await import('./config');

      expect(config.port).toBe(3000);
      expect(config.nodeEnv).toBe('development');
      expect(config.logLevel).toBe('info');
    });

    it('should coerce PORT string to number', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.PORT = '9999';

      jest.spyOn(console, 'log').mockImplementation();

      const { config } = await import('./config');

      expect(config.port).toBe(9999);
      expect(typeof config.port).toBe('number');
    });
  });

  describe('Missing Required Values', () => {
    it('should fail when DATABASE_URL is missing', async () => {
      delete process.env.DATABASE_URL;

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();

      expect(console.error).toHaveBeenCalled();
    });

    it('should fail when DATABASE_URL is empty string', async () => {
      process.env.DATABASE_URL = '';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });
  });

  describe('Malformed Values', () => {
    it('should fail when DATABASE_URL is not a valid URL', async () => {
      process.env.DATABASE_URL = 'not-a-valid-url';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });

    it('should fail when PORT is not a positive number', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.PORT = '-1';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });

    it('should fail when PORT is zero', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.PORT = '0';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });

    it('should fail when PORT is not a number', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.PORT = 'abc';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });

    it('should fail when NODE_ENV is invalid', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.NODE_ENV = 'invalid';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });

    it('should fail when LOG_LEVEL is invalid', async () => {
      process.env.DATABASE_URL =
        'postgresql://user:pass@localhost:5432/test_db';
      process.env.LOG_LEVEL = 'verbose';

      jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();
    });
  });

  describe('Error Messages', () => {
    it('should print clear error messages to console.error', async () => {
      process.env.DATABASE_URL = 'invalid-url';
      process.env.PORT = 'not-a-number';

      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(async () => {
        await import('./config');
      }).rejects.toThrow();

      const calls = errorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(calls).toContain('databaseUrl');
      expect(calls).toContain('port');
    });
  });
});