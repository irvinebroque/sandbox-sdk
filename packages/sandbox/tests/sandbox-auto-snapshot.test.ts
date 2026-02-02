/**
 * Unit tests for Sandbox auto-snapshot/restore functionality.
 *
 * Tests cover:
 * - configureR2Credentials(): Validation of required fields and storage
 * - clearR2Credentials(): Credential removal from DO storage
 * - hasR2Credentials(): Checking credential existence
 * - Snapshot config and R2 credential separation (security)
 * - maybeAutoRestore() lifecycle integration via onStart()
 * - R2 key generation patterns
 * - Error handling for storage operations
 * - State consistency across credential operations
 */

import { Container } from '@cloudflare/containers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { R2CredentialConfig, SnapshotConfig } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, Sandbox } from '../src/sandbox';

// Mock dependencies before imports
vi.mock('./interpreter', () => ({
  CodeInterpreter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock('@cloudflare/containers', () => {
  const mockSwitchPort = vi.fn((request: Request, port: number) => {
    const url = new URL(request.url);
    url.pathname = `/proxy/${port}${url.pathname}`;
    return new Request(url, request);
  });

  const MockContainer = class Container {
    ctx: any;
    env: any;
    sleepAfter: string | number = '10m';
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async fetch(request: Request): Promise<Response> {
      return new Response('Mock Container fetch');
    }
    async containerFetch(request: Request, port: number): Promise<Response> {
      return new Response('Mock Container HTTP fetch');
    }
    async getState() {
      return { status: 'healthy' };
    }
    renewActivityTimeout() {}
    async onActivityExpired() {}
  };

  return {
    Container: MockContainer,
    getContainer: vi.fn(),
    switchPort: mockSwitchPort
  };
});

describe('Sandbox - Auto-Snapshot/Restore Functionality', () => {
  let sandbox: Sandbox;
  let mockCtx: Partial<DurableObjectState<{}>>;
  let mockEnv: any;
  let storageMap: Map<string, any>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Use a Map to simulate DO storage
    storageMap = new Map();

    // Mock DurableObjectState
    mockCtx = {
      storage: {
        get: vi.fn().mockImplementation((key: string) => {
          return Promise.resolve(storageMap.get(key) || null);
        }),
        put: vi.fn().mockImplementation((key: string, value: any) => {
          storageMap.set(key, value);
          return Promise.resolve();
        }),
        delete: vi.fn().mockImplementation((key: string) => {
          storageMap.delete(key);
          return Promise.resolve();
        }),
        list: vi.fn().mockResolvedValue(new Map())
      } as any,
      blockConcurrencyWhile: vi
        .fn()
        .mockImplementation(
          <T>(callback: () => Promise<T>): Promise<T> => callback()
        ),
      waitUntil: vi.fn(),
      id: {
        toString: () => 'test-sandbox-id',
        equals: vi.fn(),
        name: 'test-sandbox'
      } as any
    };

    mockEnv = {};

    // Create Sandbox instance
    const stub = new Sandbox(mockCtx as DurableObjectState<{}>, mockEnv);

    // Wait for blockConcurrencyWhile to complete
    await vi.waitFor(() => {
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalled();
    });

    sandbox = Object.assign(stub, {
      wsConnect: connect(stub)
    });

    // Mock client methods
    vi.spyOn(sandbox.client.utils, 'createSession').mockResolvedValue({
      success: true,
      id: 'sandbox-default',
      message: 'Created'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // R2 Credential Configuration Tests
  // ============================================================================

  describe('configureR2Credentials', () => {
    const validConfig: R2CredentialConfig = {
      accountId: 'test-account-id',
      bucketName: 'test-bucket',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key'
    };

    it('should store valid R2 credentials in DO storage', async () => {
      await sandbox.configureR2Credentials(validConfig);

      expect(mockCtx.storage!.put).toHaveBeenCalledWith(
        'r2:credentials',
        validConfig
      );
      expect(storageMap.get('r2:credentials')).toEqual(validConfig);
    });

    it('should store credentials with optional keyPrefix', async () => {
      const configWithPrefix: R2CredentialConfig = {
        ...validConfig,
        keyPrefix: 'my-snapshots/'
      };

      await sandbox.configureR2Credentials(configWithPrefix);

      expect(storageMap.get('r2:credentials')).toEqual(configWithPrefix);
    });

    it('should store credentials with optional urlExpiry', async () => {
      const configWithExpiry: R2CredentialConfig = {
        ...validConfig,
        urlExpiry: 7200
      };

      await sandbox.configureR2Credentials(configWithExpiry);

      expect(storageMap.get('r2:credentials')).toEqual(configWithExpiry);
    });

    it('should throw error when accountId is missing', async () => {
      const invalidConfig = {
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      } as R2CredentialConfig;

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow('accountId is required in R2 credential configuration');
    });

    it('should throw error when accountId is empty string', async () => {
      const invalidConfig: R2CredentialConfig = {
        accountId: '',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow('accountId is required in R2 credential configuration');
    });

    it('should throw error when bucketName is missing', async () => {
      const invalidConfig = {
        accountId: 'test-account-id',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      } as R2CredentialConfig;

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'bucketName is required in R2 credential configuration'
      );
    });

    it('should throw error when bucketName is empty string', async () => {
      const invalidConfig: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: '',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'bucketName is required in R2 credential configuration'
      );
    });

    it('should throw error when accessKeyId is missing', async () => {
      const invalidConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        secretAccessKey: 'test-secret-key'
      } as R2CredentialConfig;

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'accessKeyId is required in R2 credential configuration'
      );
    });

    it('should throw error when accessKeyId is empty string', async () => {
      const invalidConfig: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: '',
        secretAccessKey: 'test-secret-key'
      };

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'accessKeyId is required in R2 credential configuration'
      );
    });

    it('should throw error when secretAccessKey is missing', async () => {
      const invalidConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key'
      } as R2CredentialConfig;

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'secretAccessKey is required in R2 credential configuration'
      );
    });

    it('should throw error when secretAccessKey is empty string', async () => {
      const invalidConfig: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: ''
      };

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow(
        'secretAccessKey is required in R2 credential configuration'
      );
    });

    it('should overwrite existing credentials when called again', async () => {
      const firstConfig: R2CredentialConfig = {
        accountId: 'first-account',
        bucketName: 'first-bucket',
        accessKeyId: 'first-key',
        secretAccessKey: 'first-secret'
      };

      const secondConfig: R2CredentialConfig = {
        accountId: 'second-account',
        bucketName: 'second-bucket',
        accessKeyId: 'second-key',
        secretAccessKey: 'second-secret'
      };

      await sandbox.configureR2Credentials(firstConfig);
      expect(storageMap.get('r2:credentials')).toEqual(firstConfig);

      await sandbox.configureR2Credentials(secondConfig);
      expect(storageMap.get('r2:credentials')).toEqual(secondConfig);
    });
  });

  // ============================================================================
  // clearR2Credentials Tests
  // ============================================================================

  describe('clearR2Credentials', () => {
    it('should remove R2 credentials from DO storage', async () => {
      // First configure credentials
      const config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };
      await sandbox.configureR2Credentials(config);
      expect(storageMap.has('r2:credentials')).toBe(true);

      // Then clear them
      await sandbox.clearR2Credentials();

      expect(mockCtx.storage!.delete).toHaveBeenCalledWith('r2:credentials');
      expect(storageMap.has('r2:credentials')).toBe(false);
    });

    it('should not throw when credentials do not exist', async () => {
      // Ensure no credentials exist
      expect(storageMap.has('r2:credentials')).toBe(false);

      // Should not throw
      await expect(sandbox.clearR2Credentials()).resolves.toBeUndefined();
      expect(mockCtx.storage!.delete).toHaveBeenCalledWith('r2:credentials');
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      const config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };
      await sandbox.configureR2Credentials(config);

      await sandbox.clearR2Credentials();
      await sandbox.clearR2Credentials();
      await sandbox.clearR2Credentials();

      expect(mockCtx.storage!.delete).toHaveBeenCalledTimes(3);
      expect(storageMap.has('r2:credentials')).toBe(false);
    });
  });

  // ============================================================================
  // hasR2Credentials Tests
  // ============================================================================

  describe('hasR2Credentials', () => {
    it('should return true when credentials are configured', async () => {
      const config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };
      await sandbox.configureR2Credentials(config);

      const result = await sandbox.hasR2Credentials();

      expect(result).toBe(true);
    });

    it('should return false when credentials are not configured', async () => {
      const result = await sandbox.hasR2Credentials();

      expect(result).toBe(false);
    });

    it('should return false after credentials are cleared', async () => {
      const config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };
      await sandbox.configureR2Credentials(config);
      expect(await sandbox.hasR2Credentials()).toBe(true);

      await sandbox.clearR2Credentials();
      const result = await sandbox.hasR2Credentials();

      expect(result).toBe(false);
    });

    it('should read from storage on each call (not cached)', async () => {
      // Configure credentials
      const config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };
      await sandbox.configureR2Credentials(config);

      // Call hasR2Credentials multiple times
      await sandbox.hasR2Credentials();
      await sandbox.hasR2Credentials();
      await sandbox.hasR2Credentials();

      // Verify storage.get was called each time for r2:credentials
      const getCalls = vi
        .mocked(mockCtx.storage!.get)
        .mock.calls.filter((call) => String(call[0]) === 'r2:credentials');
      expect(getCalls.length).toBe(3);
    });
  });

  // ============================================================================
  // Snapshot Config Integration Tests
  // ============================================================================

  describe('snapshot config and R2 credentials integration', () => {
    it('should store snapshot config and R2 credentials separately', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: true,
        volumePath: '/workspace',
        autoSnapshotOnSleep: true,
        autoRestoreOnWake: true,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: ['node_modules/**']
      };

      const r2Config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };

      await sandbox.configureSnapshots(snapshotConfig);
      await sandbox.configureR2Credentials(r2Config);

      // Verify both are stored with different keys
      expect(storageMap.get('snapshot:config')).toEqual(snapshotConfig);
      expect(storageMap.get('r2:credentials')).toEqual(r2Config);
    });

    it('should not expose R2 credentials through getSnapshotConfig', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: true,
        volumePath: '/workspace',
        autoSnapshotOnSleep: true,
        autoRestoreOnWake: true,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: []
      };

      const r2Config: R2CredentialConfig = {
        accountId: 'secret-account-id',
        bucketName: 'secret-bucket',
        accessKeyId: 'secret-access-key',
        secretAccessKey: 'super-secret-key'
      };

      await sandbox.configureSnapshots(snapshotConfig);
      await sandbox.configureR2Credentials(r2Config);

      const retrievedConfig = await sandbox.getSnapshotConfig();

      // Should not contain any R2 credential fields
      expect(retrievedConfig).not.toHaveProperty('accountId');
      expect(retrievedConfig).not.toHaveProperty('bucketName');
      expect(retrievedConfig).not.toHaveProperty('accessKeyId');
      expect(retrievedConfig).not.toHaveProperty('secretAccessKey');
      expect(JSON.stringify(retrievedConfig)).not.toContain('secret');
    });

    it('should allow clearing R2 credentials while keeping snapshot config', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: true,
        volumePath: '/workspace',
        autoSnapshotOnSleep: false,
        autoRestoreOnWake: false,
        maxSnapshots: 3,
        compressionLevel: 'fast',
        excludePatterns: []
      };

      const r2Config: R2CredentialConfig = {
        accountId: 'test-account-id',
        bucketName: 'test-bucket',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key'
      };

      await sandbox.configureSnapshots(snapshotConfig);
      await sandbox.configureR2Credentials(r2Config);

      await sandbox.clearR2Credentials();

      // Snapshot config should still exist
      const retrievedConfig = await sandbox.getSnapshotConfig();
      expect(retrievedConfig).toEqual(snapshotConfig);

      // R2 credentials should be gone
      expect(await sandbox.hasR2Credentials()).toBe(false);
    });
  });

  // ============================================================================
  // maybeAutoRestore Tests (via onStart)
  // ============================================================================

  describe('maybeAutoRestore (via lifecycle)', () => {
    it('should not restore when autoRestoreOnWake is false', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: true,
        volumePath: '/workspace',
        autoSnapshotOnSleep: false,
        autoRestoreOnWake: false,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: []
      };

      await sandbox.configureSnapshots(snapshotConfig);

      // Mock listSnapshots to verify it's not called
      vi.spyOn(sandbox, 'listSnapshots');

      // Trigger onStart (which calls maybeAutoRestore)
      sandbox.onStart();

      // Give async operation time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      // listSnapshots should not be called when autoRestoreOnWake is false
      expect(sandbox.listSnapshots).not.toHaveBeenCalled();
    });

    it('should not restore when snapshots are disabled', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: false,
        volumePath: '/workspace',
        autoSnapshotOnSleep: true,
        autoRestoreOnWake: true,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: []
      };

      await sandbox.configureSnapshots(snapshotConfig);

      vi.spyOn(sandbox, 'listSnapshots');

      sandbox.onStart();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sandbox.listSnapshots).not.toHaveBeenCalled();
    });

    it('should not restore when no snapshot config exists', async () => {
      // No snapshot config configured
      vi.spyOn(sandbox, 'listSnapshots');

      sandbox.onStart();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sandbox.listSnapshots).not.toHaveBeenCalled();
    });

    it('should attempt restore when autoRestoreOnWake is enabled', async () => {
      const snapshotConfig: SnapshotConfig = {
        enabled: true,
        volumePath: '/workspace',
        autoSnapshotOnSleep: false,
        autoRestoreOnWake: true,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: []
      };

      await sandbox.configureSnapshots(snapshotConfig);

      // Mock listSnapshots to return empty (no snapshots available)
      vi.spyOn(sandbox, 'listSnapshots').mockResolvedValue([]);

      sandbox.onStart();

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should check for snapshots when autoRestoreOnWake is true
      expect(sandbox.listSnapshots).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // R2 Key Generation Tests (via indirect testing)
  // ============================================================================

  describe('R2 key generation', () => {
    it('should use default prefix when keyPrefix not specified', async () => {
      const r2Config: R2CredentialConfig = {
        accountId: 'test-account',
        bucketName: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
        // No keyPrefix specified
      };

      await sandbox.configureR2Credentials(r2Config);

      const storedConfig = storageMap.get('r2:credentials');
      expect(storedConfig.keyPrefix).toBeUndefined();
      // Default 'snapshots/' prefix is applied in generateR2Key method
    });

    it('should preserve custom keyPrefix in storage', async () => {
      const r2Config: R2CredentialConfig = {
        accountId: 'test-account',
        bucketName: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
        keyPrefix: 'custom/prefix/'
      };

      await sandbox.configureR2Credentials(r2Config);

      const storedConfig = storageMap.get('r2:credentials');
      expect(storedConfig.keyPrefix).toBe('custom/prefix/');
    });
  });

  // ============================================================================
  // Edge Cases and Error Handling
  // ============================================================================

  describe('edge cases and error handling', () => {
    it('should handle storage errors gracefully in configureR2Credentials', async () => {
      vi.mocked(mockCtx.storage!.put).mockRejectedValueOnce(
        new Error('Storage write failed')
      );

      const config: R2CredentialConfig = {
        accountId: 'test-account',
        bucketName: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      };

      await expect(sandbox.configureR2Credentials(config)).rejects.toThrow(
        'Storage write failed'
      );
    });

    it('should handle storage errors gracefully in clearR2Credentials', async () => {
      vi.mocked(mockCtx.storage!.delete).mockRejectedValueOnce(
        new Error('Storage delete failed')
      );

      await expect(sandbox.clearR2Credentials()).rejects.toThrow(
        'Storage delete failed'
      );
    });

    it('should handle storage errors gracefully in hasR2Credentials', async () => {
      vi.mocked(mockCtx.storage!.get).mockRejectedValueOnce(
        new Error('Storage read failed')
      );

      await expect(sandbox.hasR2Credentials()).rejects.toThrow(
        'Storage read failed'
      );
    });

    it('should validate all required fields before storing', async () => {
      // Test that validation happens before storage.put
      const putSpy = vi.mocked(mockCtx.storage!.put);
      putSpy.mockClear();

      const invalidConfig = {
        accountId: '', // Invalid - empty
        bucketName: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      } as R2CredentialConfig;

      await expect(
        sandbox.configureR2Credentials(invalidConfig)
      ).rejects.toThrow();

      // storage.put should not have been called for r2:credentials
      const r2PutCalls = putSpy.mock.calls.filter(
        (call) => String(call[0]) === 'r2:credentials'
      );
      expect(r2PutCalls.length).toBe(0);
    });
  });

  // ============================================================================
  // Concurrency and State Consistency Tests
  // ============================================================================

  describe('state consistency', () => {
    it('should maintain consistent state across configure/has/clear cycle', async () => {
      // Initial state: no credentials
      expect(await sandbox.hasR2Credentials()).toBe(false);

      // Configure credentials
      const config: R2CredentialConfig = {
        accountId: 'test-account',
        bucketName: 'test-bucket',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      };
      await sandbox.configureR2Credentials(config);
      expect(await sandbox.hasR2Credentials()).toBe(true);

      // Clear credentials
      await sandbox.clearR2Credentials();
      expect(await sandbox.hasR2Credentials()).toBe(false);

      // Reconfigure credentials
      await sandbox.configureR2Credentials(config);
      expect(await sandbox.hasR2Credentials()).toBe(true);
    });

    it('should handle rapid credential updates', async () => {
      const configs: R2CredentialConfig[] = [
        {
          accountId: 'account-1',
          bucketName: 'bucket-1',
          accessKeyId: 'key-1',
          secretAccessKey: 'secret-1'
        },
        {
          accountId: 'account-2',
          bucketName: 'bucket-2',
          accessKeyId: 'key-2',
          secretAccessKey: 'secret-2'
        },
        {
          accountId: 'account-3',
          bucketName: 'bucket-3',
          accessKeyId: 'key-3',
          secretAccessKey: 'secret-3'
        }
      ];

      // Rapidly update credentials
      for (const config of configs) {
        await sandbox.configureR2Credentials(config);
      }

      // Final state should be the last config
      expect(await sandbox.hasR2Credentials()).toBe(true);
      expect(storageMap.get('r2:credentials')).toEqual(configs[2]);
    });
  });
});
