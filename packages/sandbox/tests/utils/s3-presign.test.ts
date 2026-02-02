import type { R2CredentialConfig } from '@repo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generatePresignedGetUrl,
  generatePresignedPutUrl
} from '../../src/utils/s3-presign';

/**
 * Create a test R2 credential config with default values
 */
function createTestConfig(
  overrides: Partial<R2CredentialConfig> = {}
): R2CredentialConfig {
  return {
    accountId: 'test-account-id',
    bucketName: 'test-bucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ...overrides
  };
}

/**
 * Extract AWS Signature V4 parameters from a presigned URL
 */
function extractSignatureParams(url: string): Map<string, string> {
  const parsed = new URL(url);
  const params = new Map<string, string>();

  for (const [key, value] of parsed.searchParams.entries()) {
    params.set(key, value);
  }

  return params;
}

describe('generatePresignedPutUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates valid URL structure', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(
      config,
      'snapshots/my-file.tar.zst'
    );

    const parsed = new URL(url);

    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('test-account-id.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/test-bucket/snapshots/my-file.tar.zst');
  });

  it('contains all required AWS Signature V4 parameters', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.has('X-Amz-Algorithm')).toBe(true);
    expect(params.has('X-Amz-Credential')).toBe(true);
    expect(params.has('X-Amz-Date')).toBe(true);
    expect(params.has('X-Amz-Expires')).toBe(true);
    expect(params.has('X-Amz-SignedHeaders')).toBe(true);
    expect(params.has('X-Amz-Signature')).toBe(true);
  });

  it('uses AWS4-HMAC-SHA256 algorithm', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('generates correct credential scope format', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const credential = params.get('X-Amz-Credential');

    // Expected format: {accessKeyId}/{dateStamp}/{region}/{service}/aws4_request
    // For R2: AKIAIOSFODNN7EXAMPLE/20240615/auto/s3/aws4_request
    expect(credential).toBe(
      'AKIAIOSFODNN7EXAMPLE/20240615/auto/s3/aws4_request'
    );
  });

  it('generates correct date format (YYYYMMDDTHHMMSSZ)', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const amzDate = params.get('X-Amz-Date');

    // Should match format: 20240615T103000Z
    expect(amzDate).toBe('20240615T103000Z');
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('includes host in signed headers', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('generates 64-character lowercase hex signature', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const signature = params.get('X-Amz-Signature');

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('generatePresignedGetUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates valid URL structure', async () => {
    const config = createTestConfig();
    const url = await generatePresignedGetUrl(
      config,
      'snapshots/my-file.tar.zst'
    );

    const parsed = new URL(url);

    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('test-account-id.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/test-bucket/snapshots/my-file.tar.zst');
  });

  it('contains all required AWS Signature V4 parameters', async () => {
    const config = createTestConfig();
    const url = await generatePresignedGetUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.has('X-Amz-Algorithm')).toBe(true);
    expect(params.has('X-Amz-Credential')).toBe(true);
    expect(params.has('X-Amz-Date')).toBe(true);
    expect(params.has('X-Amz-Expires')).toBe(true);
    expect(params.has('X-Amz-SignedHeaders')).toBe(true);
    expect(params.has('X-Amz-Signature')).toBe(true);
  });

  it('generates different signature than PUT for same key', async () => {
    const config = createTestConfig();
    const key = 'same/key.txt';

    const putUrl = await generatePresignedPutUrl(config, key);
    const getUrl = await generatePresignedGetUrl(config, key);

    const putSignature = extractSignatureParams(putUrl).get('X-Amz-Signature');
    const getSignature = extractSignatureParams(getUrl).get('X-Amz-Signature');

    // Signatures should differ because the HTTP method is part of the canonical request
    expect(putSignature).not.toBe(getSignature);
  });
});

describe('key encoding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves forward slashes in path', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(
      config,
      'path/to/nested/file.txt'
    );

    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/test-bucket/path/to/nested/file.txt');
  });

  it('encodes special characters in key segments', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(
      config,
      'path/file with spaces.txt'
    );

    const parsed = new URL(url);

    // Spaces should be encoded as %20
    expect(parsed.pathname).toBe('/test-bucket/path/file%20with%20spaces.txt');
  });

  it('encodes plus signs in key', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'path/file+name.txt');

    const parsed = new URL(url);

    // Plus signs should be encoded as %2B
    expect(parsed.pathname).toBe('/test-bucket/path/file%2Bname.txt');
  });

  it('encodes unicode characters in key', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'path/日本語.txt');

    const parsed = new URL(url);

    // Unicode should be percent-encoded
    expect(parsed.pathname).toContain('/test-bucket/path/');
    expect(parsed.pathname).toContain('%');
  });

  it('removes leading slash from key', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(
      config,
      '/leading/slash/file.txt'
    );

    const parsed = new URL(url);

    // Should not have double slashes after bucket name
    expect(parsed.pathname).toBe('/test-bucket/leading/slash/file.txt');
    expect(parsed.pathname).not.toContain('//');
  });

  it('handles key with only special characters', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'path/@#$%^&.txt');

    const parsed = new URL(url);

    // URL should be valid and parseable
    expect(parsed.hostname).toBe('test-account-id.r2.cloudflarestorage.com');
    expect(parsed.pathname).toContain('/test-bucket/path/');
  });

  it('handles deeply nested paths', async () => {
    const config = createTestConfig();
    const deepPath = 'a/b/c/d/e/f/g/h/i/j/file.txt';
    const url = await generatePresignedPutUrl(config, deepPath);

    const parsed = new URL(url);

    expect(parsed.pathname).toBe(`/test-bucket/${deepPath}`);
  });
});

describe('urlExpiry parameter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses default expiry of 3600 seconds when not specified', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Expires')).toBe('3600');
  });

  it('respects custom urlExpiry value', async () => {
    const config = createTestConfig({ urlExpiry: 7200 });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Expires')).toBe('7200');
  });

  it('handles short expiry', async () => {
    const config = createTestConfig({ urlExpiry: 60 });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Expires')).toBe('60');
  });

  it('handles long expiry (1 week)', async () => {
    const oneWeek = 7 * 24 * 60 * 60; // 604800 seconds
    const config = createTestConfig({ urlExpiry: oneWeek });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Expires')).toBe(oneWeek.toString());
  });

  it('uses default when urlExpiry is explicitly undefined', async () => {
    const config = createTestConfig({ urlExpiry: undefined });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);

    expect(params.get('X-Amz-Expires')).toBe('3600');
  });
});

describe('different configurations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates different signatures for different account IDs', async () => {
    const config1 = createTestConfig({ accountId: 'account-1' });
    const config2 = createTestConfig({ accountId: 'account-2' });

    const url1 = await generatePresignedPutUrl(config1, 'same/key.txt');
    const url2 = await generatePresignedPutUrl(config2, 'same/key.txt');

    const sig1 = extractSignatureParams(url1).get('X-Amz-Signature');
    const sig2 = extractSignatureParams(url2).get('X-Amz-Signature');

    expect(sig1).not.toBe(sig2);
  });

  it('generates different signatures for different buckets', async () => {
    const config1 = createTestConfig({ bucketName: 'bucket-1' });
    const config2 = createTestConfig({ bucketName: 'bucket-2' });

    const url1 = await generatePresignedPutUrl(config1, 'same/key.txt');
    const url2 = await generatePresignedPutUrl(config2, 'same/key.txt');

    const sig1 = extractSignatureParams(url1).get('X-Amz-Signature');
    const sig2 = extractSignatureParams(url2).get('X-Amz-Signature');

    expect(sig1).not.toBe(sig2);
  });

  it('generates different signatures for different secret keys', async () => {
    const config1 = createTestConfig({ secretAccessKey: 'secret-1' });
    const config2 = createTestConfig({ secretAccessKey: 'secret-2' });

    const url1 = await generatePresignedPutUrl(config1, 'same/key.txt');
    const url2 = await generatePresignedPutUrl(config2, 'same/key.txt');

    const sig1 = extractSignatureParams(url1).get('X-Amz-Signature');
    const sig2 = extractSignatureParams(url2).get('X-Amz-Signature');

    expect(sig1).not.toBe(sig2);
  });

  it('includes access key ID in credential', async () => {
    const config = createTestConfig({ accessKeyId: 'MY-CUSTOM-KEY-ID' });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const credential = params.get('X-Amz-Credential');

    expect(credential).toContain('MY-CUSTOM-KEY-ID/');
  });

  it('uses bucket name in URL path', async () => {
    const config = createTestConfig({ bucketName: 'my-custom-bucket' });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/my-custom-bucket/test/key.txt');
  });
});

describe('query string parameter ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('orders parameters alphabetically in query string', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const parsed = new URL(url);
    const queryString = parsed.search.slice(1); // Remove leading '?'
    const paramNames = queryString.split('&').map((p) => p.split('=')[0]);

    // X-Amz-Signature is appended last, but other params should be sorted
    const paramsWithoutSignature = paramNames.filter(
      (p) => p !== 'X-Amz-Signature'
    );
    const sortedParams = [...paramsWithoutSignature].sort();

    expect(paramsWithoutSignature).toEqual(sortedParams);
  });
});

describe('timestamp handling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates different signatures at different times', async () => {
    const config = createTestConfig();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00Z'));
    const url1 = await generatePresignedPutUrl(config, 'test/key.txt');

    vi.setSystemTime(new Date('2024-06-15T10:01:00Z'));
    const url2 = await generatePresignedPutUrl(config, 'test/key.txt');

    const sig1 = extractSignatureParams(url1).get('X-Amz-Signature');
    const sig2 = extractSignatureParams(url2).get('X-Amz-Signature');

    // Signatures should differ because timestamp is part of the signed data
    expect(sig1).not.toBe(sig2);
  });

  it('generates different date stamps on different days', async () => {
    const config = createTestConfig();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:00:00Z'));
    const url1 = await generatePresignedPutUrl(config, 'test/key.txt');

    vi.setSystemTime(new Date('2024-06-16T10:00:00Z'));
    const url2 = await generatePresignedPutUrl(config, 'test/key.txt');

    const cred1 = extractSignatureParams(url1).get('X-Amz-Credential');
    const cred2 = extractSignatureParams(url2).get('X-Amz-Credential');

    expect(cred1).toContain('20240615');
    expect(cred2).toContain('20240616');
  });
});

describe('R2-specific behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses "auto" region for R2', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const credential = params.get('X-Amz-Credential');

    // Credential should contain "auto" as the region
    expect(credential).toContain('/auto/');
  });

  it('uses R2 endpoint format', async () => {
    const config = createTestConfig({ accountId: 'abc123' });
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const parsed = new URL(url);

    expect(parsed.hostname).toBe('abc123.r2.cloudflarestorage.com');
  });

  it('uses s3 as the service name in credential scope', async () => {
    const config = createTestConfig();
    const url = await generatePresignedPutUrl(config, 'test/key.txt');

    const params = extractSignatureParams(url);
    const credential = params.get('X-Amz-Credential');

    // Credential scope should contain "s3" service
    expect(credential).toContain('/s3/');
    expect(credential).toMatch(/\/auto\/s3\/aws4_request$/);
  });
});
