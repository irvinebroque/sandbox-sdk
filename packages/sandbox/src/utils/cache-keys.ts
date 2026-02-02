/**
 * Content-addressed cache key utilities
 *
 * Generates SHA-256 hashes for content-addressed caching of snapshots.
 * When the same lockfile content produces the same cache key, snapshots
 * can be shared across builds with identical dependencies.
 */

/**
 * Priority-ordered list of lockfile paths to check for cache key generation
 * Checked in order - first match wins
 */
const LOCKFILE_PATHS = [
  // npm
  'package-lock.json',
  // pnpm
  'pnpm-lock.yaml',
  // yarn
  'yarn.lock',
  // bun (text format first, then binary)
  'bun.lock',
  'bun.lockb'
] as const;

/**
 * Generate a SHA-256 cache key from content
 *
 * Uses Web Crypto API (available in Workers and modern Node.js)
 *
 * @param content - String or binary content to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function generateCacheKey(
  content: string | Uint8Array
): Promise<string> {
  const encoder = new TextEncoder();
  const data = typeof content === 'string' ? encoder.encode(content) : content;

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert to hex string
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Interface for sandbox methods needed for lockfile detection
 */
interface SandboxLike {
  readFile(path: string): Promise<{ success: boolean; content: string }>;
}

/**
 * Generate a cache key from lockfile content
 *
 * Tries lockfiles in priority order and returns the hash of the first
 * one found. This enables content-addressed caching where builds with
 * identical dependencies share the same snapshot.
 *
 * @param sandbox - Sandbox instance for file operations
 * @param cwd - Working directory to search for lockfiles
 * @returns Cache key hash and lockfile path, or null if no lockfile found
 */
export async function generateLockfileCacheKey(
  sandbox: SandboxLike,
  cwd: string
): Promise<{ cacheKey: string; lockfilePath: string } | null> {
  for (const lockfile of LOCKFILE_PATHS) {
    const lockfilePath = cwd.endsWith('/')
      ? `${cwd}${lockfile}`
      : `${cwd}/${lockfile}`;

    try {
      const result = await sandbox.readFile(lockfilePath);

      // Skip failed reads or empty files
      if (
        !result.success ||
        !result.content ||
        result.content.trim().length === 0
      ) {
        continue;
      }

      const cacheKey = await generateCacheKey(result.content);
      return { cacheKey, lockfilePath };
    } catch {
      // Lockfile doesn't exist or can't be read - continue to next type
    }
  }

  return null;
}

/**
 * Generate a cache key with optional custom content prefix
 *
 * Useful for creating cache keys that include additional context
 * (e.g., Node version, environment flags)
 *
 * @param content - Primary content to hash
 * @param prefix - Optional prefix to include in hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function generatePrefixedCacheKey(
  content: string | Uint8Array,
  prefix?: string
): Promise<string> {
  if (!prefix) {
    return generateCacheKey(content);
  }

  // Combine prefix and content with a delimiter
  const encoder = new TextEncoder();
  const prefixData = encoder.encode(`${prefix}\0`); // Null byte delimiter
  const contentData =
    typeof content === 'string' ? encoder.encode(content) : content;

  // Concatenate arrays
  const combined = new Uint8Array(prefixData.length + contentData.length);
  combined.set(prefixData, 0);
  combined.set(contentData, prefixData.length);

  return generateCacheKey(combined);
}
