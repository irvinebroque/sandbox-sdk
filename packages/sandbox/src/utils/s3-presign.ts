/**
 * AWS Signature V4 Presigned URL Generation for R2
 *
 * Generates presigned URLs for Cloudflare R2 storage without requiring the AWS SDK.
 * Uses Web Crypto API for HMAC-SHA256 and SHA256 operations, making it compatible
 * with Cloudflare Workers and other edge runtimes.
 *
 * R2 is S3-compatible, so standard AWS Signature V4 presigning works with these adjustments:
 * - Region is always "auto" for R2
 * - Endpoint format is https://{accountId}.r2.cloudflarestorage.com
 */

import type { R2CredentialConfig } from '@repo/shared';

/** Default URL expiry in seconds (1 hour) */
const DEFAULT_URL_EXPIRY = 3600;

/** AWS region for R2 (always "auto") */
const R2_REGION = 'auto';

/** Service name for S3-compatible signing */
const S3_SERVICE = 's3';

/** Algorithm identifier for AWS Signature V4 */
const AWS4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** Payload hash for presigned URLs (content not known at signing time) */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * Generate a presigned PUT URL for uploading an object to R2
 *
 * @param config - R2 credential configuration
 * @param key - Object key (path within the bucket)
 * @returns Presigned URL for PUT request
 *
 * @example
 * ```typescript
 * const uploadUrl = await generatePresignedPutUrl(config, 'snapshots/my-snapshot.tar.zst');
 * await fetch(uploadUrl, { method: 'PUT', body: archiveData });
 * ```
 */
export async function generatePresignedPutUrl(
  config: R2CredentialConfig,
  key: string
): Promise<string> {
  return generatePresignedUrl(config, key, 'PUT');
}

/**
 * Generate a presigned GET URL for downloading an object from R2
 *
 * @param config - R2 credential configuration
 * @param key - Object key (path within the bucket)
 * @returns Presigned URL for GET request
 *
 * @example
 * ```typescript
 * const downloadUrl = await generatePresignedGetUrl(config, 'snapshots/my-snapshot.tar.zst');
 * const response = await fetch(downloadUrl);
 * ```
 */
export async function generatePresignedGetUrl(
  config: R2CredentialConfig,
  key: string
): Promise<string> {
  return generatePresignedUrl(config, key, 'GET');
}

/**
 * Generate a presigned URL for R2 using AWS Signature V4
 *
 * @param config - R2 credential configuration
 * @param key - Object key (path within the bucket)
 * @param method - HTTP method (GET or PUT)
 * @returns Presigned URL
 */
async function generatePresignedUrl(
  config: R2CredentialConfig,
  key: string,
  method: 'GET' | 'PUT'
): Promise<string> {
  const { accountId, bucketName, accessKeyId, secretAccessKey, urlExpiry } =
    config;

  const expirySeconds = urlExpiry ?? DEFAULT_URL_EXPIRY;

  // Build endpoint URL
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const host = `${accountId}.r2.cloudflarestorage.com`;

  // Normalize the key (ensure no leading slash, then URI encode path segments)
  const normalizedKey = key.startsWith('/') ? key.slice(1) : key;
  const encodedKey = normalizedKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  // Generate timestamps
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = formatDateStamp(now);

  // Build credential scope
  const credentialScope = `${dateStamp}/${R2_REGION}/${S3_SERVICE}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Canonical URI (path component)
  const canonicalUri = `/${bucketName}/${encodedKey}`;

  // Signed headers (only host for presigned URLs)
  const signedHeaders = 'host';

  // Build query parameters (must be sorted alphabetically for signing)
  const queryParams = new Map<string, string>([
    ['X-Amz-Algorithm', AWS4_ALGORITHM],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', expirySeconds.toString()],
    ['X-Amz-SignedHeaders', signedHeaders]
  ]);

  // Create canonical query string (sorted and encoded)
  const canonicalQueryString = buildCanonicalQueryString(queryParams);

  // Canonical headers
  const canonicalHeaders = `host:${host}\n`;

  // Create canonical request
  // For presigned URLs, the payload hash is always UNSIGNED-PAYLOAD
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD
  ].join('\n');

  // Hash the canonical request
  const canonicalRequestHash = await sha256Hex(canonicalRequest);

  // Create string to sign
  const stringToSign = [
    AWS4_ALGORITHM,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  // Derive signing key
  const signingKey = await deriveSigningKey(
    secretAccessKey,
    dateStamp,
    R2_REGION,
    S3_SERVICE
  );

  // Calculate signature
  const signature = await hmacSha256Hex(signingKey, stringToSign);

  // Build final URL with signature
  const signedQueryString = `${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return `${endpoint}${canonicalUri}?${signedQueryString}`;
}

/**
 * Build canonical query string from parameters
 * Parameters must be URI-encoded and sorted alphabetically by key
 */
function buildCanonicalQueryString(params: Map<string, string>): string {
  const sortedKeys = Array.from(params.keys()).sort();

  return sortedKeys
    .map((key) => {
      const value = params.get(key)!;
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
}

/**
 * Format date as AWS4 date string (YYYYMMDDTHHMMSSZ)
 */
function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Format date as date stamp (YYYYMMDD)
 */
function formatDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Derive AWS4 signing key using HMAC chain
 *
 * SigningKey = HMAC(HMAC(HMAC(HMAC("AWS4" + secretKey, date), region), service), "aws4_request")
 */
async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();

  // Step 1: HMAC(AWS4 + secretKey, dateStamp)
  const kSecret = encoder.encode(`AWS4${secretAccessKey}`);
  const kDate = await hmacSha256(kSecret, encoder.encode(dateStamp));

  // Step 2: HMAC(kDate, region)
  const kRegion = await hmacSha256(kDate, encoder.encode(region));

  // Step 3: HMAC(kRegion, service)
  const kService = await hmacSha256(kRegion, encoder.encode(service));

  // Step 4: HMAC(kService, "aws4_request")
  const kSigning = await hmacSha256(kService, encoder.encode('aws4_request'));

  return kSigning;
}

/**
 * Compute HMAC-SHA256 using Web Crypto API
 *
 * @param key - Key as ArrayBuffer or Uint8Array
 * @param data - Data to sign as Uint8Array
 * @returns HMAC result as ArrayBuffer
 */
async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  data: Uint8Array
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return crypto.subtle.sign('HMAC', cryptoKey, data);
}

/**
 * Compute HMAC-SHA256 and return as hex string
 *
 * @param key - Key as ArrayBuffer
 * @param data - Data to sign as string
 * @returns HMAC result as lowercase hex string
 */
async function hmacSha256Hex(key: ArrayBuffer, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const result = await hmacSha256(key, encoder.encode(data));
  return arrayBufferToHex(result);
}

/**
 * Compute SHA-256 hash and return as hex string
 *
 * @param data - Data to hash
 * @returns SHA-256 hash as lowercase hex string
 */
async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return arrayBufferToHex(hash);
}

/**
 * Convert ArrayBuffer to lowercase hex string
 */
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
