---
'@cloudflare/sandbox': minor
---

Add volume snapshot support for persisting container state across restarts.

New methods on Sandbox class:

- `configureSnapshots()` / `getSnapshotConfig()` - Configure snapshot settings
- `createSnapshot()` / `createSnapshotStream()` - Create snapshots with streaming progress
- `restoreSnapshot()` - Restore from R2
- `listSnapshots()` / `getSnapshotMetadata()` / `deleteSnapshotMetadata()` - Manage snapshots

Features:

- Manual snapshot/restore via presigned URLs
- Streaming progress events during snapshot creation
- Configurable compression levels (fast/balanced/max)
- Single per-sandbox snapshot key (`snapshots/<sandboxId>/latest.tar.zst`)

Includes example app demonstrating git clone + npm install persistence.
