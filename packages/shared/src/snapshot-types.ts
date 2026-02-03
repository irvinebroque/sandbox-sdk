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
  /** Uncompressed size in bytes */
  uncompressedBytes: number;
  /** Number of files in the snapshot */
  fileCount: number;
  /** SHA-256 hash of the archive content */
  contentHash: string;
  /** ID of base snapshot for incremental snapshots */
  baseSnapshotId?: string;
  /** Whether this is an incremental snapshot */
  isIncremental: boolean;
  /** Unix timestamp of last restore */
  lastRestoredAt?: number;
  /** Number of times this snapshot has been restored */
  restoreCount: number;
  /** Unix timestamp when snapshot expires (for auto-cleanup) */
  expiresAt?: number;
  /** User-defined tags for organization */
  tags: Record<string, string>;
}

/**
 * Manifest describing files in a snapshot
 * Used for incremental snapshots and validation
 */
export interface SnapshotManifest {
  /** Manifest format version */
  version: 1;
  /** ID of the snapshot this manifest belongs to */
  snapshotId: string;
  /** ID of base snapshot (for incremental) */
  baseSnapshotId?: string;
  /** List of files in the snapshot */
  files: FileEntry[];
  /** Paths deleted since base snapshot (for incremental) */
  deletedPaths: string[];
}

/**
 * Entry describing a single file in a snapshot
 */
export interface FileEntry {
  /** Relative path from volume root */
  path: string;
  /** Unix file mode (permissions) */
  mode: number;
  /** File size in bytes */
  size: number;
  /** Modification time as Unix timestamp */
  mtime: number;
  /** SHA-256 hash of file content */
  hash: string;
  /** Type of filesystem entry */
  type: 'file' | 'directory' | 'symlink';
  /** Target path for symlinks */
  symlinkTarget?: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for R2 credentials used by auto-snapshot/restore
 * Stored separately from SnapshotConfig for security - never exposed in getSnapshotConfig()
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
  /** Automatically create snapshot when container sleeps */
  autoSnapshotOnSleep: boolean;
  /** Automatically restore latest snapshot when container wakes */
  autoRestoreOnWake: boolean;
  /** Maximum number of snapshots to retain */
  maxSnapshots: number;
  /** Number of days to retain snapshots */
  retentionDays?: number;
  /** Default TTL for snapshots when not specified per-snapshot (e.g., '30d'). If not set, snapshots never expire. */
  defaultTtl?: string;
  /** Compression level for zstd */
  compressionLevel: 'fast' | 'balanced' | 'max';
  /** Glob patterns for files to exclude */
  excludePatterns: string[];

  // ============================================================================
  // CDN Cache Configuration (opt-in feature)
  // ============================================================================

  /**
   * Custom domain for cached downloads (e.g., "snapshots.example.com")
   * When configured, enables CDN caching for snapshot restores.
   * Requires Cloudflare custom domain with tiered cache and WAF rules.
   */
  cacheCustomDomain?: string;

  /**
   * HMAC secret for signing cached URLs
   * Fallback if SNAPSHOT_CACHE_HMAC_SECRET env var is not set.
   * The env var takes precedence over this config value.
   */
  cacheHmacSecret?: string;

  /**
   * TTL for signed cache URLs in seconds
   * @default 3600 (1 hour)
   */
  cacheUrlTtl?: number;

  /**
   * Maximum file size in bytes to use cache
   * Larger files will fall back to presigned URLs to avoid cache eviction issues.
   * @default 536870912 (512 MB - matches Free/Pro/Business cache limit)
   */
  cacheSizeLimit?: number;

  // ============================================================================
  // Content-Addressed Caching (opt-in feature)
  // ============================================================================

  /**
   * Enable content-addressed cache keys based on lockfile hashes
   * When enabled, snapshots are keyed by the hash of lockfile content,
   * allowing builds with identical dependencies to share snapshots.
   * @default false
   */
  useContentAddressedKeys?: boolean;

  /**
   * Path to lockfile for content-addressed key generation
   * If not specified, automatically detects from common lockfile paths:
   * package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb
   */
  lockfilePath?: string;

  /** Maximum snapshot size in bytes (default: no limit) */
  maxSnapshotSizeBytes?: number;
}

/**
 * Options for creating a snapshot
 */
export interface CreateSnapshotOptions {
  /** Optional snapshot ID (auto-generated if not provided) */
  snapshotId?: string;
  /** User-defined tags */
  tags?: Record<string, string>;
  /** Create incremental snapshot from latest */
  incremental?: boolean;
  /** TTL for this snapshot (e.g., '5d', '30d', '1w', 'forever'). If not set, uses config.defaultTtl or never expires. */
  ttl?: string;
}

/**
 * Options for restoring a snapshot
 */
export interface RestoreOptions {
  /** How to handle existing files */
  mode?: 'clean' | 'merge';

  /**
   * Override HMAC secret for this request
   * Takes highest priority over env var and config
   */
  hmacSecret?: string;

  /**
   * Force cache bypass (use presigned URL even if cache is configured)
   * Useful for debugging or when cache is temporarily unavailable
   */
  bypassCache?: boolean;
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
  /** Previous manifest for incremental snapshots */
  previousManifest?: SnapshotManifest;
  /** Operation timeout in milliseconds */
  timeout?: number;
  /** Maximum snapshot size in bytes (default: no limit) */
  maxSnapshotSizeBytes?: number;
}

/**
 * Response from snapshot creation
 */
export interface CreateSnapshotResponse {
  /** Whether creation succeeded */
  success: boolean;
  /** Manifest of files in snapshot */
  manifest?: SnapshotManifest;
  /** SHA-256 hash of archive content */
  contentHash?: string;
  /** Statistics from creation */
  stats?: {
    totalFiles: number;
    totalBytes: number;
    compressedBytes: number;
    duration: number;
    skippedFiles: number;
    unchangedFiles: number;
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
  /** Manifest for validation */
  manifest: SnapshotManifest;
  /** Expected SHA-256 hash for verification */
  expectedHash?: string;
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

/**
 * Request to get current filesystem manifest
 */
export interface GetManifestRequest {
  /** Path to scan */
  volumePath: string;
  /** Glob patterns for files to exclude */
  excludePatterns: string[];
}

/**
 * Response with filesystem manifest
 */
export interface GetManifestResponse {
  /** Whether operation succeeded */
  success: boolean;
  /** List of files found */
  files?: FileEntry[];
  /** Total size of all files */
  totalSize?: number;
  /** Number of files found */
  fileCount?: number;
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
  | 'scanning'
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
    totalFiles?: number;
    totalBytes?: number;
    compressedBytes?: number;
    duration?: number;
  };
  /** SHA-256 hash of archive content (only present in 'complete' events) */
  contentHash?: string;
  /** Error message if type is 'error' */
  error?: string;
}
