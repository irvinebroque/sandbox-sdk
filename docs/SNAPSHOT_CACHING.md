# Snapshot Caching

This document describes how to use Cloudflare's CDN cache for snapshot restores, reducing latency and R2 egress costs.

## Overview

By default, snapshot restores download directly from R2 using presigned URLs. While this works well, it doesn't leverage Cloudflare's CDN caching capabilities.

The snapshot caching feature puts Cloudflare's CDN in front of R2 for restore operations:

```
Without caching:  Sandbox Container → R2 (presigned URL)
With caching:     Sandbox Container → CDN Cache → R2 (on cache miss)
```

**Benefits:**

- Reduced latency for frequently restored snapshots
- Lower R2 egress costs (cache hits don't incur R2 bandwidth)
- Global distribution via Cloudflare's edge network

**This is an opt-in feature.** All existing code continues to work without changes.

## Prerequisites

Before enabling snapshot caching, you need:

1. **Custom domain** - A domain configured in Cloudflare (e.g., `snapshots.example.com`)
2. **R2 public bucket** - Or R2 bucket with custom domain
3. **Tiered Cache** - Recommended for best cache hit rates
4. **WAF Rule** - To validate signed URLs

### Setting Up the Custom Domain

1. Add a custom domain pointing to your R2 bucket in Cloudflare Dashboard
2. Enable Tiered Cache for better cache hit rates
3. Set appropriate cache rules for `.tar.zst` files

### Creating the WAF Rule

Create a WAF rule to validate HMAC signatures. This ensures only signed URLs can access your snapshots.

In **Security → WAF → Custom Rules**, create a rule:

**Rule name:** `Validate Snapshot HMAC`

**Expression:**

```
(http.host eq "snapshots.example.com" and not is_timed_hmac_valid_v0("your-hmac-secret", http.request.uri.path, 3600, http.request.timestamp.sec, raw.http.request.uri.query, "mac"))
```

**Action:** Block

This rule:

- Only applies to your snapshot domain
- Validates the HMAC signature using `is_timed_hmac_valid_v0()`
- Allows 3600 seconds (1 hour) clock skew tolerance
- Blocks requests with invalid or expired signatures

**Important:** Replace `"your-hmac-secret"` with your actual secret. Store this secret securely.

## Configuration

### Snapshot Config

Add cache configuration to your snapshot config:

```typescript
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  maxSnapshots: 5,
  compressionLevel: 'balanced',
  excludePatterns: ['node_modules/**', '.git/**'],
  autoSnapshotOnSleep: false,
  autoRestoreOnWake: false,

  // Cache configuration (all optional)
  cacheCustomDomain: 'snapshots.example.com', // Required to enable caching
  cacheHmacSecret: 'your-hmac-secret', // Fallback if env var not set
  cacheUrlTtl: 3600, // Default: 3600 (1 hour)
  cacheSizeLimit: 536870912 // Default: 512 MB
});
```

### HMAC Secret

The HMAC secret can be provided in three ways (in order of priority):

1. **Per-request** - `options.hmacSecret` in `restoreSnapshotFromCache()`
2. **Environment variable** - `SNAPSHOT_CACHE_HMAC_SECRET`
3. **Config** - `config.cacheHmacSecret`

**Recommended:** Use the environment variable to keep secrets out of code:

```toml
# wrangler.toml
[vars]
SNAPSHOT_CACHE_HMAC_SECRET = "your-secret-here"
```

Or use Cloudflare Secrets for production:

```bash
npx wrangler secret put SNAPSHOT_CACHE_HMAC_SECRET
```

## Usage

### Using the Cache

Use `restoreSnapshotFromCache()` to restore via the CDN cache:

```typescript
// Restore latest snapshot via cache
const result = await sandbox.restoreSnapshotFromCache();

// Restore specific snapshot via cache
const result = await sandbox.restoreSnapshotFromCache('snap-123');

// With options
const result = await sandbox.restoreSnapshotFromCache('snap-123', {
  mode: 'clean',
  hmacSecret: 'override-secret' // Optional per-request override
});
```

### Bypassing the Cache

To bypass the CDN cache, use `restoreSnapshot()` directly with a presigned URL instead of `restoreSnapshotFromCache()`:

```typescript
// Use presigned URL directly (bypasses cache)
import { generatePresignedGetUrl } from '@cloudflare/sandbox';

const metadata = await sandbox.getSnapshotMetadata('snap-123');
const presignedUrl = await generatePresignedGetUrl(credentials, metadata.r2Key);
await sandbox.restoreSnapshot(presignedUrl, metadata.id);
```

The `restoreSnapshotFromCache()` method is designed exclusively for CDN-cached restores and does not support bypassing the cache. When you need to skip the cache (for debugging or when the cache is unavailable), use `restoreSnapshot()` with a presigned URL as shown above.

### Automatic Fallback for Large Files

Files larger than `cacheSizeLimit` (default 512 MB) will cause `restoreSnapshotFromCache()` to throw an error. This prevents cache pollution with large files that may be evicted quickly.

For large snapshots, use `restoreSnapshot()` with a presigned URL:

```typescript
const metadata = await sandbox.getSnapshotMetadata('snap-123');
const config = await sandbox.getSnapshotConfig();

if (metadata.sizeBytes > (config.cacheSizeLimit ?? 536870912)) {
  // Large file - use presigned URL
  const presignedUrl = await generatePresignedGetUrl(
    credentials,
    metadata.r2Key
  );
  await sandbox.restoreSnapshot(presignedUrl, metadata.id);
} else {
  // Use cache
  await sandbox.restoreSnapshotFromCache(metadata.id);
}
```

## Configuration Reference

| Option              | Type     | Default     | Description                                                     |
| ------------------- | -------- | ----------- | --------------------------------------------------------------- |
| `cacheCustomDomain` | `string` | -           | Custom domain for cached downloads. Required to enable caching. |
| `cacheHmacSecret`   | `string` | -           | HMAC secret fallback if env var not set.                        |
| `cacheUrlTtl`       | `number` | `3600`      | TTL for signed cache URLs in seconds.                           |
| `cacheSizeLimit`    | `number` | `536870912` | Max file size in bytes to use cache (512 MB default).           |

### RestoreOptions

| Option        | Type                 | Default   | Description                                                           |
| ------------- | -------------------- | --------- | --------------------------------------------------------------------- |
| `mode`        | `'clean' \| 'merge'` | `'clean'` | How to handle existing files.                                         |
| `hmacSecret`  | `string`             | -         | Per-request HMAC secret override.                                     |
| `bypassCache` | `boolean`            | `false`   | Force error if trying to use cache (use `restoreSnapshot()` instead). |

## URL Format

Generated cache URLs follow this format:

```
https://{domain}{path}?mac={base64url_hmac}&expiry={unix_timestamp}
```

Example:

```
https://snapshots.example.com/snapshots/my-sandbox/snap-123.tar.zst?mac=abc123def456&expiry=1705323600
```

The HMAC is computed over `{path}{expiry}` using SHA-256, then base64url encoded.

## Troubleshooting

### "Cache not configured" Error

Ensure you have:

1. Set `cacheCustomDomain` in your snapshot config
2. Provided HMAC secret via env var, config, or options

### "HMAC secret not available" Error

The HMAC secret must be provided via one of:

- `SNAPSHOT_CACHE_HMAC_SECRET` environment variable
- `cacheHmacSecret` in snapshot config
- `hmacSecret` in restore options

### 403 Forbidden from Cache

Check your WAF rule:

- Verify the HMAC secret matches
- Ensure the URL hasn't expired
- Check that the path format matches expectations

### Cache Misses

If you're seeing frequent cache misses:

- Enable Tiered Cache in Cloudflare Dashboard
- Increase `cacheUrlTtl` to allow more time for cache population
- Check cache rules are correctly configured for your file types

### Large File Errors

Files exceeding `cacheSizeLimit` cannot use the cache. Either:

- Increase `cacheSizeLimit` (but be aware of cache eviction)
- Use `restoreSnapshot()` with presigned URLs for large files

## Security Considerations

1. **Keep HMAC secret secure** - Use Cloudflare Secrets for production
2. **Use reasonable TTLs** - Default 1 hour balances security and usability
3. **WAF rule is essential** - Without it, anyone could access your snapshots
4. **Rotate secrets periodically** - Update both config and WAF rule together
