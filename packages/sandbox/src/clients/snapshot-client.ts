/**
 * SnapshotClient - SDK client for container snapshot operations
 *
 * Provides typed methods for creating and restoring volume snapshots.
 */

import { BaseHttpClient } from './base-client';

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

/**
 * Manifest describing files in a snapshot
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

/**
 * Client for snapshot operations
 */
export class SnapshotClient extends BaseHttpClient {
  /**
   * Create a snapshot and upload to R2
   *
   * @param request - Snapshot creation parameters
   * @returns Response with manifest and stats on success
   */
  async create(
    request: CreateSnapshotRequest
  ): Promise<CreateSnapshotResponse> {
    try {
      const response = await this.post<CreateSnapshotResponse>(
        '/api/snapshot/create',
        request
      );

      if (response.success) {
        this.logSuccess(
          'Snapshot created',
          `${request.snapshotId} (${response.stats?.totalFiles || 0} files)`
        );
      }

      return response;
    } catch (error) {
      this.logError('createSnapshot', error);
      throw error;
    }
  }

  /**
   * Restore a snapshot from R2
   *
   * @param request - Snapshot restore parameters
   * @returns Response with stats on success
   */
  async restore(
    request: RestoreSnapshotRequest
  ): Promise<RestoreSnapshotResponse> {
    try {
      const response = await this.post<RestoreSnapshotResponse>(
        '/api/snapshot/restore',
        request
      );

      if (response.success) {
        this.logSuccess(
          'Snapshot restored',
          `${request.volumePath} (${response.stats?.filesRestored || 0} files)`
        );
      }

      return response;
    } catch (error) {
      this.logError('restoreSnapshot', error);
      throw error;
    }
  }

  /**
   * Get filesystem manifest for a volume path
   *
   * @param request - Manifest request parameters
   * @returns Response with file list on success
   */
  async getManifest(request: GetManifestRequest): Promise<GetManifestResponse> {
    try {
      const response = await this.post<GetManifestResponse>(
        '/api/snapshot/manifest',
        request
      );

      if (response.success) {
        this.logSuccess(
          'Manifest retrieved',
          `${request.volumePath} (${response.fileCount || 0} files)`
        );
      }

      return response;
    } catch (error) {
      this.logError('getManifest', error);
      throw error;
    }
  }
}
