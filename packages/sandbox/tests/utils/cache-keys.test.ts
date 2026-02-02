import { describe, expect, it } from 'vitest';
import { generateCacheKey } from '../../src/utils/cache-keys';

describe('cache-keys', () => {
  describe('generateCacheKey', () => {
    it('should generate consistent hash for same content', async () => {
      const content = 'test content';
      const hash1 = await generateCacheKey(content);
      const hash2 = await generateCacheKey(content);
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', async () => {
      const hash1 = await generateCacheKey('content1');
      const hash2 = await generateCacheKey('content2');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty content', async () => {
      const hash = await generateCacheKey('');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
    });

    it('should handle unicode content', async () => {
      const hash = await generateCacheKey('日本語テスト 🎉');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
    });

    it('should produce hex string output', async () => {
      const hash = await generateCacheKey('test');
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it('should handle large content', async () => {
      const largeContent = 'x'.repeat(100000);
      const hash = await generateCacheKey(largeContent);
      expect(hash).toBeTruthy();
    });
  });
});
