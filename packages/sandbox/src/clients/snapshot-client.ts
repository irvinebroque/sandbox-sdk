/**
 * SnapshotClient - SDK client for container snapshot operations
 *
 * Provides typed methods for creating and restoring volume snapshots.
 */

import type {
  CreateSnapshotRequest,
  CreateSnapshotResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse
} from '@repo/shared';
import { BaseHttpClient } from './base-client';

/**
 * Client for snapshot operations
 */
export class SnapshotClient extends BaseHttpClient {
  /**
   * Create a snapshot and upload to R2
   *
   * @param request - Snapshot creation parameters
   * @returns Response with stats on success
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
        this.logSuccess('Snapshot created', request.snapshotId);
      }

      return response;
    } catch (error) {
      this.logError('createSnapshot', error);
      throw error;
    }
  }

  /**
   * Create a snapshot with streaming progress events
   *
   * @param request - Snapshot creation parameters
   * @returns ReadableStream of SSE events with progress updates
   */
  async createStream(
    request: CreateSnapshotRequest
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const stream = await this.doStreamFetch(
        '/api/snapshot/create/stream',
        request
      );

      this.logSuccess('Snapshot stream started', request.snapshotId);

      return stream;
    } catch (error) {
      this.logError('createSnapshotStream', error);
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
}
