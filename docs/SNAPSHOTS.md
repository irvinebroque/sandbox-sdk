# Volume Snapshots

Persist and restore container state across sandbox restarts using R2.

## Overview

Sandbox containers are ephemeral. When a sandbox sleeps or restarts, all filesystem state is lost. Volume snapshots capture a directory (typically `/workspace`) as a tar+zstd stream that is uploaded directly to R2 via presigned URLs.

This simplified snapshot flow is intentionally minimal:

- Manual create/restore only
- One snapshot key per sandbox: `snapshots/<sandboxId>/latest.tar.zst`
- No CDN cache, no lockfile hashing, no incremental manifests

## Quick Start

### 1. Configure snapshots

```ts
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  compressionLevel: 'fast',
  excludePatterns: []
});
```

### 2. Create a snapshot

```ts
import { generatePresignedPutUrl } from '@cloudflare/sandbox';

const r2Key = `snapshots/${sandboxId}/latest.tar.zst`;
const uploadUrl = await generatePresignedPutUrl(credentials, r2Key);

const metadata = await sandbox.createSnapshot(uploadUrl);
console.log(`Snapshot size: ${metadata.sizeBytes} bytes`);
```

### 3. Restore a snapshot

```ts
import { generatePresignedGetUrl } from '@cloudflare/sandbox';

const metadata = await sandbox.getSnapshotMetadata('latest');
if (!metadata) throw new Error('No snapshot found');

const downloadUrl = await generatePresignedGetUrl(credentials, metadata.r2Key);
await sandbox.restoreSnapshot(downloadUrl, 'latest');
```

## Configuration Reference

### SnapshotConfig

| Option             | Type                            | Default      | Description                            |
| ------------------ | ------------------------------- | ------------ | -------------------------------------- |
| `enabled`          | `boolean`                       | -            | **Required.** Enable snapshot features |
| `volumePath`       | `string`                        | -            | **Required.** Path to snapshot         |
| `compressionLevel` | `'fast' \| 'balanced' \| 'max'` | `'balanced'` | Zstd compression level                 |
| `excludePatterns`  | `string[]`                      | `[]`         | Glob patterns to exclude from snapshot |

### R2CredentialConfig

Used by `generatePresignedPutUrl` / `generatePresignedGetUrl`.

| Option            | Type     | Default        | Description                            |
| ----------------- | -------- | -------------- | -------------------------------------- |
| `accountId`       | `string` | -              | **Required.** Cloudflare account ID    |
| `bucketName`      | `string` | -              | **Required.** R2 bucket name           |
| `accessKeyId`     | `string` | -              | **Required.** S3 API access key ID     |
| `secretAccessKey` | `string` | -              | **Required.** S3 API secret access key |
| `keyPrefix`       | `string` | `'snapshots/'` | Optional object key prefix             |
| `urlExpiry`       | `number` | `3600`         | Presigned URL expiry (seconds)         |

### CreateSnapshotOptions

| Option       | Type                     | Default  | Description                 |
| ------------ | ------------------------ | -------- | --------------------------- |
| `snapshotId` | `string`                 | `latest` | Snapshot ID (only `latest`) |
| `tags`       | `Record<string, string>` | `{}`     | Metadata tags               |

### RestoreOptions

| Option | Type                 | Default   | Description                        |
| ------ | -------------------- | --------- | ---------------------------------- |
| `mode` | `'clean' \| 'merge'` | `'clean'` | Clean removes existing files first |

## Metadata

`getSnapshotMetadata('latest')` returns:

```ts
interface SnapshotMetadata {
  id: string;
  sandboxId: string;
  volumePath: string;
  createdAt: number;
  r2Key: string;
  sizeBytes: number;
  fileCount: number;
  lastRestoredAt?: number;
  restoreCount: number;
  tags: Record<string, string>;
}
```

## Notes

- Presigned URLs must use the `*.r2.cloudflarestorage.com` domain. Custom domains are not supported for presigned URLs.
- Snapshots are stored under `snapshots/<sandboxId>/latest.tar.zst` to keep the flow predictable and easy to debug.
- There is no automatic snapshotting; call `createSnapshot()` when you want to persist state.
