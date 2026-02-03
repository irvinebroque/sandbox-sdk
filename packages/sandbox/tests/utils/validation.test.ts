import { describe, expect, it } from 'vitest';
import { validateSnapshotId } from '../../src/utils/validation';

describe('validateSnapshotId', () => {
  describe('valid snapshot IDs', () => {
    it('accepts valid alphanumeric IDs', () => {
      expect(() => validateSnapshotId('snap123')).not.toThrow();
      expect(() => validateSnapshotId('mySnapshot')).not.toThrow();
      expect(() => validateSnapshotId('SNAPSHOT')).not.toThrow();
    });

    it('accepts IDs with hyphens', () => {
      expect(() => validateSnapshotId('snap-123')).not.toThrow();
      expect(() => validateSnapshotId('my-snapshot-v2')).not.toThrow();
      expect(() => validateSnapshotId('a-b-c')).not.toThrow();
    });

    it('accepts IDs with underscores', () => {
      expect(() => validateSnapshotId('snap_123')).not.toThrow();
      expect(() => validateSnapshotId('my_snapshot_v2')).not.toThrow();
      expect(() => validateSnapshotId('a_b_c')).not.toThrow();
    });

    it('accepts IDs with mixed hyphens and underscores', () => {
      expect(() => validateSnapshotId('snap-123_v2')).not.toThrow();
      expect(() => validateSnapshotId('my_snapshot-final')).not.toThrow();
    });

    it('accepts single character IDs', () => {
      expect(() => validateSnapshotId('a')).not.toThrow();
      expect(() => validateSnapshotId('1')).not.toThrow();
      expect(() => validateSnapshotId('-')).not.toThrow();
      expect(() => validateSnapshotId('_')).not.toThrow();
    });

    it('accepts IDs at exactly 64 characters', () => {
      const id64 = 'a'.repeat(64);
      expect(() => validateSnapshotId(id64)).not.toThrow();
    });
  });

  describe('path traversal prevention', () => {
    it('rejects path traversal with ../', () => {
      expect(() => validateSnapshotId('../etc/passwd')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects path traversal with /', () => {
      expect(() => validateSnapshotId('foo/bar')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects path traversal with backslash', () => {
      expect(() => validateSnapshotId('foo\\bar')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects hidden file attempts', () => {
      expect(() => validateSnapshotId('.hidden')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });
  });

  describe('length validation', () => {
    it('rejects IDs over 64 characters', () => {
      const longId = 'a'.repeat(65);
      expect(() => validateSnapshotId(longId)).toThrow('64 characters');
    });

    it('rejects very long IDs', () => {
      const veryLongId = 'a'.repeat(1000);
      expect(() => validateSnapshotId(veryLongId)).toThrow('64 characters');
    });
  });

  describe('empty and null values', () => {
    it('rejects empty strings', () => {
      expect(() => validateSnapshotId('')).toThrow('non-empty string');
    });

    it('rejects null', () => {
      expect(() => validateSnapshotId(null as unknown as string)).toThrow(
        'non-empty string'
      );
    });

    it('rejects undefined', () => {
      expect(() => validateSnapshotId(undefined as unknown as string)).toThrow(
        'non-empty string'
      );
    });
  });

  describe('special characters rejection', () => {
    it('rejects @ symbol', () => {
      expect(() => validateSnapshotId('snap@123')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects spaces', () => {
      expect(() => validateSnapshotId('snap 123')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects dots', () => {
      expect(() => validateSnapshotId('snap.123')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects colons', () => {
      expect(() => validateSnapshotId('snap:123')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects asterisks', () => {
      expect(() => validateSnapshotId('snap*')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects question marks', () => {
      expect(() => validateSnapshotId('snap?')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects quotes', () => {
      expect(() => validateSnapshotId('snap"test')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId("snap'test")).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects angle brackets', () => {
      expect(() => validateSnapshotId('snap<script>')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects shell metacharacters', () => {
      expect(() => validateSnapshotId('snap;rm -rf')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId('snap|cat')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId('snap&')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId('snap$(cmd)')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId('snap`cmd`')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });

    it('rejects unicode characters', () => {
      expect(() => validateSnapshotId('snap🚀')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
      expect(() => validateSnapshotId('スナップ')).toThrow(
        'alphanumeric characters, hyphens, and underscores'
      );
    });
  });
});
