/**
 * HMAC token generation for Cloudflare CDN cache access
 *
 * Generates signed URLs compatible with Cloudflare WAF's is_timed_hmac_valid_v0() function.
 * Uses Web Crypto API (available in Workers environment).
 *
 * URL format: https://{domain}{path}?mac={base64url_hmac}&expiry={unix_timestamp}
 * HMAC message format: {path}{expiry}
 */

/**
 * Generate a signed URL for Cloudflare CDN cache access
 *
 * @param domain - The custom domain for cached downloads (e.g., "snapshots.example.com")
 * @param path - The path to the resource (e.g., "/snapshots/sandbox-id/snap-123.tar.zst")
 * @param secret - The HMAC secret for signing
 * @param ttlSeconds - Time-to-live for the signed URL in seconds
 * @returns Signed URL with mac and expiry query parameters
 */
export async function generateSignedCacheUrl(
  domain: string,
  path: string,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  // Calculate expiry timestamp
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;

  // Build the message to sign: {path}{expiry}
  // This matches Cloudflare's is_timed_hmac_valid_v0() expected format
  const message = `${path}${expiry}`;

  // Generate HMAC-SHA256 signature
  const mac = await generateHmac(message, secret);

  // Construct the signed URL
  const url = new URL(`https://${domain}${path}`);
  url.searchParams.set('mac', mac);
  url.searchParams.set('expiry', expiry.toString());

  return url.toString();
}

/**
 * Generate HMAC-SHA256 signature using Web Crypto API
 *
 * @param message - The message to sign
 * @param secret - The HMAC secret
 * @returns Base64URL-encoded HMAC signature
 */
async function generateHmac(message: string, secret: string): Promise<string> {
  // Import the secret key
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // Sign the message
  const messageData = encoder.encode(message);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);

  // Convert to base64url encoding (URL-safe base64 without padding)
  return arrayBufferToBase64Url(signature);
}

/**
 * Convert ArrayBuffer to base64url string
 *
 * Base64url is URL-safe base64: replaces + with -, / with _, and removes padding
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  // Standard base64
  const base64 = btoa(binary);

  // Convert to base64url: replace + with -, / with _, remove =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Parse components from a signed cache URL
 * Useful for validation and debugging
 *
 * @param signedUrl - The signed URL to parse
 * @returns Parsed components or null if invalid
 */
export function parseSignedCacheUrl(signedUrl: string): {
  domain: string;
  path: string;
  mac: string;
  expiry: number;
} | null {
  try {
    const url = new URL(signedUrl);
    const mac = url.searchParams.get('mac');
    const expiryStr = url.searchParams.get('expiry');

    if (!mac || !expiryStr) {
      return null;
    }

    const expiry = parseInt(expiryStr, 10);
    if (Number.isNaN(expiry)) {
      return null;
    }

    // Get path without query string
    const path = url.pathname;

    return {
      domain: url.host,
      path,
      mac,
      expiry
    };
  } catch {
    return null;
  }
}

/**
 * Check if a signed URL has expired
 *
 * @param signedUrl - The signed URL to check
 * @returns true if expired, false if still valid, null if URL is invalid
 */
export function isSignedUrlExpired(signedUrl: string): boolean | null {
  const parsed = parseSignedCacheUrl(signedUrl);
  if (!parsed) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  return now >= parsed.expiry;
}
