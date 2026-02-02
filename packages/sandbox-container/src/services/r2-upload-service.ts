/**
 * R2UploadService - Smart R2 upload with multipart support
 *
 * Implements efficient uploads to R2:
 * - Single PUT for files <= 30MB
 * - Multipart upload with 20MB chunks for larger files
 * - Concurrent chunk uploads with controlled parallelism
 * - Automatic abort on failure
 */

import type { Logger } from '@repo/shared';
import { shellEscape } from '@repo/shared';
import type { SessionManager } from './session-manager';

/**
 * Configuration constants for R2 uploads
 */
const PART_SIZE = 20 * 1024 * 1024; // 20MB chunks
const MULTIPART_THRESHOLD = 30 * 1024 * 1024; // Use multipart for files > 30MB
const MAX_CONCURRENT_UPLOADS = 20;

/**
 * Session ID used for R2 upload operations
 */
const R2_UPLOAD_SESSION_ID = '__r2_upload__';

/**
 * Result of a part upload containing ETag and part number
 */
interface UploadedPart {
  etag: string;
  partNumber: number;
}

/**
 * URLs needed for multipart upload coordination
 */
export interface MultipartUploadUrls {
  /** URLs for each part upload */
  partUrls: string[];
  /** URL to complete the multipart upload */
  completeUrl: string;
  /** URL to abort the multipart upload */
  abortUrl: string;
}

/**
 * Options for uploading a file to R2
 */
export interface R2UploadOptions {
  /** Path to the local file to upload */
  filePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Content type for the upload */
  contentType?: string;
  /** Operation timeout in milliseconds */
  timeout?: number;
}

/**
 * Options for single-part upload
 */
export interface SinglePartUploadOptions extends R2UploadOptions {
  /** Presigned URL for the upload */
  uploadUrl: string;
}

/**
 * Options for multipart upload
 */
export interface MultipartUploadOptions extends R2UploadOptions {
  /** Function to get multipart upload URLs for the given number of parts */
  getMultipartUrls: (uploadParts: number) => Promise<MultipartUploadUrls>;
}

/**
 * Result from R2 upload operation
 */
export interface R2UploadResult {
  success: boolean;
  bytesUploaded?: number;
  error?: string;
}

export class R2UploadService {
  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  /**
   * Upload a file to R2 using single PUT or multipart based on size
   *
   * @param options Upload options with either presigned URL or multipart URL getter
   * @param singlePartUrl Presigned URL for single-part upload
   * @param getMultipartUrls Function to get multipart URLs (called only if needed)
   */
  async uploadFile(
    options: R2UploadOptions,
    singlePartUrl: string,
    getMultipartUrls?: (uploadParts: number) => Promise<MultipartUploadUrls>
  ): Promise<R2UploadResult> {
    const {
      filePath,
      fileSize,
      contentType = 'application/octet-stream'
    } = options;

    this.logger.info('Starting R2 upload', {
      filePath,
      fileSize,
      threshold: MULTIPART_THRESHOLD
    });

    // Use single PUT for small files
    if (fileSize <= MULTIPART_THRESHOLD) {
      return this.uploadSinglePart({
        ...options,
        uploadUrl: singlePartUrl,
        contentType
      });
    }

    // Use multipart for large files
    if (!getMultipartUrls) {
      // Fall back to single part if multipart not available
      this.logger.warn(
        'Large file but multipart URLs not provided, using single PUT',
        { fileSize }
      );
      return this.uploadSinglePart({
        ...options,
        uploadUrl: singlePartUrl,
        contentType
      });
    }

    return this.uploadMultipart({
      ...options,
      getMultipartUrls,
      contentType
    });
  }

  /**
   * Upload a file using a single PUT request
   */
  async uploadSinglePart(
    options: SinglePartUploadOptions
  ): Promise<R2UploadResult> {
    const {
      filePath,
      fileSize,
      uploadUrl,
      contentType = 'application/octet-stream',
      timeout
    } = options;

    this.logger.debug('Uploading file (single-part)', { filePath, fileSize });

    try {
      const uploadCommand =
        `curl -s -X PUT ` +
        `-H "Content-Type: ${shellEscape(contentType)}" ` +
        `--data-binary @${shellEscape(filePath)} ` +
        `${shellEscape(uploadUrl)} -w "%{http_code}"`;

      const result = await this.sessionManager.executeInSession(
        R2_UPLOAD_SESSION_ID,
        uploadCommand,
        '/tmp',
        timeout
      );

      if (!result.success) {
        return {
          success: false,
          error: `Upload failed: ${result.error?.message || 'Unknown error'}`
        };
      }

      if (result.data.exitCode !== 0) {
        return {
          success: false,
          error: `Upload failed: ${result.data.stderr || 'Unknown error'}`
        };
      }

      // Check HTTP status code (last 3 characters of stdout)
      const httpStatus = result.data.stdout.trim().slice(-3);
      if (!httpStatus.startsWith('2')) {
        return {
          success: false,
          error: `Upload failed with HTTP status ${httpStatus}`
        };
      }

      this.logger.info('Single-part upload completed', {
        filePath,
        bytesUploaded: fileSize
      });

      return {
        success: true,
        bytesUploaded: fileSize
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'Single-part upload failed',
        error instanceof Error ? error : undefined,
        { filePath }
      );
      return {
        success: false,
        error: `Upload failed: ${errorMsg}`
      };
    }
  }

  /**
   * Upload a file using multipart upload
   */
  async uploadMultipart(
    options: MultipartUploadOptions
  ): Promise<R2UploadResult> {
    const {
      filePath,
      fileSize,
      getMultipartUrls,
      contentType = 'application/octet-stream',
      timeout
    } = options;

    // Calculate number of parts
    const uploadParts = Math.ceil(fileSize / PART_SIZE);

    if (uploadParts > 10_000) {
      return {
        success: false,
        error: `File too large: ${uploadParts} parts exceeds R2 limit of 10,000`
      };
    }

    this.logger.info('Starting multipart upload', {
      filePath,
      fileSize,
      uploadParts,
      partSize: PART_SIZE
    });

    let multipartUrls: MultipartUploadUrls;
    try {
      multipartUrls = await getMultipartUrls(uploadParts);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to get multipart URLs: ${errorMsg}`
      };
    }

    const { partUrls, completeUrl, abortUrl } = multipartUrls;

    if (partUrls.length !== uploadParts) {
      return {
        success: false,
        error: `Expected ${uploadParts} part URLs, got ${partUrls.length}`
      };
    }

    try {
      // Upload parts with controlled concurrency
      const uploadedParts = await this.uploadPartsWithConcurrency(
        filePath,
        fileSize,
        partUrls,
        contentType,
        timeout
      );

      // Complete multipart upload
      await this.completeMultipartUpload(completeUrl, uploadedParts, timeout);

      this.logger.info('Multipart upload completed', {
        filePath,
        bytesUploaded: fileSize,
        parts: uploadParts
      });

      return {
        success: true,
        bytesUploaded: fileSize
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        'Multipart upload failed, aborting',
        error instanceof Error ? error : undefined,
        { filePath }
      );

      // Abort multipart upload on failure
      await this.abortMultipartUpload(abortUrl, timeout);

      return {
        success: false,
        error: `Multipart upload failed: ${errorMsg}`
      };
    }
  }

  /**
   * Upload parts with controlled concurrency using a semaphore pattern
   */
  private async uploadPartsWithConcurrency(
    filePath: string,
    fileSize: number,
    partUrls: string[],
    contentType: string,
    timeout?: number
  ): Promise<UploadedPart[]> {
    const results: UploadedPart[] = [];
    const errors: Error[] = [];
    let bytesUploaded = 0;

    // Create upload tasks
    const tasks = partUrls.map((url, index) => ({
      url,
      partNumber: index + 1,
      start: index * PART_SIZE,
      end: Math.min((index + 1) * PART_SIZE, fileSize)
    }));

    // Process with concurrency limit
    const inFlight = new Set<Promise<void>>();

    for (const task of tasks) {
      // If at max concurrency, wait for one to complete
      if (inFlight.size >= MAX_CONCURRENT_UPLOADS) {
        await Promise.race(inFlight);
      }

      const uploadPromise = (async () => {
        try {
          const partSize = task.end - task.start;
          const etag = await this.uploadPart(
            filePath,
            task.start,
            partSize,
            task.url,
            contentType,
            timeout
          );

          results.push({
            etag,
            partNumber: task.partNumber
          });

          bytesUploaded += partSize;
          this.logger.debug('Part uploaded', {
            partNumber: task.partNumber,
            bytesUploaded,
            totalBytes: fileSize
          });
        } catch (error) {
          errors.push(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      })();

      inFlight.add(uploadPromise);
      uploadPromise.finally(() => inFlight.delete(uploadPromise));
    }

    // Wait for all remaining uploads
    await Promise.all(inFlight);

    // Check for errors
    if (errors.length > 0) {
      throw new Error(
        `${errors.length} part upload(s) failed: ${errors[0].message}`
      );
    }

    // Sort by part number for completion
    results.sort((a, b) => a.partNumber - b.partNumber);

    return results;
  }

  /**
   * Upload a single part using dd to extract the chunk and pipe to curl
   */
  private async uploadPart(
    filePath: string,
    start: number,
    size: number,
    uploadUrl: string,
    contentType: string,
    timeout?: number
  ): Promise<string> {
    // Use dd to extract the chunk and pipe to curl
    // dd bs=1 skip=<start> count=<size> if=<file> | curl ...
    // Use larger block size for efficiency
    const blockSize = 1024 * 1024; // 1MB blocks
    const skipBlocks = Math.floor(start / blockSize);
    const skipBytes = start % blockSize;

    let ddCommand: string;
    if (skipBytes === 0) {
      // Aligned read - use simple dd
      ddCommand =
        `dd if=${shellEscape(filePath)} bs=${blockSize} ` +
        `skip=${skipBlocks} count=${Math.ceil(size / blockSize)} 2>/dev/null`;
    } else {
      // Unaligned read - need byte-level precision
      ddCommand = `dd if=${shellEscape(filePath)} bs=1 skip=${start} count=${size} 2>/dev/null`;
    }

    const uploadCommand =
      `${ddCommand} | curl -s -X PUT ` +
      `-H "Content-Type: ${shellEscape(contentType)}" ` +
      `-H "Content-Length: ${size}" ` +
      `--data-binary @- ` +
      `${shellEscape(uploadUrl)} -i 2>&1`;

    const result = await this.sessionManager.executeInSession(
      R2_UPLOAD_SESSION_ID,
      uploadCommand,
      '/tmp',
      timeout
    );

    if (!result.success) {
      throw new Error(`Part upload failed: ${result.error?.message}`);
    }

    if (result.data.exitCode !== 0) {
      throw new Error(`Part upload failed: ${result.data.stderr}`);
    }

    // Extract ETag from response headers
    const etagMatch = result.data.stdout.match(/[Ee][Tt]ag:\s*"?([^"\r\n]+)"?/);
    if (!etagMatch) {
      throw new Error('No ETag in part upload response');
    }

    return etagMatch[1];
  }

  /**
   * Complete multipart upload by sending the part list
   */
  private async completeMultipartUpload(
    completeUrl: string,
    uploadedParts: UploadedPart[],
    timeout?: number
  ): Promise<void> {
    // Build XML body for completion
    const partsXml = uploadedParts
      .map(
        (part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`
      )
      .join('');

    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`;

    const completeCommand =
      `curl -s -X POST ` +
      `-H "Content-Type: application/xml" ` +
      `-d ${shellEscape(xmlBody)} ` +
      `${shellEscape(completeUrl)} -w "%{http_code}"`;

    const result = await this.sessionManager.executeInSession(
      R2_UPLOAD_SESSION_ID,
      completeCommand,
      '/tmp',
      timeout
    );

    if (!result.success) {
      throw new Error(
        `Complete multipart failed: ${result.error?.message || 'Unknown error'}`
      );
    }

    if (result.data.exitCode !== 0) {
      throw new Error(
        `Complete multipart failed: ${result.data.stderr || 'Unknown error'}`
      );
    }

    const httpStatus = result.data.stdout.trim().slice(-3);
    if (!httpStatus.startsWith('2')) {
      throw new Error(
        `Complete multipart failed with HTTP status ${httpStatus}`
      );
    }

    this.logger.debug('Multipart upload completed successfully');
  }

  /**
   * Abort multipart upload on failure
   */
  private async abortMultipartUpload(
    abortUrl: string,
    timeout?: number
  ): Promise<void> {
    try {
      const abortCommand = `curl -s -X DELETE ${shellEscape(abortUrl)} -w "%{http_code}"`;

      const result = await this.sessionManager.executeInSession(
        R2_UPLOAD_SESSION_ID,
        abortCommand,
        '/tmp',
        timeout
      );

      if (result.success && result.data.exitCode === 0) {
        this.logger.debug('Multipart upload aborted');
      } else if (!result.success) {
        this.logger.warn('Failed to abort multipart upload', {
          error: result.error?.message
        });
      } else {
        this.logger.warn('Failed to abort multipart upload', {
          error: result.data.stderr
        });
      }
    } catch (error) {
      this.logger.warn('Error aborting multipart upload', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
