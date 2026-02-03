/**
 * SnapshotService - Manages volume snapshots using tar/zstd
 *
 * Creates and restores filesystem snapshots via streaming tar archives
 * compressed with zstd. No FUSE required - direct shell operations.
 */

import type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  Logger,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  SnapshotProgressEvent
} from '@repo/shared';
import { shellEscape } from '@repo/shared';

// Re-export types for handler imports
export type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
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
 * Sanitizes a URL by removing query parameters to prevent credential leakage.
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
 */
function sanitizeErrorOutput(errorOutput: string): string {
  return errorOutput.replace(/https?:\/\/[^\s"']+\?[^\s"']*/gi, (url) =>
    sanitizeUrlForLogging(url)
  );
}

/**
 * Validates that a URL is a trusted storage endpoint (R2 or S3).
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
  const validPatterns = [
    /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/,
    /^s3\.[a-z0-9-]+\.amazonaws\.com$/,
    /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/
  ];

  const isValidHost = validPatterns.some((pattern) => pattern.test(hostname));
  if (!isValidHost) {
    throw new Error(`${operation} URL must be an R2 or S3 endpoint`);
  }
}

function validateUploadUrl(url: string): void {
  validateStorageUrl(url, 'upload');
}

function validateDownloadUrl(url: string): void {
  validateStorageUrl(url, 'download');
}

function validateExcludePatterns(patterns: string[]): void {
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
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `Invalid exclude pattern: exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`
      );
    }
    for (const dangerous of DANGEROUS_CHARS) {
      if (pattern.includes(dangerous)) {
        throw new Error(
          'Invalid exclude pattern: contains forbidden characters'
        );
      }
    }
    if (pattern.startsWith('/')) {
      throw new Error('Invalid exclude pattern: absolute paths not allowed');
    }
  }
}

export class SnapshotService {
  constructor(
    private security: SecurityService,
    private logger: Logger
  ) {}

  /**
   * Execute a shell command directly without session management.
   */
  private async execDirect(
    command: string,
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['bash', '-c', command], {
      cwd: options?.cwd,
      stdout: 'pipe',
      stderr: 'pipe'
    });

    let timeoutId: Timer | undefined;
    if (options?.timeoutMs) {
      timeoutId = setTimeout(() => {
        proc.kill();
      }, options.timeoutMs);
    }

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]);

      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async isDirectoryDirect(path: string): Promise<boolean> {
    try {
      const result = await this.execDirect(
        `test -d ${shellEscape(path)} && echo "dir"`,
        { timeoutMs: 5000 }
      );
      return result.stdout.trim() === 'dir';
    } catch {
      return false;
    }
  }

  private buildZstdArgs(level: number): string {
    const args: string[] = [];
    if (level <= 6) {
      args.push('--fast=1');
    } else {
      args.push(`-${level}`);
    }
    args.push('--exclude-compressed');
    args.push('-T4');
    return args.join(' ');
  }

  private buildExcludeArgs(excludePatterns: string[]): string {
    if (!excludePatterns.length) {
      return '';
    }
    validateExcludePatterns(excludePatterns);
    return excludePatterns
      .map((pattern) => `--exclude=${shellEscape(pattern)}`)
      .join(' ');
  }

  private buildCreateCommand(
    volumePath: string,
    compressionLevel: number,
    excludePatterns: string[],
    uploadUrl: string
  ): string {
    const zstdArgs = this.buildZstdArgs(getZstdLevel(compressionLevel));
    const excludeArgs = this.buildExcludeArgs(excludePatterns);
    const tarCommand =
      `tar ${excludeArgs} -I ${shellEscape(`zstd ${zstdArgs}`)} -cf - ` +
      `-C ${shellEscape(volumePath)} .`;
    const uploadCommand =
      `curl -sS -o /dev/null -X PUT -H "Content-Type: application/zstd" ` +
      `--connect-timeout 30 --max-time 300 --data-binary @- ` +
      `${shellEscape(uploadUrl)} -w "http=%{http_code} size=%{size_upload}"`;
    return `set -o pipefail; ${tarCommand} | ${uploadCommand}`;
  }

  private parseUploadResult(stdout: string): {
    status: string | null;
    bytes: number | null;
  } {
    const match = stdout.trim().match(/http=(\d{3})\s+size=(\d+)/);
    if (!match) {
      return { status: null, bytes: null };
    }
    return { status: match[1], bytes: Number.parseInt(match[2], 10) };
  }

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

    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: `Invalid volume path: ${pathValidation.errors.join(', ')}`
      };
    }

    try {
      const volumeExists = await this.isDirectoryDirect(volumePath);
      if (!volumeExists) {
        return {
          success: false,
          error: `Volume path does not exist: ${volumePath}`
        };
      }

      validateUploadUrl(uploadUrl);
      const exclude = excludePatterns || [];
      const command = this.buildCreateCommand(
        volumePath,
        compressionLevel,
        exclude,
        uploadUrl
      );

      const result = await this.execDirect(command, {
        cwd: volumePath,
        timeoutMs: timeout
      });

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to upload snapshot: ${sanitizeErrorOutput(result.stderr || result.stdout || 'Unknown error')}`
        };
      }

      const parsed = this.parseUploadResult(result.stdout);
      if (!parsed.status || !parsed.status.startsWith('2')) {
        return {
          success: false,
          error: `Upload failed with HTTP status ${parsed.status || 'unknown'}`
        };
      }

      const duration = Date.now() - startTime;
      const compressedBytes = parsed.bytes ?? 0;

      this.logger.info('Snapshot created successfully', {
        snapshotId,
        compressedBytes,
        duration
      });

      return {
        success: true,
        stats: {
          compressedBytes,
          duration
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

    const fail = (
      message: string
    ): { event: SnapshotProgressEvent; response: CreateSnapshotResponse } => ({
      event: {
        type: 'error',
        phase: 'error',
        message,
        error: message
      },
      response: { success: false, error: message }
    });

    yield {
      type: 'phase',
      phase: 'validating',
      message: 'Validating snapshot inputs'
    };

    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      const { event, response } = fail(
        `Invalid volume path: ${pathValidation.errors.join(', ')}`
      );
      yield event;
      return response;
    }

    const volumeExists = await this.isDirectoryDirect(volumePath);
    if (!volumeExists) {
      const { event, response } = fail(
        `Volume path does not exist: ${volumePath}`
      );
      yield event;
      return response;
    }

    try {
      validateUploadUrl(uploadUrl);
      const exclude = excludePatterns || [];
      const command = this.buildCreateCommand(
        volumePath,
        compressionLevel,
        exclude,
        uploadUrl
      );

      yield {
        type: 'phase',
        phase: 'compressing',
        message: 'Streaming archive to R2'
      };

      const execPromise = this.execDirect(command, {
        cwd: volumePath,
        timeoutMs: timeout
      });

      const heartbeatMs = 5000;
      while (true) {
        const result = await Promise.race([
          execPromise.then((response) => ({ done: true as const, response })),
          new Promise<{ done: false }>((resolve) =>
            setTimeout(() => resolve({ done: false }), heartbeatMs)
          )
        ]);

        if (!result.done) {
          yield {
            type: 'phase',
            phase: 'uploading',
            message: 'Upload in progress'
          };
          continue;
        }

        const response = result.response;
        if (response.exitCode !== 0) {
          const { event, response: finalResponse } = fail(
            `Failed to upload snapshot: ${sanitizeErrorOutput(response.stderr || response.stdout || 'Unknown error')}`
          );
          yield event;
          return finalResponse;
        }

        const parsed = this.parseUploadResult(response.stdout);
        if (!parsed.status || !parsed.status.startsWith('2')) {
          const { event, response: finalResponse } = fail(
            `Upload failed with HTTP status ${parsed.status || 'unknown'}`
          );
          yield event;
          return finalResponse;
        }

        const duration = Date.now() - startTime;
        const compressedBytes = parsed.bytes ?? 0;
        const stats = { compressedBytes, duration };

        yield {
          type: 'complete',
          phase: 'complete',
          message: 'Snapshot upload complete',
          stats
        };

        return {
          success: true,
          stats
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const { event, response } = fail(`Snapshot creation failed: ${errorMsg}`);
      yield event;
      return response;
    }
  }

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

    const pathValidation = this.security.validatePath(volumePath);
    if (!pathValidation.isValid) {
      return {
        success: false,
        error: `Invalid volume path: ${pathValidation.errors.join(', ')}`
      };
    }

    try {
      if (mode === 'clean') {
        await this.execDirect(
          `rm -rf ${shellEscape(volumePath)}/* ${shellEscape(volumePath)}/.[!.]* 2>/dev/null; mkdir -p ${shellEscape(volumePath)}`,
          { cwd: '/tmp', timeoutMs: timeout }
        );
      } else {
        const mkdirResult = await this.execDirect(
          `mkdir -p ${shellEscape(volumePath)}`,
          { cwd: '/tmp', timeoutMs: timeout }
        );
        if (mkdirResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to create volume path: ${mkdirResult.stderr || 'Unknown error'}`
          };
        }
      }

      for (const download of downloads) {
        const { snapshotId, url } = download;
        try {
          validateDownloadUrl(url);
        } catch (error) {
          return {
            success: false,
            error: `Invalid download URL for snapshot ${snapshotId}: ${error instanceof Error ? error.message : 'Unknown error'}`
          };
        }

        const extractCommand =
          `curl -sS -f --connect-timeout 30 --max-time 300 ${shellEscape(url)} ` +
          `| zstd -d -T0 ` +
          `| tar --extract --directory=${shellEscape(volumePath)} 2>&1`;
        const command = `set -o pipefail; ${extractCommand}`;

        const extractResult = await this.execDirect(command, {
          cwd: volumePath,
          timeoutMs: timeout
        });

        if (extractResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to extract snapshot ${snapshotId}: ${extractResult.stderr || extractResult.stdout || 'Unknown error'}`
          };
        }
      }

      const duration = Date.now() - startTime;

      this.logger.info('Snapshot restored successfully', {
        volumePath,
        duration
      });

      return {
        success: true,
        stats: {
          filesRestored: 0,
          bytesDownloaded: 0,
          bytesExtracted: 0,
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
}
