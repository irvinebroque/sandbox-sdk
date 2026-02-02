/**
 * Volume Snapshot Example
 *
 * Demonstrates how to use volume snapshots to persist:
 * - Cloned git repositories
 * - npm dependencies (node_modules)
 *
 * On first run, clones a repo and installs dependencies (~1-3 minutes).
 * On subsequent runs after sandbox restart, restores from snapshot (~10-30 seconds).
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

// Repository to clone - Cloudflare's Astro blog starter template
const REPO_URL = 'https://github.com/cloudflare/templates.git';
const REPO_SUBDIR = 'astro-blog-starter-template';
const WORKSPACE = '/workspace';
const PROJECT_DIR = `${WORKSPACE}/${REPO_SUBDIR}`;

// Snapshot configuration
const SNAPSHOT_KEY_PREFIX = 'snapshots/';
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

interface SnapshotMetadata {
  id: string;
  createdAt: number;
  r2Key: string;
  repoUrl: string;
  projectDir: string;
}

/**
 * Create an S3 client configured for Cloudflare R2
 */
function createR2Client(env: Env): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY
    }
  });
}

/**
 * Generate a presigned URL for uploading to R2
 */
async function getUploadUrl(env: Env, key: string): Promise<string> {
  const client = createR2Client(env);
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(client, command, { expiresIn: PRESIGNED_URL_EXPIRY });
}

/**
 * Generate a presigned URL for downloading from R2
 */
async function getDownloadUrl(env: Env, key: string): Promise<string> {
  const client = createR2Client(env);
  const command = new GetObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(client, command, { expiresIn: PRESIGNED_URL_EXPIRY });
}

/**
 * GET /setup - Clone repo, install deps, create snapshot
 *
 * This endpoint:
 * 1. Checks if a snapshot exists and restores it if so
 * 2. Otherwise, clones the repo and installs npm dependencies
 * 3. Creates a snapshot for future use
 */
async function handleSetup(env: Env): Promise<Response> {
  const startTime = Date.now();
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');
  const steps: string[] = [];

  try {
    // Check for existing snapshot
    const existingSnapshot = await env.SNAPSHOTS.head(
      `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
    );

    if (existingSnapshot) {
      steps.push('Found existing snapshot, restoring...');

      // Configure snapshots with auto-restore
      await sandbox.configureSnapshots({
        enabled: true,
        volumePath: WORKSPACE,
        maxSnapshots: 5,
        compressionLevel: 'balanced',
        excludePatterns: [],
        autoRestoreOnWake: true,
        autoSnapshotOnSleep: true
      });

      // Generate download URL and restore
      const downloadUrl = await getDownloadUrl(
        env,
        `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
      );
      const restoreResult = await sandbox.restoreSnapshot(
        downloadUrl,
        'latest'
      );

      if (restoreResult.success) {
        steps.push(
          `Restored ${restoreResult.stats.filesRestored} files in ${restoreResult.stats.duration}ms`
        );

        // Verify restoration
        const checkResult = await sandbox.exec(`ls -la ${PROJECT_DIR}`);
        steps.push('Verified project directory exists');

        return Response.json({
          success: true,
          restored: true,
          duration: Date.now() - startTime,
          steps,
          projectDir: PROJECT_DIR,
          stats: restoreResult.stats
        });
      } else {
        steps.push('Snapshot restore failed, falling back to fresh setup');
      }
    }

    // No snapshot or restore failed - do fresh setup
    steps.push('No snapshot found, performing fresh setup...');

    // Configure snapshots
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'balanced',
      excludePatterns: [],
      autoRestoreOnWake: true,
      autoSnapshotOnSleep: true
    });
    steps.push('Configured snapshot settings');

    // Clone the repository with sparse checkout for just the template we need
    steps.push(`Cloning ${REPO_URL}...`);
    const cloneStart = Date.now();

    // Use sparse checkout to only get the astro-blog-starter-template directory
    await sandbox.exec(
      `git clone --filter=blob:none --sparse ${REPO_URL} templates-repo`,
      {
        cwd: WORKSPACE,
        timeout: 120000 // 2 minutes
      }
    );

    await sandbox.exec('git sparse-checkout set astro-blog-starter-template', {
      cwd: `${WORKSPACE}/templates-repo`
    });

    // Move the template to the workspace root
    await sandbox.exec(`mv templates-repo/${REPO_SUBDIR} ${PROJECT_DIR}`);
    await sandbox.exec('rm -rf templates-repo', { cwd: WORKSPACE });

    const cloneDuration = Date.now() - cloneStart;
    steps.push(`Cloned repository in ${cloneDuration}ms`);

    // Install npm dependencies
    steps.push('Installing npm dependencies...');
    const npmStart = Date.now();

    const npmResult = await sandbox.exec('npm install', {
      cwd: PROJECT_DIR,
      timeout: 300000 // 5 minutes
    });

    if (!npmResult.success) {
      throw new Error(`npm install failed: ${npmResult.stderr}`);
    }

    const npmDuration = Date.now() - npmStart;
    steps.push(`Installed dependencies in ${npmDuration}ms`);

    // Create snapshot
    steps.push('Creating snapshot...');
    const snapshotStart = Date.now();

    const snapshotId = `snapshot-${Date.now()}`;
    const r2Key = `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`;
    const uploadUrl = await getUploadUrl(env, r2Key);

    const snapshotResult = await sandbox.createSnapshot(uploadUrl);

    if (!snapshotResult.success) {
      throw new Error(`Snapshot creation failed: ${snapshotResult.error}`);
    }

    const snapshotDuration = Date.now() - snapshotStart;
    steps.push(
      `Created snapshot in ${snapshotDuration}ms (${snapshotResult.stats?.totalFiles} files, ${formatBytes(snapshotResult.stats?.compressedBytes || 0)})`
    );

    // Store snapshot metadata
    const metadata: SnapshotMetadata = {
      id: snapshotId,
      createdAt: Date.now(),
      r2Key,
      repoUrl: REPO_URL,
      projectDir: PROJECT_DIR
    };
    await env.SNAPSHOTS.put(
      `${SNAPSHOT_KEY_PREFIX}metadata.json`,
      JSON.stringify(metadata)
    );
    steps.push('Saved snapshot metadata');

    return Response.json({
      success: true,
      restored: false,
      freshSetup: true,
      duration: Date.now() - startTime,
      steps,
      projectDir: PROJECT_DIR,
      snapshotStats: snapshotResult.stats
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        success: false,
        error: message,
        steps,
        duration: Date.now() - startTime
      },
      { status: 500 }
    );
  }
}

/**
 * GET /status - Check if files exist (proves snapshot restoration)
 */
async function handleStatus(env: Env): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

  try {
    // Check for key files
    const checks = await Promise.all([
      sandbox.exec(`test -f ${PROJECT_DIR}/package.json && echo "exists"`),
      sandbox.exec(`test -d ${PROJECT_DIR}/node_modules && echo "exists"`),
      sandbox.exec(
        `test -d ${PROJECT_DIR}/.git || test -f ${PROJECT_DIR}/.git && echo "exists"`
      ),
      sandbox.exec(`ls ${PROJECT_DIR}/node_modules 2>/dev/null | wc -l`)
    ]);

    const [packageJson, nodeModules, gitDir, nodeModulesCount] = checks;

    // Get snapshot metadata if available
    const metadataObj = await env.SNAPSHOTS.get(
      `${SNAPSHOT_KEY_PREFIX}metadata.json`
    );
    const metadata = metadataObj
      ? await metadataObj.json<SnapshotMetadata>()
      : null;

    // Check if snapshot exists
    const snapshotExists = await env.SNAPSHOTS.head(
      `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
    );

    return Response.json({
      projectDir: PROJECT_DIR,
      filesExist: {
        'package.json': packageJson.stdout.includes('exists'),
        node_modules: nodeModules.stdout.includes('exists'),
        '.git': gitDir.stdout.includes('exists')
      },
      nodeModulesPackageCount: parseInt(nodeModulesCount.stdout.trim()) || 0,
      snapshotExists: !!snapshotExists,
      snapshotMetadata: metadata
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /snapshot - Manually create a new snapshot
 */
async function handleCreateSnapshot(env: Env): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

  try {
    // Ensure snapshots are configured
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'balanced',
      excludePatterns: []
    });

    const r2Key = `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`;
    const uploadUrl = await getUploadUrl(env, r2Key);

    const startTime = Date.now();
    const result = await sandbox.createSnapshot(uploadUrl);
    const duration = Date.now() - startTime;

    if (!result.success) {
      throw new Error(result.error || 'Snapshot creation failed');
    }

    // Update metadata
    const metadata: SnapshotMetadata = {
      id: `snapshot-${Date.now()}`,
      createdAt: Date.now(),
      r2Key,
      repoUrl: REPO_URL,
      projectDir: PROJECT_DIR
    };
    await env.SNAPSHOTS.put(
      `${SNAPSHOT_KEY_PREFIX}metadata.json`,
      JSON.stringify(metadata)
    );

    return Response.json({
      success: true,
      duration,
      stats: result.stats
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * POST /restore - Manually restore from snapshot
 */
async function handleRestore(env: Env): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

  try {
    // Check if snapshot exists
    const snapshotExists = await env.SNAPSHOTS.head(
      `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
    );
    if (!snapshotExists) {
      return Response.json(
        { success: false, error: 'No snapshot found. Run /setup first.' },
        { status: 404 }
      );
    }

    // Configure snapshots
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'balanced',
      excludePatterns: []
    });

    const downloadUrl = await getDownloadUrl(
      env,
      `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
    );

    const startTime = Date.now();
    const result = await sandbox.restoreSnapshot(downloadUrl, 'latest');
    const duration = Date.now() - startTime;

    if (!result.success) {
      throw new Error('Restore failed');
    }

    return Response.json({
      success: true,
      duration,
      stats: result.stats
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /snapshot - Delete the snapshot
 */
async function handleDeleteSnapshot(env: Env): Promise<Response> {
  try {
    await env.SNAPSHOTS.delete(`${SNAPSHOT_KEY_PREFIX}latest.tar.zst`);
    await env.SNAPSHOTS.delete(`${SNAPSHOT_KEY_PREFIX}metadata.json`);

    return Response.json({ success: true, message: 'Snapshot deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * GET /run - Run npm command to verify the project works
 */
async function handleRun(env: Env): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

  try {
    // Run a quick npm command to verify everything works
    const result = await sandbox.exec('npm run build', {
      cwd: PROJECT_DIR,
      timeout: 120000
    });

    return Response.json({
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration: result.duration
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route requests
    switch (url.pathname) {
      case '/setup':
        if (request.method === 'GET') return handleSetup(env);
        break;

      case '/status':
        if (request.method === 'GET') return handleStatus(env);
        break;

      case '/snapshot':
        if (request.method === 'POST') return handleCreateSnapshot(env);
        if (request.method === 'DELETE') return handleDeleteSnapshot(env);
        break;

      case '/restore':
        if (request.method === 'POST') return handleRestore(env);
        break;

      case '/run':
        if (request.method === 'GET') return handleRun(env);
        break;
    }

    // Default response with usage info
    return Response.json({
      message: 'Volume Snapshot Example',
      endpoints: {
        'GET /setup':
          'Clone repo, install deps, create snapshot (or restore if exists)',
        'GET /status': 'Check if files exist (proves snapshot restoration)',
        'POST /snapshot': 'Manually create a new snapshot',
        'POST /restore': 'Manually restore from snapshot',
        'DELETE /snapshot': 'Delete the snapshot',
        'GET /run': 'Run npm build to verify project works'
      },
      workflow: [
        '1. GET /setup - First run clones repo and installs deps (~1-3 min)',
        '2. Wait for sandbox to sleep (or force restart)',
        '3. GET /setup - Second run restores from snapshot (~10-30 sec)',
        '4. GET /status - Verify files exist',
        '5. GET /run - Verify npm build works'
      ]
    });
  }
} satisfies ExportedHandler<Env>;
