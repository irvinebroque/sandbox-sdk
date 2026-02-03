# Volume Snapshots

Persist and restore container state across sandbox restarts.

## Overview

### The Problem

Sandbox containers are ephemeral. When a sandbox sleeps due to inactivity (default: 10 minutes) or restarts for any reason, all filesystem state is lost:

- Cloned repositories must be re-cloned (~10-30 seconds)
- Installed dependencies must be reinstalled (~30-120 seconds)
- Generated files, caches, and build artifacts are gone

This cold start penalty impacts user experience and increases compute costs.

### The Solution

Volume snapshots capture the contents of a directory (typically `/workspace`) as a compressed archive stored in R2 or any S3-compatible storage. When the sandbox wakes up, the snapshot is automatically restored, bringing the container back to its previous state in seconds.

```
Without snapshots:  Clone repo (30s) + npm install (90s) = ~2 minutes
With snapshots:     Restore snapshot (~10-30s)
```

Snapshots use **tar + zstd compression** for efficient streaming directly between the container and R2, without routing through your Worker.

## Quick Start

### 1. Configure R2 Credentials

Store your R2 credentials in the Durable Object for auto-snapshot/restore functionality:

```typescript
await sandbox.configureR2Credentials({
  accountId: env.CF_ACCOUNT_ID,
  bucketName: env.R2_BUCKET_NAME,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  keyPrefix: 'snapshots/' // Optional, defaults to 'snapshots/'
});
```

### 2. Configure Snapshots

Enable snapshots and configure behavior:

```typescript
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  maxSnapshots: 5,
  compressionLevel: 'balanced',
  excludePatterns: ['node_modules/.cache/**', '.git/objects/**'],
  autoSnapshotOnSleep: true,
  autoRestoreOnWake: true
});
```

**Note:** Steps 3 and 4 below show manual snapshot creation. For most use cases, the recommended approach is automatic snapshots (see [Auto-Snapshot](#auto-snapshot-recommended) below).

### 3. Create a Snapshot (Manual)

For manual snapshot control, generate a presigned URL and create the snapshot:

```typescript
import { generatePresignedPutUrl } from '@cloudflare/sandbox';

const snapshotId = `snap-${Date.now()}`;
const r2Key = `snapshots/${sandboxId}/${snapshotId}.tar.zst`;
const uploadUrl = await generatePresignedPutUrl(credentials, r2Key);

const metadata = await sandbox.createSnapshot(uploadUrl, {
  snapshotId,
  tags: { purpose: 'manual-backup' }
});

console.log(`Created snapshot: ${metadata.id} (${metadata.sizeBytes} bytes)`);
```

### 4. Restore a Snapshot (Manual)

```typescript
import { generatePresignedGetUrl } from '@cloudflare/sandbox';

const metadata = await sandbox.getSnapshotMetadata('snap-123');
const downloadUrl = await generatePresignedGetUrl(credentials, metadata.r2Key);

const result = await sandbox.restoreSnapshot(downloadUrl, metadata.id, {
  mode: 'clean' // Remove existing files before restore
});

console.log(`Restored ${result.stats.filesRestored} files`);
```

## Auto-Snapshot (Recommended)

The recommended approach is to enable automatic snapshots. With auto-snapshot enabled:

1. **On sleep**: A snapshot is automatically created before the container stops
2. **On wake**: The latest snapshot is automatically restored when the container starts

```typescript
// One-time setup (typically in your Worker's first request handler)
await sandbox.configureR2Credentials({
  accountId: env.CF_ACCOUNT_ID,
  bucketName: env.R2_BUCKET_NAME,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY
});

await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  maxSnapshots: 5,
  compressionLevel: 'balanced',
  excludePatterns: [],
  autoSnapshotOnSleep: true, // Create snapshot before sleep
  autoRestoreOnWake: true // Restore snapshot on wake
});
```

After this setup, snapshots happen automatically. Users see fast container startup times without any additional code.

## Content-Addressed Caching

Content-addressed caching optimizes snapshot uploads by detecting when the workspace content hasn't changed. This is particularly useful for CI/CD scenarios where multiple builds with identical dependencies would otherwise create duplicate snapshots.

### How It Works

1. When creating a snapshot, the SDK computes a hash of the lockfile (e.g., `package-lock.json`)
2. This hash becomes the "cache key" for the snapshot
3. On subsequent snapshot attempts, if the cache key matches the last restored snapshot, the upload is skipped

### Configuration

```typescript
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',

  // Enable content-addressed caching
  useContentAddressedKeys: true,

  // Optional: specify lockfile path (auto-detected if not set)
  lockfilePath: '/workspace/package-lock.json'
});
```

### Supported Lockfiles

When `lockfilePath` is not specified, the SDK auto-detects these lockfiles in order:

- `package-lock.json` (npm)
- `pnpm-lock.yaml` (pnpm)
- `yarn.lock` (yarn)
- `bun.lock` / `bun.lockb` (bun)

### Skip-If-Restored Optimization

When `useContentAddressedKeys` is enabled, `createSnapshot()` returns `null` if the content is unchanged from the last restore:

```typescript
const result = await sandbox.createSnapshot(uploadUrl);

if (result === null) {
  console.log('Snapshot skipped - content unchanged');
} else {
  console.log(`Created snapshot: ${result.id}`);
}
```

## CDN Caching

For frequently restored snapshots, you can put Cloudflare's CDN in front of R2 to reduce latency and egress costs. This requires additional infrastructure setup.

See [SNAPSHOT_CACHING.md](./SNAPSHOT_CACHING.md) for detailed setup instructions covering:

- Custom domain configuration
- WAF rules for HMAC validation
- Tiered cache setup
- Size limit considerations

Quick usage once configured:

```typescript
// Configure CDN caching
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  cacheCustomDomain: 'snapshots.example.com',
  cacheHmacSecret: env.SNAPSHOT_CACHE_HMAC_SECRET, // Or use env var
  cacheUrlTtl: 3600, // URL validity: 1 hour
  cacheSizeLimit: 512_000_000 // 512 MB max for cache
});

// Restore via CDN cache
const result = await sandbox.restoreSnapshotFromCache('snap-123');
```

## Configuration Reference

### SnapshotConfig Options

| Option                    | Type                            | Default      | Description                                             |
| ------------------------- | ------------------------------- | ------------ | ------------------------------------------------------- |
| `enabled`                 | `boolean`                       | -            | **Required.** Enable snapshot functionality             |
| `volumePath`              | `string`                        | -            | **Required.** Path to snapshot (e.g., `/workspace`)     |
| `autoSnapshotOnSleep`     | `boolean`                       | `false`      | Create snapshot automatically when container sleeps     |
| `autoRestoreOnWake`       | `boolean`                       | `false`      | Restore latest snapshot when container wakes            |
| `maxSnapshots`            | `number`                        | -            | Maximum snapshots to retain (oldest pruned first)       |
| `retentionDays`           | `number`                        | -            | Days to retain snapshots (deprecated, use `defaultTtl`) |
| `defaultTtl`              | `string`                        | -            | Default TTL for new snapshots (e.g., `'30d'`)           |
| `compressionLevel`        | `'fast' \| 'balanced' \| 'max'` | `'balanced'` | Zstd compression level                                  |
| `excludePatterns`         | `string[]`                      | `[]`         | Glob patterns for files to exclude                      |
| `useContentAddressedKeys` | `boolean`                       | `false`      | Enable lockfile-based cache keys                        |
| `lockfilePath`            | `string`                        | -            | Explicit lockfile path (auto-detected if not set)       |
| `maxSnapshotSizeBytes`    | `number`                        | -            | Maximum allowed snapshot size                           |
| `cacheCustomDomain`       | `string`                        | -            | Custom domain for CDN-cached downloads                  |
| `cacheHmacSecret`         | `string`                        | -            | HMAC secret fallback (prefer env var)                   |
| `cacheUrlTtl`             | `number`                        | `3600`       | TTL for signed cache URLs (seconds)                     |
| `cacheSizeLimit`          | `number`                        | `536870912`  | Max file size for cache (512 MB)                        |

**Note:** `retentionDays` is deprecated. Use `defaultTtl` instead, which supports more flexible time formats like '30d', '1w', '1m', or 'forever'.

### R2CredentialConfig Options

| Option            | Type     | Default        | Description                            |
| ----------------- | -------- | -------------- | -------------------------------------- |
| `accountId`       | `string` | -              | **Required.** Cloudflare account ID    |
| `bucketName`      | `string` | -              | **Required.** R2 bucket name           |
| `accessKeyId`     | `string` | -              | **Required.** S3 API access key ID     |
| `secretAccessKey` | `string` | -              | **Required.** S3 API secret access key |
| `keyPrefix`       | `string` | `'snapshots/'` | Prefix for snapshot objects in bucket  |
| `urlExpiry`       | `number` | `3600`         | Presigned URL expiry (seconds)         |

### CreateSnapshotOptions

| Option        | Type                     | Default             | Description                          |
| ------------- | ------------------------ | ------------------- | ------------------------------------ |
| `snapshotId`  | `string`                 | Auto-generated      | Custom snapshot ID                   |
| `tags`        | `Record<string, string>` | `{}`                | User-defined metadata tags           |
| `incremental` | `boolean`                | `false`             | Create incremental snapshot (future) |
| `ttl`         | `string`                 | `config.defaultTtl` | TTL for this snapshot                |

### RestoreOptions

| Option        | Type                 | Default   | Description                                            |
| ------------- | -------------------- | --------- | ------------------------------------------------------ |
| `mode`        | `'clean' \| 'merge'` | `'clean'` | `clean`: remove existing files first; `merge`: overlay |
| `hmacSecret`  | `string`             | -         | Per-request HMAC secret override                       |
| `bypassCache` | `boolean`            | `false`   | Skip CDN cache (use with `restoreSnapshot()`)          |

## API Reference

### Configuration Methods

#### `configureSnapshots(config: SnapshotConfig): Promise<void>`

Configure snapshot settings. Must be called before using snapshot features.

#### `getSnapshotConfig(): Promise<SnapshotConfig | null>`

Get current snapshot configuration.

#### `configureR2Credentials(config: R2CredentialConfig): Promise<void>`

Store R2 credentials for auto-snapshot/restore. Credentials are stored securely in Durable Object storage and never exposed via `getSnapshotConfig()`.

#### `clearR2Credentials(): Promise<void>`

Remove stored R2 credentials.

#### `hasR2Credentials(): Promise<boolean>`

Check if R2 credentials are configured.

### Snapshot Operations

#### `createSnapshot(uploadUrl: string, options?: CreateSnapshotOptions): Promise<SnapshotMetadata | null>`

Create a snapshot and upload to the provided presigned URL. Returns `null` if content-addressed caching detects no changes.

#### `createSnapshotStream(uploadUrl: string, options?: CreateSnapshotOptions): Promise<ReadableStream<Uint8Array>>`

Create a snapshot with streaming progress events. Returns an SSE stream.

```typescript
import { parseSSEStream, SnapshotProgressEvent } from '@cloudflare/sandbox';

const stream = await sandbox.createSnapshotStream(uploadUrl);
for await (const event of parseSSEStream<SnapshotProgressEvent>(stream)) {
  console.log(`${event.phase}: ${event.message}`);
  if (event.stats) {
    console.log(
      `  Files: ${event.stats.totalFiles}, Size: ${event.stats.compressedBytes}`
    );
  }
}
```

#### `restoreSnapshot(downloadUrl: string, snapshotId?: string, options?: RestoreOptions): Promise<RestoreResult>`

Restore a snapshot from the provided presigned URL.

#### `restoreSnapshotFromCache(snapshotId?: string, options?: RestoreOptions): Promise<RestoreResult>`

Restore a snapshot using the CDN cache. Requires `cacheCustomDomain` and HMAC secret to be configured.

### Metadata Operations

#### `listSnapshots(): Promise<SnapshotMetadata[]>`

List all snapshots. Automatically filters out and cleans up expired snapshots.

#### `getSnapshotMetadata(snapshotId: string): Promise<SnapshotMetadata | null>`

Get metadata for a specific snapshot.

#### `deleteSnapshotMetadata(snapshotId: string): Promise<void>`

Delete a snapshot's metadata. Does not delete the R2 object (use R2 lifecycle rules for that).

#### `getVolumeManifest(): Promise<GetManifestResponse>`

Get the current filesystem manifest for the configured volume path.

## TTL and Retention

### TTL Format

Snapshot TTL (time-to-live) can be specified using these formats:

| Format  | Example     | Description       |
| ------- | ----------- | ----------------- |
| Days    | `'5d'`      | 5 days            |
| Weeks   | `'1w'`      | 1 week (7 days)   |
| Months  | `'1m'`      | 1 month (30 days) |
| Years   | `'1y'`      | 1 year (365 days) |
| Forever | `'forever'` | Never expires     |

### Retention Strategies

1. **TTL-based**: Set `defaultTtl` in config or `ttl` per-snapshot
2. **Count-based**: Set `maxSnapshots` to limit total snapshots (oldest pruned first)
3. **Combined**: Use both for defense-in-depth

```typescript
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  maxSnapshots: 10, // Keep at most 10 snapshots
  defaultTtl: '30d' // Each expires after 30 days
});
```

### R2 Lifecycle Rules

The SDK only manages metadata. For actual R2 object deletion, configure R2 lifecycle rules:

1. Go to R2 bucket settings in Cloudflare Dashboard
2. Add a lifecycle rule to delete objects older than your retention period
3. Consider a rule to delete objects matching `snapshots/*` after 90 days

## Error Handling

### Common Errors

| Error                                          | Cause                             | Solution                                                  |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `Snapshots not configured`                     | `configureSnapshots()` not called | Call `configureSnapshots()` before using snapshot methods |
| `Snapshots are disabled`                       | `enabled: false` in config        | Set `enabled: true` in configuration                      |
| `No snapshots available`                       | No snapshots exist for restore    | Create a snapshot first or handle gracefully              |
| `Snapshot not found`                           | Invalid snapshot ID               | Verify ID with `listSnapshots()`                          |
| `snapshotId must be 64 characters or less`     | ID too long                       | Use shorter IDs                                           |
| `snapshotId must contain only alphanumeric...` | Invalid characters in ID          | Use only `a-z`, `A-Z`, `0-9`, `-`, `_`                    |

### Handling Restore Failures

```typescript
try {
  await sandbox.restoreSnapshot(downloadUrl, snapshotId);
} catch (error) {
  console.error('Restore failed:', error.message);

  // Fallback: set up from scratch
  await sandbox.gitCheckout('https://github.com/org/repo');
  await sandbox.exec('npm install');
}
```

### Auto-Snapshot Failures

Auto-snapshot failures are logged but don't block container shutdown:

- First attempt failure triggers one retry
- Second failure logs an error and proceeds with shutdown
- Container will have stale or no snapshot on next wake

Monitor your logs for `Auto-snapshot failed after retry` warnings.

## Security Considerations

### Credential Storage

- R2 credentials are stored in Durable Object storage (encrypted at rest)
- Credentials are never exposed via `getSnapshotConfig()`
- Use Cloudflare Secrets in production: `npx wrangler secret put R2_SECRET_ACCESS_KEY`

### Presigned URLs

- Presigned URLs expire after 15 minutes by default (configurable via `urlExpiry`)
- URLs grant temporary access to specific objects only
- Generate URLs server-side, never expose credentials to clients

### Snapshot ID Validation

- IDs are validated to prevent path traversal attacks
- Maximum 64 characters
- Alphanumeric, hyphens, and underscores only

### HTTPS

- All snapshot uploads and downloads use HTTPS
- Presigned URLs require HTTPS
- CDN cache URLs are always HTTPS

## SnapshotMetadata Reference

Metadata stored for each snapshot:

```typescript
interface SnapshotMetadata {
  id: string; // Unique snapshot identifier
  sandboxId: string; // Sandbox that created this snapshot
  volumePath: string; // Path that was snapshotted
  createdAt: number; // Unix timestamp (ms)
  r2Key: string; // R2 object key
  sizeBytes: number; // Compressed size
  uncompressedBytes: number; // Original size
  fileCount: number; // Number of files
  contentHash: string; // SHA-256 of archive
  isIncremental: boolean; // Always false (incremental not yet supported)
  lastRestoredAt?: number; // Last restore timestamp
  restoreCount: number; // Total restore count
  expiresAt?: number; // Expiration timestamp
  tags: Record<string, string>; // User-defined tags
}
```

## See Also

- [SNAPSHOT_CACHING.md](./SNAPSHOT_CACHING.md) - CDN caching setup and configuration
- [examples/volume-snapshot](../examples/volume-snapshot) - Complete working example
- [R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) - Cloudflare R2 documentation
