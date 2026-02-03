/**
 * SnapshotService - Manages volume snapshots using tar/zstd
 *
 * Creates and restores filesystem snapshots via streaming tar archives
 * compressed with zstd. No FUSE required - direct shell operations.
 */

import type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  FileEntry,
  GetManifestRequest,
  GetManifestResponse,
  Logger,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  SnapshotManifest,
  SnapshotPhase,
  SnapshotProgressEvent
} from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type { SessionManager } from './session-manager';

// Re-export types for handler imports
export type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  GetManifestRequest,
  GetManifestResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse
};

/**
 * Security service interface for path validation
 */
export interface SecurityService {
  validatePath(path: string): { isValid: boolean; errors: string[] };
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

/**
 * Sanitizes a URL by removing query parameters to prevent credential leakage.
 * Presigned URLs contain sensitive credentials in query params that should
 * not appear in logs or error messages.
 */
function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Sanitizes error output by removing URLs with query parameters.
 * This prevents credential leakage from curl/wget error messages that
 * include the full URL with presigned credentials.
 */
function sanitizeErrorOutput(errorOutput: string): string {
  // Match URLs with query parameters and replace with sanitized version
  return errorOutput.replace(/https?:\/\/[^\s"']+\?[^\s"']*/gi, (url) =>
    sanitizeUrlForLogging(url)
  );
}

/**
 * Validates that a URL is a trusted storage endpoint (R2 or S3).
 * Uses regex patterns to prevent hostname spoofing attacks like "evil.com.r2.cloudflarestorage.com".
 */
function validateStorageUrl(
  url: string,
  operation: 'upload' | 'download'
): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${operation} URL must use HTTPS`);
  }

  const hostname = parsed.hostname.toLowerCase();
  // Match valid R2/S3 endpoints using regex to prevent hostname spoofing
  const validPatterns = [
    /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/, // R2
    /^s3\.[a-z0-9-]+\.amazonaws\.com$/, // S3 path-style
    /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/ // S3 virtual-hosted
  ];

  const isValidHost = validPatterns.some((pattern) => pattern.test(hostname));
  if (!isValidHost) {
    throw new Error(`${operation} URL must be an R2 or S3 endpoint`);
  }
}

/**
 * Validates that an upload URL is a trusted storage endpoint (R2 or S3).
 * Prevents SSRF attacks by restricting upload destinations.
 */
function validateUploadUrl(url: string): void {
  validateStorageUrl(url, 'upload');
}

/**
 * Validates that a download URL is a trusted storage endpoint (R2 or S3).
 * Prevents SSRF attacks by restricting download sources to trusted origins only.
 */
function validateDownloadUrl(url: string): void {
  validateStorageUrl(url, 'download');
}

export class SnapshotService {
  constructor(
    private sessionManager: SessionManager,
    private security: SecurityService,
    private logger: Logger
  ) {}

  /**
   * Build optimized zstd arguments based on compression level
   *
   * For fast compression (level <= 6):
   *   --fast=1: Speed-optimized mode
   *   --exclude-compressed: Skip re-compressing already compressed files
   *   -T4: Use 4 threads for parallel compression
   *
   * For higher compression (level > 6):
   *   -<level>: Use specified compression level
   *   --exclude-compressed: Skip re-compressing already compressed files
   *   -T4: Use 4 threads
   */
  private buildZstdArgs(level: number): string {
    const args: string[] = [];

    if (level <= 6) {
      // Speed-optimized mode for fast compression
      args.push('--fast=1');
    } else {
      // Use explicit compression level for higher compression
      args.push(`-${level}`);
    }

    // Always skip re-compressing already compressed files (e.g., .gz, .zip, .jpg)
    args.push('--exclude-compressed');

    // Use 4 threads for parallel compression
    args.push('-T4');

    return args.join(' ');
  }

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

    // Validate volume path for security
    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: `Invalid volume path: ${pathValidation.errors.join(', ')}`
      };
    }

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
        excludePatterns,
        skipFileHashes: true
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

      // Check snapshot size limit if configured
      const maxSize = request.maxSnapshotSizeBytes;
      if (maxSize && totalBytes > maxSize) {
        return {
          success: false,
          error: `Snapshot size (${totalBytes} bytes) exceeds limit (${maxSize} bytes)`
        };
      }

      // 3. Create file list for tar (exclude patterns applied in manifest)
      const fileListPath = `/tmp/snapshot-${crypto.randomUUID()}-files.txt`;
      const fileList = files.map((f: FileEntry) => f.path).join('\n');

      // Write file list using base64 encoding to safely pass content
      const encodedList = Buffer.from(fileList).toString('base64');
      const writeResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `echo ${shellEscape(encodedList)} | base64 -d > ${shellEscape(fileListPath)}`,
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

      // Validate upload URL before using it
      validateUploadUrl(uploadUrl);

      // 4. Create tar archive with zstd compression and stream to R2
      // Use a temp file approach for MVP (streaming via curl would be more complex)
      const archivePath = `/tmp/snapshot-${crypto.randomUUID()}.tar.zst`;
      const zstdLevel = getZstdLevel(compressionLevel);

      // Build optimized zstd command
      // --fast=1: Speed-optimized compression (when compressionLevel <= 6)
      // --exclude-compressed: Skip re-compressing already compressed files
      // -T4: Use 4 threads for parallel compression
      const zstdArgs = this.buildZstdArgs(zstdLevel);
      const tarCommand =
        `tar -I ${shellEscape(`zstd ${zstdArgs}`)} --create ` +
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
          error: `Failed to upload archive: ${sanitizeErrorOutput(uploadResult.data.stderr || 'Unknown error')}`
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

    // Validate volume path for security
    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: `Invalid volume path: ${pathValidation.errors.join(', ')}`
      };
    }

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

      // 2. Download and extract each snapshot in order
      for (const download of downloads) {
        const { snapshotId, url, manifest } = download;

        // Validate download URL to prevent SSRF
        try {
          validateDownloadUrl(url);
        } catch (error) {
          return {
            success: false,
            error: `Invalid download URL for snapshot ${snapshotId}: ${error instanceof Error ? error.message : 'Unknown error'}`
          };
        }

        this.logger.debug('Downloading snapshot', { snapshotId });

        // Download to temp file for hash verification
        const tempFile = `/tmp/snapshot-${crypto.randomUUID()}.tar.zst`;
        const downloadCommand = `curl -sf ${shellEscape(url)} -o ${shellEscape(tempFile)}`;

        const downloadResult = await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          downloadCommand,
          volumePath,
          timeout
        );

        if (!downloadResult.success) {
          // Cleanup temp file on failure
          await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            `rm -f ${shellEscape(tempFile)}`,
            '/tmp'
          );
          return {
            success: false,
            error: `Failed to download snapshot ${snapshotId}: ${downloadResult.error?.message || 'Download failed'}`
          };
        }

        if (downloadResult.data.exitCode !== 0) {
          // Cleanup temp file on failure
          await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            `rm -f ${shellEscape(tempFile)}`,
            '/tmp'
          );
          return {
            success: false,
            error: `Failed to download snapshot ${snapshotId}: ${sanitizeErrorOutput(downloadResult.data.stderr || 'Download failed')}`
          };
        }

        // Verify hash if provided (expectedHash may come from download.expectedHash)
        const expectedHash = (download as { expectedHash?: string })
          .expectedHash;
        if (expectedHash) {
          const hashCommand = `sha256sum ${shellEscape(tempFile)} | cut -d' ' -f1`;
          const hashResult = await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            hashCommand,
            '/tmp'
          );

          if (hashResult.success && hashResult.data.stdout) {
            const actualHash = hashResult.data.stdout.trim();
            if (actualHash !== expectedHash) {
              await this.sessionManager.executeInSession(
                SNAPSHOT_SESSION_ID,
                `rm -f ${shellEscape(tempFile)}`,
                '/tmp'
              );
              return {
                success: false,
                error: `Snapshot ${snapshotId} integrity check failed: hash mismatch`
              };
            }
            this.logger.debug('Snapshot hash verified', {
              snapshotId,
              hash: actualHash
            });
          }
        }

        // Extract from verified temp file
        const extractCommand = `zstd -d -T0 < ${shellEscape(tempFile)} | tar --extract --directory=${shellEscape(volumePath)} 2>&1`;

        const extractResult = await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          extractCommand,
          volumePath,
          timeout
        );

        // Cleanup temp file
        await this.sessionManager.executeInSession(
          SNAPSHOT_SESSION_ID,
          `rm -f ${shellEscape(tempFile)}`,
          '/tmp'
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
          bytesDownloaded: 0, // Not tracked in streaming pipeline
          bytesExtracted: 0, // Not tracked in streaming pipeline
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
    const { volumePath, excludePatterns, skipFileHashes } = request;

    this.logger.debug('Getting manifest', { volumePath, excludePatterns });
    if (skipFileHashes) {
      this.logger.debug('Skipping per-file hash computation');
    }

    // Validate volume path for security
    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: `Invalid volume path: ${pathValidation.errors.join(', ')}`
      };
    }

    try {
      // Validate exclude patterns to prevent command injection
      if (excludePatterns && excludePatterns.length > 0) {
        const DANGEROUS_CHARS = [
          '..',
          '\0',
          '$(',
          '`',
          '\n',
          '\r',
          ';',
          '|',
          '&',
          '>',
          '<',
          '#'
        ];
        const MAX_PATTERN_LENGTH = 256;
        for (const pattern of excludePatterns) {
          if (pattern.length > MAX_PATTERN_LENGTH) {
            return {
              success: false,
              error: `Invalid exclude pattern: exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`
            };
          }
          for (const dangerous of DANGEROUS_CHARS) {
            if (pattern.includes(dangerous)) {
              return {
                success: false,
                error: `Invalid exclude pattern: contains forbidden characters`
              };
            }
          }
          if (pattern.startsWith('/')) {
            return {
              success: false,
              error: `Invalid exclude pattern: absolute paths not allowed`
            };
          }
        }
      }

      // Build find command with exclude patterns
      let findCommand = `find ${shellEscape(volumePath)} -type f -o -type d -o -type l`;

      // Add exclude patterns (now validated)
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
        const path = fullPath.startsWith(`${volumePath}/`)
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

        // For symlinks, get target and validate it stays within volume
        let symlinkTarget: string | undefined;
        if (type === 'symlink') {
          const linkResult = await this.sessionManager.executeInSession(
            SNAPSHOT_SESSION_ID,
            `readlink ${shellEscape(fullPath)}`,
            volumePath
          );
          if (linkResult.success && linkResult.data.exitCode === 0) {
            const target = linkResult.data.stdout.trim();

            // Resolve the absolute path of the symlink target
            let resolvedTarget: string;
            if (target.startsWith('/')) {
              resolvedTarget = target;
            } else {
              // Relative symlink - resolve from symlink's directory
              const linkDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
              resolvedTarget = `${linkDir}/${target}`;
            }

            // Normalize the path (resolve . and ..)
            // Simple normalization - split, filter, rejoin
            const parts = resolvedTarget
              .split('/')
              .filter((p) => p && p !== '.');
            const normalized: string[] = [];
            for (const part of parts) {
              if (part === '..') {
                normalized.pop();
              } else {
                normalized.push(part);
              }
            }
            resolvedTarget = `/${normalized.join('/')}`;

            // Check if target is within volume path
            if (
              !resolvedTarget.startsWith(`${volumePath}/`) &&
              resolvedTarget !== volumePath
            ) {
              this.logger.warn(
                'Symlink points outside volume, excluding from snapshot',
                {
                  symlink: fullPath,
                  target,
                  resolvedTarget,
                  volumePath
                }
              );
              continue; // Skip this symlink
            }

            symlinkTarget = target;
          }
        }

        // Compute hash for files (skip for directories and symlinks)
        let hash = '';
        if (!skipFileHashes && type === 'file' && size > 0) {
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

  /**
   * Create a snapshot with streaming progress events
   *
   * Same logic as createSnapshot() but yields progress events at each phase.
   */
  async *createSnapshotStream(
    request: CreateSnapshotRequest
  ): AsyncGenerator<SnapshotProgressEvent, CreateSnapshotResponse, void> {
    const startTime = Date.now();
    const {
      snapshotId,
      volumePath,
      uploadUrl,
      compressionLevel,
      excludePatterns,
      timeout
    } = request;

    this.logger.info('Creating snapshot (streaming)', {
      snapshotId,
      volumePath,
      compressionLevel
    });

    // Validate volume path for security (before defining helper to fail fast)
    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      const errorMsg = `Invalid volume path: ${pathValidation.errors.join(', ')}`;
      yield {
        type: 'error',
        phase: 'error',
        message: errorMsg,
        error: errorMsg
      } as SnapshotProgressEvent;
      return {
        success: false,
        error: errorMsg
      };
    }

    const createProgressEvent = (
      type: 'phase' | 'complete' | 'error',
      phase: SnapshotPhase,
      message: string,
      stats?: SnapshotProgressEvent['stats'],
      error?: string,
      contentHash?: string
    ): SnapshotProgressEvent => ({
      type,
      phase,
      message,
      stats,
      error,
      contentHash
    });

    try {
      // 1. Validating phase - check volume path exists
      yield createProgressEvent(
        'phase',
        'validating',
        `Validating volume path: ${volumePath}`
      );

      const existsResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `test -d ${shellEscape(volumePath)} && echo "exists"`,
        volumePath,
        timeout
      );

      if (!existsResult.success) {
        const errorMsg = `Failed to check volume path: ${existsResult.error?.message || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      if (!existsResult.data.stdout.includes('exists')) {
        const errorMsg = `Volume path does not exist: ${volumePath}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      // 2. Scanning phase - get manifest of files
      yield createProgressEvent(
        'phase',
        'scanning',
        'Scanning files for snapshot...'
      );

      const manifestResult = await this.getManifest({
        volumePath,
        excludePatterns,
        skipFileHashes: true
      });

      if (!manifestResult.success || !manifestResult.files) {
        const errorMsg = manifestResult.error || 'Failed to get file manifest';
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      const files = manifestResult.files;
      const fileCount = files.length;
      const totalBytes = manifestResult.totalSize || 0;

      yield createProgressEvent(
        'phase',
        'scanning',
        `Found ${fileCount} files (${totalBytes} bytes)`,
        { totalFiles: fileCount, totalBytes }
      );

      // 3. Compressing phase - create tar archive
      yield createProgressEvent(
        'phase',
        'compressing',
        'Creating compressed archive...',
        { totalFiles: fileCount, totalBytes }
      );

      // Create file list for tar
      const fileListPath = `/tmp/snapshot-${crypto.randomUUID()}-files.txt`;
      const fileList = files.map((f: FileEntry) => f.path).join('\n');

      // Write file list using base64 encoding to safely pass content
      const encodedList = Buffer.from(fileList).toString('base64');
      const writeResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `echo ${shellEscape(encodedList)} | base64 -d > ${shellEscape(fileListPath)}`,
        volumePath,
        timeout
      );

      if (!writeResult.success) {
        const errorMsg = `Failed to write file list: ${writeResult.error?.message || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      if (writeResult.data.exitCode !== 0) {
        const errorMsg = `Failed to write file list: ${writeResult.data.stderr || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      // Validate upload URL before using it
      validateUploadUrl(uploadUrl);

      // Create tar archive with optimized zstd compression
      const archivePath = `/tmp/snapshot-${crypto.randomUUID()}.tar.zst`;
      const zstdLevel = getZstdLevel(compressionLevel);

      // Build optimized zstd command (same as in createSnapshot)
      const zstdArgs = this.buildZstdArgs(zstdLevel);
      const tarCommand =
        `tar -I ${shellEscape(`zstd ${zstdArgs}`)} --create ` +
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
        const errorMsg = `Failed to create tar archive: ${tarResult.error?.message || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      if (tarResult.data.exitCode !== 0) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        const errorMsg = `Failed to create tar archive: ${tarResult.data.stderr || tarResult.data.stdout || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      // Get archive size and hash
      const statResult = await this.sessionManager.executeInSession(
        SNAPSHOT_SESSION_ID,
        `stat -c '%s' ${shellEscape(archivePath)} && sha256sum ${shellEscape(archivePath)} | cut -d' ' -f1`,
        volumePath,
        timeout
      );

      if (!statResult.success) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        const errorMsg = `Failed to get archive stats: ${statResult.error?.message || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      if (statResult.data.exitCode !== 0) {
        await this.cleanupTempFiles([fileListPath, archivePath]);
        const errorMsg = `Failed to get archive stats: ${statResult.data.stderr || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      const [sizeStr, contentHash] = statResult.data.stdout.trim().split('\n');
      const compressedBytes = parseInt(sizeStr, 10);

      yield createProgressEvent(
        'phase',
        'compressing',
        `Compression complete: ${compressedBytes} bytes`,
        { totalFiles: fileCount, totalBytes, compressedBytes }
      );

      // 4. Uploading phase - upload to R2
      yield createProgressEvent(
        'phase',
        'uploading',
        'Uploading to storage...',
        { totalFiles: fileCount, totalBytes, compressedBytes }
      );

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
        const errorMsg = `Failed to upload archive: ${uploadResult.error?.message || 'Unknown error'}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      if (uploadResult.data.exitCode !== 0) {
        const errorMsg = `Failed to upload archive: ${sanitizeErrorOutput(uploadResult.data.stderr || 'Unknown error')}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      // Check HTTP status code
      const httpStatus = uploadResult.data.stdout.trim().slice(-3);
      if (!httpStatus.startsWith('2')) {
        const errorMsg = `Upload failed with HTTP status ${httpStatus}`;
        yield createProgressEvent(
          'error',
          'error',
          errorMsg,
          undefined,
          errorMsg
        );
        return {
          success: false,
          error: errorMsg
        };
      }

      const duration = Date.now() - startTime;

      // 5. Complete phase - build manifest and return
      const manifest: SnapshotManifest = {
        version: 1,
        snapshotId,
        files,
        deletedPaths: []
      };

      this.logger.info('Snapshot created successfully (streaming)', {
        snapshotId,
        fileCount,
        totalBytes,
        compressedBytes,
        duration
      });

      yield createProgressEvent(
        'complete',
        'complete',
        'Snapshot created successfully',
        { totalFiles: fileCount, totalBytes, compressedBytes, duration },
        undefined,
        contentHash
      );

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
        'Snapshot creation failed (streaming)',
        error instanceof Error ? error : undefined,
        { snapshotId, volumePath }
      );

      yield createProgressEvent(
        'error',
        'error',
        `Snapshot creation failed: ${errorMsg}`,
        { duration: Date.now() - startTime },
        errorMsg
      );

      return {
        success: false,
        error: `Snapshot creation failed: ${errorMsg}`
      };
    }
  }
}
