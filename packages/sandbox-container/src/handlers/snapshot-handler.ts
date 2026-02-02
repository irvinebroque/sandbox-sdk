/**
 * SnapshotHandler - HTTP handlers for snapshot operations
 *
 * Routes:
 * - POST /api/snapshot/create - Create and upload a snapshot
 * - POST /api/snapshot/restore - Download and restore a snapshot
 * - POST /api/snapshot/manifest - Get current filesystem manifest
 */

import type { Logger } from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { RequestContext } from '../core/types';
import type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  GetManifestRequest,
  GetManifestResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  SnapshotService
} from '../services/snapshot-service';
import { BaseHandler } from './base-handler';

export class SnapshotHandler extends BaseHandler<Request, Response> {
  constructor(
    private snapshotService: SnapshotService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/snapshot/create':
        return await this.handleCreate(request, context);
      case '/api/snapshot/restore':
        return await this.handleRestore(request, context);
      case '/api/snapshot/manifest':
        return await this.handleGetManifest(request, context);
      default:
        return this.createErrorResponse(
          {
            message: 'Invalid snapshot endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleCreate(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const requestLogger = this.createRequestLogger(request, 'snapshot.create');

    try {
      const body = await this.parseRequestBody<CreateSnapshotRequest>(request);

      // Validate required fields
      if (!body.snapshotId) {
        return this.createErrorResponse(
          {
            message: 'snapshotId is required',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      if (!body.volumePath) {
        return this.createErrorResponse(
          {
            message: 'volumePath is required',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      if (!body.uploadUrl) {
        return this.createErrorResponse(
          {
            message: 'uploadUrl is required',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      requestLogger.info('Creating snapshot', {
        snapshotId: body.snapshotId,
        volumePath: body.volumePath
      });

      const result = await this.snapshotService.createSnapshot(body);

      if (!result.success) {
        return this.createErrorResponse(
          {
            message: result.error || 'Snapshot creation failed',
            code: ErrorCode.INTERNAL_ERROR
          },
          context
        );
      }

      const response: CreateSnapshotResponse = {
        success: true,
        manifest: result.manifest,
        contentHash: result.contentHash,
        stats: result.stats
      };

      return this.createTypedResponse(response, context);
    } catch (error) {
      requestLogger.error(
        'Snapshot creation failed',
        error instanceof Error ? error : undefined
      );

      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Snapshot creation failed',
          code: ErrorCode.INTERNAL_ERROR
        },
        context
      );
    }
  }

  private async handleRestore(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const requestLogger = this.createRequestLogger(request, 'snapshot.restore');

    try {
      const body = await this.parseRequestBody<RestoreSnapshotRequest>(request);

      // Validate required fields
      if (!body.volumePath) {
        return this.createErrorResponse(
          {
            message: 'volumePath is required',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      if (!body.downloads || body.downloads.length === 0) {
        return this.createErrorResponse(
          {
            message: 'downloads array is required and must not be empty',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      if (!body.mode || (body.mode !== 'clean' && body.mode !== 'merge')) {
        return this.createErrorResponse(
          {
            message: 'mode must be "clean" or "merge"',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      requestLogger.info('Restoring snapshot', {
        volumePath: body.volumePath,
        mode: body.mode,
        snapshotCount: body.downloads.length
      });

      const result = await this.snapshotService.restoreSnapshot(body);

      if (!result.success) {
        return this.createErrorResponse(
          {
            message: result.error || 'Snapshot restore failed',
            code: ErrorCode.INTERNAL_ERROR
          },
          context
        );
      }

      const response: RestoreSnapshotResponse = {
        success: true,
        stats: result.stats
      };

      return this.createTypedResponse(response, context);
    } catch (error) {
      requestLogger.error(
        'Snapshot restore failed',
        error instanceof Error ? error : undefined
      );

      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Snapshot restore failed',
          code: ErrorCode.INTERNAL_ERROR
        },
        context
      );
    }
  }

  private async handleGetManifest(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const requestLogger = this.createRequestLogger(
      request,
      'snapshot.manifest'
    );

    try {
      const body = await this.parseRequestBody<GetManifestRequest>(request);

      // Validate required fields
      if (!body.volumePath) {
        return this.createErrorResponse(
          {
            message: 'volumePath is required',
            code: ErrorCode.VALIDATION_FAILED
          },
          context
        );
      }

      requestLogger.info('Getting manifest', {
        volumePath: body.volumePath
      });

      const result = await this.snapshotService.getManifest(body);

      if (!result.success) {
        return this.createErrorResponse(
          {
            message: result.error || 'Get manifest failed',
            code: ErrorCode.INTERNAL_ERROR
          },
          context
        );
      }

      const response: GetManifestResponse = {
        success: true,
        files: result.files,
        totalSize: result.totalSize,
        fileCount: result.fileCount
      };

      return this.createTypedResponse(response, context);
    } catch (error) {
      requestLogger.error(
        'Get manifest failed',
        error instanceof Error ? error : undefined
      );

      return this.createErrorResponse(
        {
          message:
            error instanceof Error ? error.message : 'Get manifest failed',
          code: ErrorCode.INTERNAL_ERROR
        },
        context
      );
    }
  }
}
