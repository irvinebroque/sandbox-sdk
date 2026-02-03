import { describe, expect, it } from 'vitest';
import { parseTtl } from '../../src/utils/ttl';

describe('parseTtl', () => {
  describe('valid formats', () => {
    it('parses days correctly', () => {
      const result = parseTtl('5d');
      expect(result).toBe(5 * 24 * 60 * 60 * 1000); // 5 days in ms
    });

    it('parses single day', () => {
      const result = parseTtl('1d');
      expect(result).toBe(24 * 60 * 60 * 1000);
    });

    it('parses weeks correctly', () => {
      const result = parseTtl('2w');
      expect(result).toBe(2 * 7 * 24 * 60 * 60 * 1000);
    });

    it('parses single week', () => {
      const result = parseTtl('1w');
      expect(result).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('parses months correctly (30 days)', () => {
      const result = parseTtl('1m');
      expect(result).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('parses multiple months', () => {
      const result = parseTtl('3m');
      expect(result).toBe(3 * 30 * 24 * 60 * 60 * 1000);
    });

    it('parses years correctly (365 days)', () => {
      const result = parseTtl('1y');
      expect(result).toBe(365 * 24 * 60 * 60 * 1000);
    });

    it('parses multiple years', () => {
      const result = parseTtl('2y');
      expect(result).toBe(2 * 365 * 24 * 60 * 60 * 1000);
    });

    it('returns null for forever', () => {
      expect(parseTtl('forever')).toBeNull();
    });

    it('handles large numeric values', () => {
      const result = parseTtl('100d');
      expect(result).toBe(100 * 24 * 60 * 60 * 1000);
    });
  });

  describe('invalid formats', () => {
    it('throws for missing unit', () => {
      expect(() => parseTtl('5')).toThrow('Invalid TTL format');
    });

    it('throws for invalid unit', () => {
      expect(() => parseTtl('5x')).toThrow('Invalid TTL format');
    });

    it('throws for empty string', () => {
      expect(() => parseTtl('')).toThrow('Invalid TTL format');
    });

    it('throws for reversed format (unit before number)', () => {
      expect(() => parseTtl('d5')).toThrow('Invalid TTL format');
    });

    it('throws for decimal values', () => {
      expect(() => parseTtl('1.5d')).toThrow('Invalid TTL format');
    });

    it('throws for negative values', () => {
      expect(() => parseTtl('-5d')).toThrow('Invalid TTL format');
    });

    it('throws for hours (unsupported unit)', () => {
      expect(() => parseTtl('24h')).toThrow('Invalid TTL format');
    });

    it('throws for minutes (unsupported unit)', () => {
      expect(() => parseTtl('60min')).toThrow('Invalid TTL format');
    });

    it('throws for seconds (unsupported unit)', () => {
      expect(() => parseTtl('3600s')).toThrow('Invalid TTL format');
    });

    it('throws for whitespace', () => {
      expect(() => parseTtl(' 5d')).toThrow('Invalid TTL format');
      expect(() => parseTtl('5d ')).toThrow('Invalid TTL format');
      expect(() => parseTtl('5 d')).toThrow('Invalid TTL format');
    });

    it('throws for uppercase units', () => {
      expect(() => parseTtl('5D')).toThrow('Invalid TTL format');
      expect(() => parseTtl('1W')).toThrow('Invalid TTL format');
    });

    it('throws for mixed case forever', () => {
      expect(() => parseTtl('Forever')).toThrow('Invalid TTL format');
      expect(() => parseTtl('FOREVER')).toThrow('Invalid TTL format');
    });
  });

  describe('bounds validation', () => {
    it('throws for zero value', () => {
      expect(() => parseTtl('0d')).toThrow('must be positive');
    });

    it('throws for TTL exceeding 10 years', () => {
      expect(() => parseTtl('11y')).toThrow('exceeds maximum');
    });

    it('throws for TTL exceeding 10 years in days', () => {
      expect(() => parseTtl('3651d')).toThrow('exceeds maximum');
    });

    it('throws for TTL exceeding 10 years in weeks', () => {
      // 522 weeks = 3654 days > 3650
      expect(() => parseTtl('522w')).toThrow('exceeds maximum');
    });

    it('throws for TTL exceeding 10 years in months', () => {
      // 122 months = 3660 days > 3650
      expect(() => parseTtl('122m')).toThrow('exceeds maximum');
    });

    it('allows TTL of exactly 10 years', () => {
      expect(() => parseTtl('10y')).not.toThrow();
      const result = parseTtl('10y');
      expect(result).toBe(10 * 365 * 24 * 60 * 60 * 1000);
    });

    it('allows TTL of exactly 3650 days', () => {
      expect(() => parseTtl('3650d')).not.toThrow();
      const result = parseTtl('3650d');
      expect(result).toBe(3650 * 24 * 60 * 60 * 1000);
    });

    it('allows TTL just under 10 years in weeks', () => {
      // 521 weeks = 3647 days < 3650
      expect(() => parseTtl('521w')).not.toThrow();
    });

    it('allows TTL just under 10 years in months', () => {
      // 121 months = 3630 days < 3650
      expect(() => parseTtl('121m')).not.toThrow();
    });
  });
});
