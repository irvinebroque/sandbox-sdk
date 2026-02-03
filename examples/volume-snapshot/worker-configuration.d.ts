/* eslint-disable */
// Type definitions for Cloudflare Worker environment

import type { Sandbox } from '@cloudflare/sandbox';

declare global {
  interface Env {
    // Durable Object binding for sandbox instances
    Sandbox: DurableObjectNamespace<Sandbox>;

    // R2 bucket for storing volume snapshots
    SNAPSHOTS: R2Bucket;

    // Cloudflare account ID (used for R2 endpoint construction)
    CF_ACCOUNT_ID: string;

    // R2 bucket name
    R2_BUCKET_NAME: string;

    // R2 S3-compatible credentials for presigned URLs
    // These are needed because the container uploads/downloads directly to R2
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}

export {};
