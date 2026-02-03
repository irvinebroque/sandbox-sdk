/**
 * Validation utilities for snapshot IDs and other user-provided identifiers
 */

/**
 * Validates a snapshot ID to prevent path traversal and injection attacks.
 * @param id - The snapshot ID to validate
 * @throws Error if the snapshot ID is invalid
 */
export function validateSnapshotId(id: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error('snapshotId must be a non-empty string');
  }
  if (id.length > 64) {
    throw new Error('snapshotId must be 64 characters or less');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      'snapshotId must contain only alphanumeric characters, hyphens, and underscores'
    );
  }
}
