/**
 * SnapshotService - Manages volume snapshots using tar/zstd
 *
 * Creates and restores filesystem snapshots via streaming tar archives
 * compressed with zstd. No FUSE required - direct shell operations.
 */

import type { Logger } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type { SessionManager } from './session-manager';

/**
 * Entry describing a single file in a snapshot
 */
interface FileEntry {
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
interface SnapshotManifest {
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
interface DownloadSpec {
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
 * Map compression level names to zstd numeric levels
 */
function getZstdLevel(level: 'fast' | 'balanced' | 'max' | number): number {
  if (typeof level === 'number') {
    return Math.max(1, Math.min(19, level));
  }
  switch (level) {
    case 'fast':
      return 1;
    case 'balanced':
      return 3;
    case 'max':
      return 19;
    default:
      return 3;
  }
}

/**
 * Session ID used for snapshot operations
 * Uses a dedicated session to avoid interfering with user sessions
 */
const SNAPSHOT_SESSION_ID = '__snapshot__';

export class SnapshotService {
  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  /**
   * Create a snapshot of a volume path and upload to R2
   *
   * Pipeline: find files -> tar --create --zstd -> PUT to uploadUrl
   */
  async createSnapshot(
    request: CreateSnapshotRequest
  ): Promise<CreateSnapshotResponse> {
    const startTime = Date.now();
    const {
      snapshotId,
      volumePath,
      uploadUrl,
      compressionLevel,
      excludePatterns,
      timeout
    } = request;

    this.logger.info('Creating snapshot', {
      snapshotId,
      volumePath,
      compressionLevel
    });

    try {
      // 1. Validate volume path exists
      const existsResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `test -d ${shellEscape(volumePath)} && echo "exists"`,
        volumePath,
        timeout
      );

      if (!existsResult.success) {
        return {
          success: false,
          error: `Failed to check volume path: ${existsResult.error?.message || 'Unknown error'}`
        };
      }

      if (!existsResult.data.stdout.includes('exists')) {
        return {
          success: false,
          error: `Volume path does not exist: ${volumePath}`
        };
      }

      // 2. Get manifest of files to include
      const manifestResult = await this.getManifest({
        volumePath,
        excludePatterns
      });

      if (!manifestResult.success || !manifestResult.files) {
        return {
          success: false,
          error: manifestResult.error || 'Failed to get file manifest'
        };
      }

      const files = manifestResult.files;
      const fileCount = files.length;
      const totalBytes = manifestResult.totalSize || 0;

      // 3. Create file list for tar (exclude patterns applied in manifest)
      const fileListPath = `/tmp/snapshot-${snapshotId}-files.txt`;
      const fileList = files.map((f: FileEntry) => f.path).join('\n');

      // Write file list using session
      const writeResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `cat > ${shellEscape(fileListPath)} << 'SNAPSHOT_EOF'\n${fileList}\nSNAPSHOT_EOF`,
        volumePath,
        timeout
      );

      if (!writeResult.success) {
        return {
          success: false,
          error: `Failed to write file list: ${writeResult.error?.message || 'Unknown error'}`
        };
      }

      if (writeResult.data.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to write file list: ${writeResult.data.stderr || 'Unknown error'}`
        };
      }

      // 4. Create tar archive with zstd compression and stream to R2
      // Use a temp file approach for MVP (streaming via curl would be more complex)
      const archivePath = `/tmp/snapshot-${snapshotId}.tar.zst`;
      const zstdLevel = getZstdLevel(compressionLevel);

      const tarCommand =
        `tar --create --zstd --options zstd:compression-level=${zstdLevel} ` +
        `--directory=${shellEscape(volumePath)} ` +
        `--files-from=${shellEscape(fileListPath)} ` +
        `-f ${shellEscape(archivePath)} 2>&1`;

      const tarResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        tarCommand,
        volumePath,
        timeout
      );

      if (!tarResult.success) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        return {
          success: false,
          error: `Failed to create tar archive: ${tarResult.error?.message || 'Unknown error'}`
        };
      }

      if (tarResult.data.exitCode !== 0) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        return {
          success: false,
          error: `Failed to create tar archive: ${tarResult.data.stderr || tarResult.data.stdout || 'Unknown error'}`
        };
      }

      // 5. Get archive size and hash
      const statResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `stat -c '%s' ${shellEscape(archivePath)} && sha256sum ${shellEscape(archivePath)} | cut -d' ' -f1`,
        volumePath,
        timeout
      );

      if (!statResult.success) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        return {
          success: false,
          error: `Failed to get archive stats: ${statResult.error?.message || 'Unknown error'}`
        };
      }

      if (statResult.data.exitCode !== 0) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        return {
          success: false,
          error: `Failed to get archive stats: ${statResult.data.stderr || 'Unknown error'}`
        };
      }

      const [sizeStr, contentHash] = statResult.data.stdout.trim().split('\n');
      const compressedBytes = parseInt(sizeStr, 10);

      // 6. Upload to R2 via curl
      const uploadCommand =
        `curl -s -X PUT -H "Content-Type: application/zstd" ` +
        `--data-binary @${shellEscape(archivePath)} ` +
        `${shellEscape(uploadUrl)} -w "%{http_code}"`;

      const uploadResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        uploadCommand,
        volumePath,
        timeout
      );

      // Cleanup temp files
      await this.cleanupTempFiles([fileListPath, archivePath]);

      if (!uploadResult.success) {
        return {
          success: false,
          error: `Failed to upload archive: ${uploadResult.error?.message || 'Unknown error'}`
        };
      }

      if (uploadResult.data.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to upload archive: ${uploadResult.data.stderr || 'Unknown error'}`
        };
      }

      // Check HTTP status code (last characters of stdout)
      const httpStatus = uploadResult.data.stdout.trim().slice(-3);
      if (!httpStatus.startsWith('2')) {
        return {
          success: false,
          error: `Upload failed with HTTP status ${httpStatus}`
        };
      }

      const duration = Date.now() - startTime;

      // 7. Build manifest
      const manifest: SnapshotManifest = {
        version: 1,
        snapshotId,
        files,
        deletedPaths: []
      };

      this.logger.info('Snapshot created successfully', {
        snapshotId,
        fileCount,
        totalBytes,
        compressedBytes,
        duration
      });

      return {
        success: true,
        manifest,
        contentHash,
        stats: {
          totalFiles: fileCount,
          totalBytes,
          compressedBytes,
          duration,
          skippedFiles: 0,
          unchangedFiles: 0
        }
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'Snapshot creation failed',
        error instanceof Error ? error : undefined,
        { snapshotId, volumePath }
      );
      return {
        success: false,
        error: `Snapshot creation failed: ${errorMsg}`
      };
    }
  }

  /**
   * Restore a snapshot from R2 to a volume path
   *
   * Pipeline: GET from url -> zstd -d -> tar --extract
   */
  async restoreSnapshot(
    request: RestoreSnapshotRequest
  ): Promise<RestoreSnapshotResponse> {
    const startTime = Date.now();
    const { volumePath, downloads, mode, timeout } = request;

    this.logger.info('Restoring snapshot', {
      volumePath,
      mode,
      snapshotCount: downloads.length
    });

    try {
      // 1. Prepare volume path
      if (mode === 'clean') {
        // Remove all existing files (but keep the directory)
        await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          `rm -rf ${shellEscape(volumePath)}/* ${shellEscape(volumePath)}/.[!.]* 2>/dev/null; mkdir -p ${shellEscape(volumePath)}`,
          '/tmp',
          timeout
        );
        // mkdir -p should always succeed if we have permissions
        // rm may fail if directory is empty, which is fine
      } else {
        // Ensure directory exists for merge mode
        const mkdirResult = await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          `mkdir -p ${shellEscape(volumePath)}`,
          '/tmp',
          timeout
        );

        if (!mkdirResult.success) {
          return {
            success: false,
            error: `Failed to create volume path: ${mkdirResult.error?.message || 'Unknown error'}`
          };
        }

        if (mkdirResult.data.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to create volume path: ${mkdirResult.data.stderr || 'Unknown error'}`
          };
        }
      }

      let totalFilesRestored = 0;
      const totalBytesDownloaded = 0;
      const totalBytesExtracted = 0;

      // 2. Download and extract each snapshot in order
      for (const download of downloads) {
        const { snapshotId, url, manifest } = download;

        this.logger.debug('Downloading snapshot', { snapshotId });

        // Download and extract in a single pipeline
        // curl -> tar --extract --zstd
        const extractCommand = `curl -s ${shellEscape(url)} | tar --extract --zstd --directory=${shellEscape(volumePath)} 2>&1`;

        const extractResult = await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          extractCommand,
          volumePath,
          timeout
        );

        if (!extractResult.success) {
          return {
            success: false,
            error: `Failed to extract snapshot ${snapshotId}: ${extractResult.error?.message || 'Unknown error'}`
          };
        }

        if (extractResult.data.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to extract snapshot ${snapshotId}: ${extractResult.data.stderr || extractResult.data.stdout || 'Unknown error'}`
          };
        }

        // Apply deletions for incremental snapshots
        if (manifest.deletedPaths && manifest.deletedPaths.length > 0) {
          for (const deletedPath of manifest.deletedPaths) {
            const fullPath = `${volumePath}/${deletedPath}`;
            await this.sessionManager.executeInSession(
              SNAPSHOT_SESSION_ID,
              `rm -rf ${shellEscape(fullPath)} 2>/dev/null || true`,
              volumePath,
              timeout
            );
          }
        }

        totalFilesRestored += manifest.files?.length || 0;
      }

      const duration = Date.now() - startTime;

      this.logger.info('Snapshot restored successfully', {
        volumePath,
        totalFilesRestored,
        duration
      });

      return {
        success: true,
        stats: {
          filesRestored: totalFilesRestored,
          bytesDownloaded: totalBytesDownloaded,
          bytesExtracted: totalBytesExtracted,
          duration,
          snapshotsApplied: downloads.length
        }
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'Snapshot restore failed',
        error instanceof Error ? error : undefined,
        { volumePath }
      );
      return {
        success: false,
        error: `Snapshot restore failed: ${errorMsg}`
      };
    }
  }

  /**
   * Get manifest of files in a volume path
   */
  async getManifest(request: GetManifestRequest): Promise<GetManifestResponse> {
    const { volumePath, excludePatterns } = request;

    this.logger.debug('Getting manifest', { volumePath, excludePatterns });

    try {
      // Build find command with exclude patterns
      let findCommand = `find ${shellEscape(volumePath)} -type f -o -type d -o -type l`;

      // Add exclude patterns
      if (excludePatterns && excludePatterns.length > 0) {
        const excludeArgs = excludePatterns
          .map((p: string) => `-not -path ${shellEscape(`${volumePath}/${p}`)}`)
          .join(' ');
        findCommand = `find ${shellEscape(volumePath)} \\( ${excludeArgs} \\) -prune -o \\( -type f -o -type d -o -type l \\) -print`;
      }

      // Get file list with stats in a single command
      // Format: path|type|mode|size|mtime
      const statFormat = `%p|%y|%a|%s|%Y`;
      const listCommand =
        `${findCommand} 2>/dev/null | while read f; do ` +
        `stat -c '${statFormat}' "$f" 2>/dev/null || true; done`;

      const listResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        listCommand,
        volumePath
      );

      if (!listResult.success) {
        return {
          success: false,
          error: `Failed to list files: ${listResult.error?.message || 'Unknown error'}`
        };
      }

      // Parse output into FileEntry objects
      const files: FileEntry[] = [];
      let totalSize = 0;

      const lines = listResult.data.stdout.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const [fullPath, typeChar, modeStr, sizeStr, mtimeStr] =
          line.split('|');

        if (!fullPath || fullPath === volumePath) continue;

        // Get relative path
        const path = fullPath.startsWith(volumePath + '/')
          ? fullPath.slice(volumePath.length + 1)
          : fullPath.slice(volumePath.length);

        if (!path) continue;

        // Parse type
        let type: 'file' | 'directory' | 'symlink';
        switch (typeChar) {
          case 'f':
            type = 'file';
            break;
          case 'd':
            type = 'directory';
            break;
          case 'l':
            type = 'symlink';
            break;
          default:
            continue; // Skip other types
        }

        const mode = parseInt(modeStr, 8) || 0o644;
        const size = parseInt(sizeStr, 10) || 0;
        const mtime = parseInt(mtimeStr, 10) || 0;

        // For symlinks, get target
        let symlinkTarget: string | undefined;
        if (type === 'symlink') {
          const linkResult = await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            `readlink ${shellEscape(fullPath)}`,
            volumePath
          );
          if (linkResult.success && linkResult.data.exitCode === 0) {
            symlinkTarget = linkResult.data.stdout.trim();
          }
        }

        // Compute hash for files (skip for directories and symlinks)
        let hash = '';
        if (type === 'file' && size > 0) {
          const hashResult = await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            `sha256sum ${shellEscape(fullPath)} | cut -d' ' -f1`,
            volumePath
          );
          if (hashResult.success && hashResult.data.exitCode === 0) {
            hash = hashResult.data.stdout.trim();
          }
        }

        files.push({
          path,
          mode,
          size,
          mtime,
          hash,
          type,
          symlinkTarget
        });

        if (type === 'file') {
          totalSize += size;
        }
      }

      return {
        success: true,
        files,
        totalSize,
        fileCount: files.length
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'Get manifest failed',
        error instanceof Error ? error : undefined,
        { volumePath }
      );
      return {
        success: false,
        error: `Get manifest failed: ${errorMsg}`
      };
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanupTempFiles(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          `rm -f ${shellEscape(path)}`,
          '/tmp'
        );
      } catch (error) {
        this.logger.warn(`Failed to cleanup temp file: ${path}`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
