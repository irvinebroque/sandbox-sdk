import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateSignedCacheUrl,
  isSignedUrlExpired,
  parseSignedCacheUrl
} from '../../src/utils/cache-signing';

describe('generateSignedCacheUrl', () => {
  beforeEach(() => {
    // Mock Date.now for predictable timestamps
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates valid URL format with mac and expiry params', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/snapshots/sandbox-123/snap-456.tar.zst',
      'my-secret-key',
      3600
    );

    // Parse the URL
    const parsed = new URL(url);

    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('snapshots.example.com');
    expect(parsed.pathname).toBe('/snapshots/sandbox-123/snap-456.tar.zst');
    expect(parsed.searchParams.has('mac')).toBe(true);
    expect(parsed.searchParams.has('expiry')).toBe(true);
  });

  it('calculates correct expiry timestamp', async () => {
    const ttlSeconds = 3600; // 1 hour
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/test/path',
      'secret',
      ttlSeconds
    );

    const parsed = new URL(url);
    const expiry = parseInt(parsed.searchParams.get('expiry')!, 10);

    // Current time: 2024-01-15T12:00:00Z = 1705320000 unix timestamp
    // Expected expiry: 1705320000 + 3600 = 1705323600
    const expectedExpiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    expect(expiry).toBe(expectedExpiry);
  });

  it('generates different MACs for different paths', async () => {
    const url1 = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/path/one',
      'secret',
      3600
    );

    const url2 = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/path/two',
      'secret',
      3600
    );

    const mac1 = new URL(url1).searchParams.get('mac');
    const mac2 = new URL(url2).searchParams.get('mac');

    expect(mac1).not.toBe(mac2);
  });

  it('generates different MACs for different secrets', async () => {
    const url1 = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/same/path',
      'secret-one',
      3600
    );

    const url2 = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/same/path',
      'secret-two',
      3600
    );

    const mac1 = new URL(url1).searchParams.get('mac');
    const mac2 = new URL(url2).searchParams.get('mac');

    expect(mac1).not.toBe(mac2);
  });

  it('generates base64url encoded MAC (no +, /, or =)', async () => {
    // Generate multiple URLs to increase chance of hitting characters that would be replaced
    for (let i = 0; i < 10; i++) {
      const url = await generateSignedCacheUrl(
        'snapshots.example.com',
        `/path/${i}/test`,
        `secret-${i}`,
        3600
      );

      const mac = new URL(url).searchParams.get('mac')!;

      // Base64url should not contain +, /, or =
      expect(mac).not.toContain('+');
      expect(mac).not.toContain('/');
      expect(mac).not.toContain('=');

      // Should only contain base64url characters
      expect(mac).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('handles paths with special characters', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/snapshots/user-name_123/snap-2024-01-15.tar.zst',
      'secret',
      3600
    );

    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      '/snapshots/user-name_123/snap-2024-01-15.tar.zst'
    );
    expect(parsed.searchParams.has('mac')).toBe(true);
  });

  it('handles empty path', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/',
      'secret',
      3600
    );

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/');
    expect(parsed.searchParams.has('mac')).toBe(true);
  });

  it('handles very short TTL', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/test',
      'secret',
      1 // 1 second TTL
    );

    const parsed = new URL(url);
    const expiry = parseInt(parsed.searchParams.get('expiry')!, 10);
    const now = Math.floor(Date.now() / 1000);

    expect(expiry).toBe(now + 1);
  });

  it('handles very long TTL', async () => {
    const oneYear = 365 * 24 * 60 * 60;
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/test',
      'secret',
      oneYear
    );

    const parsed = new URL(url);
    const expiry = parseInt(parsed.searchParams.get('expiry')!, 10);
    const now = Math.floor(Date.now() / 1000);

    expect(expiry).toBe(now + oneYear);
  });
});

describe('parseSignedCacheUrl', () => {
  it('parses valid signed URL', () => {
    const url =
      'https://snapshots.example.com/path/to/file?mac=abc123&expiry=1705323600';

    const result = parseSignedCacheUrl(url);

    expect(result).toEqual({
      domain: 'snapshots.example.com',
      path: '/path/to/file',
      mac: 'abc123',
      expiry: 1705323600
    });
  });

  it('returns null for URL without mac', () => {
    const url = 'https://snapshots.example.com/path?expiry=1705323600';
    expect(parseSignedCacheUrl(url)).toBeNull();
  });

  it('returns null for URL without expiry', () => {
    const url = 'https://snapshots.example.com/path?mac=abc123';
    expect(parseSignedCacheUrl(url)).toBeNull();
  });

  it('returns null for invalid expiry', () => {
    const url =
      'https://snapshots.example.com/path?mac=abc123&expiry=notanumber';
    expect(parseSignedCacheUrl(url)).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(parseSignedCacheUrl('not-a-url')).toBeNull();
  });

  it('handles URL with additional query params', () => {
    const url =
      'https://snapshots.example.com/path?mac=abc123&expiry=1705323600&extra=param';

    const result = parseSignedCacheUrl(url);

    expect(result).toEqual({
      domain: 'snapshots.example.com',
      path: '/path',
      mac: 'abc123',
      expiry: 1705323600
    });
  });
});

describe('isSignedUrlExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set current time to 2024-01-15T12:00:00Z (1705320000)
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for URL with future expiry', () => {
    // Expiry is 1 hour in the future
    const url =
      'https://snapshots.example.com/path?mac=abc123&expiry=1705323600';
    expect(isSignedUrlExpired(url)).toBe(false);
  });

  it('returns true for URL with past expiry', () => {
    // Expiry is 1 hour in the past
    const url =
      'https://snapshots.example.com/path?mac=abc123&expiry=1705316400';
    expect(isSignedUrlExpired(url)).toBe(true);
  });

  it('returns true when expiry equals current time', () => {
    // Expiry is exactly now (1705320000)
    const url =
      'https://snapshots.example.com/path?mac=abc123&expiry=1705320000';
    expect(isSignedUrlExpired(url)).toBe(true);
  });

  it('returns null for invalid URL', () => {
    expect(isSignedUrlExpired('not-a-url')).toBeNull();
  });

  it('returns null for URL without required params', () => {
    const url = 'https://snapshots.example.com/path';
    expect(isSignedUrlExpired(url)).toBeNull();
  });
});

describe('integration: generateSignedCacheUrl -> parseSignedCacheUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generated URL can be parsed back correctly', async () => {
    const domain = 'snapshots.example.com';
    const path = '/snapshots/my-sandbox/snap-123.tar.zst';
    const ttl = 7200; // 2 hours

    const url = await generateSignedCacheUrl(domain, path, 'secret', ttl);
    const parsed = parseSignedCacheUrl(url);

    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe(domain);
    expect(parsed!.path).toBe(path);
    expect(parsed!.mac).toBeTruthy();
    expect(parsed!.expiry).toBe(Math.floor(Date.now() / 1000) + ttl);
  });

  it('generated URL is not expired immediately', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/test',
      'secret',
      3600
    );

    expect(isSignedUrlExpired(url)).toBe(false);
  });

  it('generated URL expires after TTL', async () => {
    const url = await generateSignedCacheUrl(
      'snapshots.example.com',
      '/test',
      'secret',
      3600 // 1 hour
    );

    // Not expired initially
    expect(isSignedUrlExpired(url)).toBe(false);

    // Advance time by 2 hours
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // Now expired
    expect(isSignedUrlExpired(url)).toBe(true);
  });
});
