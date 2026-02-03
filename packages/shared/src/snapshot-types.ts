/**
 * Volume Snapshot Types
 *
 * Types for persisting and restoring container filesystem state via R2 storage.
 * Uses tar/zstd streaming pipeline without FUSE for simple, reliable operation.
 */

// ============================================================================
// Metadata Types
// ============================================================================

/**
 * Metadata for a stored snapshot
 * Persisted in Durable Object storage for tracking and retrieval
 */
export interface SnapshotMetadata {
  /** Unique identifier for this snapshot */
  id: string;
  /** ID of the sandbox that created this snapshot */
  sandboxId: string;
  /** Volume path that was snapshotted */
  volumePath: string;
  /** Unix timestamp when snapshot was created */
  createdAt: number;
  /** R2 object key for the snapshot archive */
  r2Key: string;
  /** Compressed size in bytes */
  sizeBytes: number;
  /** Number of files in the snapshot (best-effort) */
  fileCount: number;
  /** Unix timestamp of last restore */
  lastRestoredAt?: number;
  /** Number of times this snapshot has been restored */
  restoreCount: number;
  /** User-defined tags for organization */
  tags: Record<string, string>;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for R2 credentials used to generate presigned URLs
 */
export interface R2CredentialConfig {
  /** Cloudflare account ID */
  accountId: string;
  /** R2 bucket name */
  bucketName: string;
  /** S3 API access key ID */
  accessKeyId: string;
  /** S3 API secret access key */
  secretAccessKey: string;
  /** Key prefix for snapshots (default: "snapshots/") */
  keyPrefix?: string;
  /** Presigned URL expiry in seconds (default: 3600) */
  urlExpiry?: number;
}

/**
 * Configuration for snapshot behavior
 * Stored in Durable Object storage
 */
export interface SnapshotConfig {
  /** Whether snapshots are enabled */
  enabled: boolean;
  /** Path to the volume to snapshot */
  volumePath: string;
  /** Compression level for zstd */
  compressionLevel?: 'fast' | 'balanced' | 'max';
  /** Glob patterns for files to exclude */
  excludePatterns?: string[];
}

/**
 * Options for creating a snapshot
 */
export interface CreateSnapshotOptions {
  /** Optional snapshot ID (defaults to 'latest'; only 'latest' is supported) */
  snapshotId?: string;
  /** User-defined tags */
  tags?: Record<string, string>;
}

/**
 * Options for restoring a snapshot
 */
export interface RestoreOptions {
  /** How to handle existing files */
  mode?: 'clean' | 'merge';
}

/**
 * Result from restore operation
 */
export interface RestoreResult {
  /** Whether restore succeeded */
  success: boolean;
  /** ID of snapshot that was restored */
  snapshotId: string;
  /** Statistics from restore */
  stats: {
    filesRestored: number;
    bytesDownloaded: number;
    bytesExtracted: number;
    duration: number;
  };
}

// ============================================================================
// Container API Request/Response Types
// ============================================================================

/**
 * Request to create a snapshot in the container
 */
export interface CreateSnapshotRequest {
  /** Unique ID for this snapshot */
  snapshotId: string;
  /** Path to snapshot */
  volumePath: string;
  /** Presigned URL to upload archive to R2 */
  uploadUrl: string;
  /** Zstd compression level (1-19) */
  compressionLevel: number;
  /** Glob patterns for files to exclude */
  excludePatterns: string[];
  /** Operation timeout in milliseconds */
  timeout?: number;
}

/**
 * Response from snapshot creation
 */
export interface CreateSnapshotResponse {
  /** Whether creation succeeded */
  success: boolean;
  /** Statistics from creation */
  stats?: {
    totalBytes?: number;
    compressedBytes?: number;
    duration?: number;
  };
  /** Error message if failed */
  error?: string;
}

/**
 * Request to restore a snapshot in the container
 */
export interface RestoreSnapshotRequest {
  /** Path to restore to */
  volumePath: string;
  /** Snapshots to download and apply (in order) */
  downloads: DownloadSpec[];
  /** How to handle existing files: 'clean' removes all, 'merge' keeps unmodified */
  mode: 'clean' | 'merge';
  /** Operation timeout in milliseconds */
  timeout?: number;
}

/**
 * Specification for a snapshot to download
 */
export interface DownloadSpec {
  /** ID of the snapshot */
  snapshotId: string;
  /** Presigned URL to download from R2 */
  url: string;
}

/**
 * Response from snapshot restore
 */
export interface RestoreSnapshotResponse {
  /** Whether restore succeeded */
  success: boolean;
  /** Statistics from restore */
  stats?: {
    filesRestored: number;
    bytesDownloaded: number;
    bytesExtracted: number;
    duration: number;
    snapshotsApplied: number;
  };
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Streaming Progress Types
// ============================================================================

/**
 * Phase of snapshot creation
 */
export type SnapshotPhase =
  | 'validating'
  | 'compressing'
  | 'uploading'
  | 'complete'
  | 'error';

/**
 * Progress event emitted during snapshot creation
 * Used for streaming progress updates to the client
 */
export interface SnapshotProgressEvent {
  /** Event type */
  type: 'phase' | 'complete' | 'error';
  /** Current phase of the operation */
  phase: SnapshotPhase;
  /** Human-readable progress message */
  message: string;
  /** Statistics available at this point */
  stats?: {
    totalBytes?: number;
    compressedBytes?: number;
    duration?: number;
  };
  /** Error message if type is 'error' */
  error?: string;
}
