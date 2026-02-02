/**
 * Parse TTL string to milliseconds
 * Supports: '5d', '30d', '1w', '1m', '1y', 'forever'
 *
 * @param ttl - TTL string like '5d' (5 days), '1w' (1 week), etc.
 * @returns milliseconds, or null for 'forever'
 * @throws Error if format is invalid
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

  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
    m: 30 * 24 * 60 * 60 * 1000, // months (30 days)
    y: 365 * 24 * 60 * 60 * 1000 // years
  };

  return value * multipliers[unit];
}
