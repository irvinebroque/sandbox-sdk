---
'@cloudflare/sandbox': minor
---

Add volume snapshot support for persisting container state across restarts.

New methods on Sandbox class:

- `configureSnapshots()` / `getSnapshotConfig()` - Configure snapshot settings
- `configureR2Credentials()` / `clearR2Credentials()` / `hasR2Credentials()` - Manage R2 credentials
- `createSnapshot()` / `createSnapshotStream()` - Create snapshots with streaming progress
- `restoreSnapshot()` / `restoreSnapshotFromCache()` - Restore from R2 or CDN cache
- `listSnapshots()` / `getSnapshotMetadata()` / `deleteSnapshotMetadata()` - Manage snapshots

Features:

- Automatic snapshot on sleep / restore on wake
- CDN caching for faster restores via signed URLs
- Content-addressed keys for deduplication (skip upload if unchanged)
- Streaming progress events during snapshot creation
- Configurable compression levels (fast/balanced/max)

Includes example app demonstrating git clone + npm install persistence.
