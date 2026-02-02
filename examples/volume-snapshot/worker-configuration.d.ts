/* eslint-disable */
// Type definitions for Cloudflare Worker environment
// Run `wrangler types` to regenerate the full type definitions

import type { Sandbox } from '@cloudflare/sandbox';

// Extend the Sandbox type with snapshot methods from the PR
// These types match the volume-snapshots PR (#1)
declare module '@cloudflare/sandbox' {
  interface SnapshotConfig {
    enabled: boolean;
    volumePath: string;
    maxSnapshots: number;
    compressionLevel: 'fast' | 'balanced' | 'max';
    excludePatterns: string[];
    autoSnapshotOnSleep?: boolean;
    autoRestoreOnWake?: boolean;
  }

  interface CreateSnapshotResponse {
    success: boolean;
    manifest?: unknown;
    contentHash?: string;
    stats?: {
      totalFiles: number;
      totalBytes: number;
      compressedBytes: number;
      duration: number;
      skippedFiles: number;
      unchangedFiles: number;
    };
    error?: string;
  }

  interface RestoreResult {
    success: boolean;
    snapshotId: string;
    stats: {
      filesRestored: number;
      bytesDownloaded: number;
      bytesExtracted: number;
      duration: number;
    };
  }

  type SnapshotPhase =
    | 'validating'
    | 'scanning'
    | 'compressing'
    | 'uploading'
    | 'complete'
    | 'error';

  interface SnapshotProgressEvent {
    type: 'phase' | 'complete' | 'error';
    phase: SnapshotPhase;
    message: string;
    stats?: {
      totalFiles?: number;
      totalBytes?: number;
      compressedBytes?: number;
      duration?: number;
    };
    error?: string;
  }

  interface Sandbox {
    configureSnapshots(config: SnapshotConfig): Promise<void>;
    createSnapshot(uploadUrl: string): Promise<CreateSnapshotResponse>;
    createSnapshotStream(
      uploadUrl: string
    ): AsyncGenerator<SnapshotProgressEvent, void, void>;
    restoreSnapshot(downloadUrl: string, snapshotId: string): Promise<RestoreResult>;
  }
}

declare global {
  interface Env {
    // Durable Object binding for sandbox instances
    Sandbox: DurableObjectNamespace<Sandbox>;

    // R2 bucket for storing volume snapshots
    SNAPSHOTS: R2Bucket;

    // R2 S3-compatible credentials for presigned URLs
    // These are needed because the container uploads/downloads directly to R2
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_ENDPOINT: string; // e.g., https://<account-id>.r2.cloudflarestorage.com
    R2_BUCKET_NAME: string; // e.g., sandbox-snapshots

    // Cloudflare account ID (used for auto-snapshot R2 credential configuration)
    CF_ACCOUNT_ID: string;
  }
}

export {};
