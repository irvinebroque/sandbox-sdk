/** Maximum TTL in days (10 years) */
const MAX_TTL_DAYS = 365 * 10;

/** Day multipliers for TTL units */
const DAY_MULTIPLIERS: Record<string, number> = {
  d: 1,
  w: 7,
  m: 30,
  y: 365
};

/** Millisecond multipliers for TTL units */
const MS_MULTIPLIERS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000, // days
  w: 7 * 24 * 60 * 60 * 1000, // weeks
  m: 30 * 24 * 60 * 60 * 1000, // months (30 days)
  y: 365 * 24 * 60 * 60 * 1000 // years
};

/**
 * Parse TTL string to milliseconds
 *
 * Supports: '5d', '30d', '1w', '1m', '1y', 'forever'
 *
 * @param ttl - TTL string like '5d' (5 days), '1w' (1 week), etc.
 * @returns Milliseconds until expiration, or null for 'forever' (never expires)
 * @throws Error if format is invalid, value is not positive, or exceeds 10 year maximum
 *
 * @example
 * parseTtl('5d')     // 432000000 (5 days in ms)
 * parseTtl('1w')     // 604800000 (7 days in ms)
 * parseTtl('forever') // null (never expires)
 */
export function parseTtl(ttl: string): number | null {
  if (ttl === 'forever') return null;

  const match = ttl.match(/^(\d+)(d|w|m|y)$/);
  if (!match) {
    throw new Error(
      `Invalid TTL format: "${ttl}". Use format like '5d', '1w', '1m', '1y', or 'forever'`
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (value <= 0) {
    throw new Error('TTL value must be positive');
  }

  // Calculate days equivalent for bounds checking
  const daysEquivalent = value * DAY_MULTIPLIERS[unit];

  if (daysEquivalent > MAX_TTL_DAYS) {
    throw new Error(`TTL exceeds maximum of ${MAX_TTL_DAYS} days (10 years)`);
  }

  return value * MS_MULTIPLIERS[unit];
}
