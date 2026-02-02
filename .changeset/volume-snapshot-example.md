---
'@cloudflare/sandbox': patch
---

Add volume-snapshot example demonstrating how to persist container state across restarts.

The example shows:

- Cloning a git repository into the sandbox
- Installing npm dependencies
- Creating a snapshot of the workspace to R2
- Restoring from the snapshot on subsequent sandbox starts

This reduces cold start time from minutes (clone + npm install) to seconds (snapshot restore).
