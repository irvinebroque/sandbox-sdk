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
  createLogger,
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  getSandbox,
  type LogContext,
  type Logger,
  parseSSEStream,
  type R2CredentialConfig,
  type SnapshotProgressEvent
} from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

// Repository to clone - Astro blog starter template
const REPO_URL =
  'https://github.com/irvinebroque/astro-blog-starter-template.git';
const WORKSPACE = '/workspace';
const PROJECT_DIR = `${WORKSPACE}/astro-blog-starter-template`;
const STATE_FILE = `${WORKSPACE}/.sandbox-state.json`;

// Snapshot configuration
const SNAPSHOT_KEY_PREFIX = 'snapshots/';
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

/**
 * Filter function to identify significant npm output lines.
 * Reduces noise by only showing summary lines, warnings, errors, and progress milestones.
 */
function isSignificantNpmLine(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes('added') ||
    lower.includes('removed') ||
    lower.includes('packages') ||
    lower.includes('warn') ||
    lower.includes('error') ||
    lower.includes('npm err') ||
    lower.includes('npm warn') ||
    lower.includes('installing') ||
    /^\d+\s+(packages|dependencies)/.test(line) ||
    line.startsWith('>')
  );
}

interface SnapshotMetadata {
  id: string;
  createdAt: number;
  r2Key: string;
  repoUrl: string;
  projectDir: string;
}

/**
 * Persistent state that survives snapshots, proving restoration works
 */
interface SandboxState {
  visitCount: number; // Increments every /setup call
  firstVisitTime: number; // Timestamp of first ever visit
  lastFreshSetupTime: number; // How long fresh setup took (ms)
  lastRestoreTime: number; // How long restore took (ms)
  snapshotCreatedAt: number; // When snapshot was created
}

/**
 * Build R2 credential config from environment variables
 */
function getR2Credentials(env: Env): R2CredentialConfig {
  return {
    accountId: env.CF_ACCOUNT_ID,
    bucketName: env.R2_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    urlExpiry: PRESIGNED_URL_EXPIRY
  };
}

/**
 * Generate a presigned URL for uploading to R2
 */
async function getUploadUrl(env: Env, key: string): Promise<string> {
  return generatePresignedPutUrl(getR2Credentials(env), key);
}

/**
 * Generate a presigned URL for downloading from R2
 */
async function getDownloadUrl(env: Env, key: string): Promise<string> {
  return generatePresignedGetUrl(getR2Credentials(env), key);
}

/**
 * SSE event types for setup streaming
 */
interface SetupStepEvent {
  type: 'step';
  message: string;
}

interface SetupLogEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  elapsed: number; // ms since start
}

interface SetupCompleteEvent {
  type: 'complete';
  success: true;
  restored: boolean;
  duration: number;
  state: SandboxState;
  stats?: {
    filesRestored?: number;
    totalFiles?: number;
    compressedBytes?: number;
  };
}

interface SetupErrorEvent {
  type: 'error';
  message: string;
}

type SetupEvent =
  | SetupStepEvent
  | SetupLogEvent
  | SetupCompleteEvent
  | SetupErrorEvent;

/**
 * Read sandbox state from file (returns default state if not found)
 */
async function readSandboxState(
  sandbox: ReturnType<typeof getSandbox>
): Promise<SandboxState> {
  try {
    const result = await sandbox.exec(`cat ${STATE_FILE}`, { timeout: 5000 });
    if (result.success && result.stdout.trim()) {
      return JSON.parse(result.stdout.trim()) as SandboxState;
    }
  } catch {
    // File doesn't exist or parse error
  }
  return {
    visitCount: 0,
    firstVisitTime: 0,
    lastFreshSetupTime: 0,
    lastRestoreTime: 0,
    snapshotCreatedAt: 0
  };
}

/**
 * Write sandbox state to file
 */
async function writeSandboxState(
  sandbox: ReturnType<typeof getSandbox>,
  state: SandboxState
): Promise<void> {
  const json = JSON.stringify(state, null, 2);
  // Use echo with proper escaping
  await sandbox.exec(`cat > ${STATE_FILE} << 'EOFSTATE'\n${json}\nEOFSTATE`, {
    timeout: 5000
  });
}

/**
 * GET /setup - Clone repo, install deps, create snapshot (SSE streaming)
 *
 * This endpoint streams progress via Server-Sent Events:
 * 1. Reads/updates persistent state (visit counter, timing)
 * 2. Checks if a snapshot exists and restores it if so
 * 3. Otherwise, clones the repo and installs npm dependencies
 * 4. Creates a snapshot for future use (including state file)
 */
function handleSetup(env: Env): Response {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: SetupEvent) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  const sendStep = async (message: string) => {
    await sendEvent({ type: 'step', message });
  };

  // Run setup in background, streaming progress
  (async () => {
    const startTime = Date.now();
    const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

    try {
      // Wake container and measure startup time
      await sendStep('Waking container...');
      const wakeStart = Date.now();
      await sandbox.exec('echo ready', { timeout: 120000 });
      const wakeTime = Date.now() - wakeStart;
      await sendStep(`Container ready in ${wakeTime}ms`);

      // Read existing state (may have been restored from snapshot)
      let state = await readSandboxState(sandbox);
      const isFirstEverVisit = state.visitCount === 0;

      // Increment visit count
      state.visitCount++;
      if (isFirstEverVisit) {
        state.firstVisitTime = Date.now();
      }

      await sendStep(`Visit #${state.visitCount} - checking for snapshot...`);

      // Check for existing snapshot
      const existingSnapshot = await env.SNAPSHOTS.head(
        `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
      );

      if (existingSnapshot) {
        // Configure snapshots with auto-restore and content-addressed keys
        await sandbox.configureSnapshots({
          enabled: true,
          volumePath: WORKSPACE,
          maxSnapshots: 5,
          compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
          excludePatterns: [],
          autoRestoreOnWake: true,
          autoSnapshotOnSleep: true,
          useContentAddressedKeys: true // Enable skip-if-restored optimization
        });

        // Configure R2 credentials for auto-snapshot/restore functionality
        await sandbox.configureR2Credentials({
          accountId: env.CF_ACCOUNT_ID,
          bucketName: env.R2_BUCKET_NAME,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          keyPrefix: SNAPSHOT_KEY_PREFIX
        });

        // Check if project directory already exists (auto-restore may have already run)
        const checkResult = await sandbox.exec(
          `test -d ${PROJECT_DIR} && echo "exists"`,
          { timeout: 5000 }
        );
        const alreadyRestored = checkResult.stdout.trim() === 'exists';

        if (alreadyRestored) {
          // Auto-restore already ran when container woke up
          const duration = Date.now() - startTime;
          state.lastRestoreTime = duration;

          // Update state file
          await writeSandboxState(sandbox, state);

          await sendStep(
            'Project directory exists (auto-restored on wake) - skipping manual restore'
          );
          await sendEvent({
            type: 'complete',
            success: true,
            restored: true,
            duration,
            state,
            stats: { filesRestored: 0 }
          });
          await writer.close();
          return;
        }

        // Manual restore needed
        await sendStep('Found existing snapshot, restoring...');
        const downloadUrl = await getDownloadUrl(
          env,
          `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
        );
        const restoreResult = await sandbox.restoreSnapshot(
          downloadUrl,
          'latest'
        );

        if (restoreResult.success) {
          const duration = Date.now() - startTime;

          // Re-read state after restore (snapshot may contain updated state)
          state = await readSandboxState(sandbox);
          state.visitCount++;
          if (state.firstVisitTime === 0) {
            state.firstVisitTime = Date.now();
          }
          state.lastRestoreTime = duration;

          // Update state file
          await writeSandboxState(sandbox, state);

          await sendStep(
            `Restored ${restoreResult.stats.filesRestored} files in ${restoreResult.stats.duration}ms`
          );
          await sendStep('Verified project directory exists');

          await sendEvent({
            type: 'complete',
            success: true,
            restored: true,
            duration,
            state,
            stats: { filesRestored: restoreResult.stats.filesRestored }
          });
          await writer.close();
          return;
        } else {
          await sendStep(
            'Snapshot restore failed, falling back to fresh setup'
          );
        }
      }

      // No snapshot or restore failed - do fresh setup
      await sendStep('No snapshot found, performing fresh setup...');

      // Configure snapshots with content-addressed keys for automatic deduplication
      await sandbox.configureSnapshots({
        enabled: true,
        volumePath: WORKSPACE,
        maxSnapshots: 5,
        compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
        excludePatterns: [],
        autoRestoreOnWake: true,
        autoSnapshotOnSleep: true,
        useContentAddressedKeys: true // Enable skip-if-restored optimization
      });

      // Configure R2 credentials for auto-snapshot/restore functionality
      await sandbox.configureR2Credentials({
        accountId: env.CF_ACCOUNT_ID,
        bucketName: env.R2_BUCKET_NAME,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        keyPrefix: SNAPSHOT_KEY_PREFIX
      });
      await sendStep('Configured snapshot settings');

      // Clone the repository with streaming output
      await sendStep(`Cloning ${REPO_URL}...`);
      const cloneStart = Date.now();

      await sandbox.exec(
        `git clone --progress ${REPO_URL} astro-blog-starter-template`,
        {
          cwd: WORKSPACE,
          timeout: 120000, // 2 minutes
          stream: true,
          onOutput: async (_stream, data) => {
            // Git clone progress goes to stderr, forward non-empty lines
            const lines = data.split('\n').filter((l) => l.trim());
            for (const line of lines) {
              await sendStep(`[git] ${line}`);
            }
          }
        }
      );

      const cloneDuration = Date.now() - cloneStart;
      await sendStep(`Cloned repository in ${cloneDuration}ms`);

      // Install npm dependencies with streaming output
      await sendStep('Installing npm dependencies...');
      const npmStart = Date.now();

      const npmResult = await sandbox.exec('npm install', {
        cwd: PROJECT_DIR,
        timeout: 300000, // 5 minutes
        stream: true,
        onOutput: async (_stream, data) => {
          // Filter to show only significant lines (summaries, warnings, errors)
          const lines = data.split('\n').filter((l) => l.trim());
          for (const line of lines) {
            if (isSignificantNpmLine(line)) {
              await sendStep(`[npm] ${line}`);
            }
          }
        }
      });

      if (!npmResult.success) {
        throw new Error(`npm install failed: ${npmResult.stderr}`);
      }

      const npmDuration = Date.now() - npmStart;
      await sendStep(`Installed dependencies in ${npmDuration}ms`);

      // Update state before creating snapshot
      const totalDuration = Date.now() - startTime;
      state.lastFreshSetupTime = totalDuration;
      state.snapshotCreatedAt = Date.now();

      // Write state file so it's included in the snapshot
      await sendStep('Writing sandbox state...');
      await writeSandboxState(sandbox, state);
      await sendStep('Saved sandbox state');

      // Create snapshot with streaming progress
      const snapshotStart = Date.now();

      const snapshotId = `snapshot-${Date.now()}`;
      const r2Key = `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`;
      await sendStep('Generating upload URL...');
      const uploadUrl = await getUploadUrl(env, r2Key);

      // Use streaming API for real-time progress updates
      let snapshotStats: {
        totalFiles?: number;
        compressedBytes?: number;
      } = {};

      await sendStep('Starting snapshot stream...');
      const snapshotStream = await sandbox.createSnapshotStream(uploadUrl);
      for await (const event of parseSSEStream<SnapshotProgressEvent>(
        snapshotStream
      )) {
        // Forward progress events to the client
        await sendStep(`[${event.phase}] ${event.message}`);

        if (event.type === 'error') {
          throw new Error(`Snapshot creation failed: ${event.error}`);
        }

        // Capture final stats
        if (event.stats) {
          snapshotStats = {
            totalFiles: event.stats.totalFiles ?? snapshotStats.totalFiles,
            compressedBytes:
              event.stats.compressedBytes ?? snapshotStats.compressedBytes
          };
        }
      }

      const snapshotDuration = Date.now() - snapshotStart;
      await sendStep(
        `Created snapshot in ${snapshotDuration}ms (${snapshotStats.totalFiles} files, ${formatBytes(snapshotStats.compressedBytes || 0)})`
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
      await sendStep('Saved snapshot metadata');

      await sendEvent({
        type: 'complete',
        success: true,
        restored: false,
        duration: totalDuration,
        state,
        stats: {
          totalFiles: snapshotStats.totalFiles,
          compressedBytes: snapshotStats.compressedBytes
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendEvent({ type: 'error', message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  });
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

    // Read persistent state
    const state = await readSandboxState(sandbox);

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
      sandboxId: 'volume-snapshot-demo',
      projectDir: PROJECT_DIR,
      filesExist: {
        'package.json': packageJson.stdout.includes('exists'),
        node_modules: nodeModules.stdout.includes('exists'),
        '.git': gitDir.stdout.includes('exists')
      },
      nodeModulesPackageCount:
        parseInt(nodeModulesCount.stdout.trim(), 10) || 0,
      snapshotExists: !!snapshotExists,
      snapshotMetadata: metadata,
      state
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
    // Ensure snapshots are configured with optimizations
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
      excludePatterns: [],
      autoSnapshotOnSleep: false,
      autoRestoreOnWake: false,
      useContentAddressedKeys: true // Enable skip-if-restored optimization
    });

    const r2Key = `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`;
    const uploadUrl = await getUploadUrl(env, r2Key);

    const startTime = Date.now();
    const result = await sandbox.createSnapshot(uploadUrl);
    const duration = Date.now() - startTime;

    // Handle skip-if-restored: null means content unchanged, snapshot skipped
    if (result === null) {
      return Response.json({
        success: true,
        skipped: true,
        reason: 'Content unchanged since last restore',
        duration
      });
    }

    // createSnapshot returns SnapshotMetadata on success, null if skipped, or throws on error
    // If we reach here, we have valid metadata

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
      skipped: false,
      duration,
      stats: {
        fileCount: result.fileCount,
        sizeBytes: result.sizeBytes,
        uncompressedBytes: result.uncompressedBytes
      }
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

    // Configure snapshots with optimizations
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
      excludePatterns: [],
      autoSnapshotOnSleep: false,
      autoRestoreOnWake: false,
      useContentAddressedKeys: true // Tracks cache key for skip-if-restored
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
 * POST /sleep - Force the sandbox to sleep
 * Triggers auto-snapshot if configured, then puts the sandbox to sleep.
 * Next request will wake and restore from snapshot.
 */
async function handleSleep(env: Env): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, 'volume-snapshot-demo');

  try {
    // Update state before sleeping so it's captured in the auto-snapshot
    const state = await readSandboxState(sandbox);
    await writeSandboxState(sandbox, state);

    // Destroy triggers auto-snapshot if configured, then sleeps
    await sandbox.destroy();

    return Response.json({
      success: true,
      message:
        'Sandbox is now sleeping. Next request will wake and restore from snapshot.',
      visitCount: state.visitCount
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

/**
 * Generate the HTML UI
 */
function getHtmlUI(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Volume Snapshot Demo</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 1.5rem; }
    
    /* Header section with sandbox info */
    .header-info { background: #1a1a2a; border: 1px solid #333; border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem; }
    .sandbox-id { font-family: monospace; font-size: 0.9rem; color: #88f; margin-bottom: 0.5rem; }
    .visit-info { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: center; }
    .visit-count { font-size: 1.5rem; font-weight: bold; color: #fff; }
    .visit-meta { font-size: 0.85rem; color: #888; }
    .status-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 0.85rem; font-weight: 500; }
    .status-badge.restored { background: #1a4a1a; color: #6c6; border: 1px solid #2a6a2a; }
    .status-badge.fresh { background: #4a3a1a; color: #ca6; border: 1px solid #6a5a2a; }
    
    /* Timing comparison */
    .timing-compare { display: flex; gap: 1rem; margin-top: 0.75rem; flex-wrap: wrap; }
    .timing-item { font-size: 0.85rem; padding: 0.25rem 0.5rem; background: #222; border-radius: 4px; }
    .timing-item.highlight { background: #1a3a1a; color: #6c6; }
    .timing-speedup { color: #6c6; font-weight: bold; }
    
    .buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    button { padding: 0.5rem 1rem; border: 1px solid #444; background: #222; color: #eee; cursor: pointer; border-radius: 4px; }
    button:hover:not(:disabled) { background: #333; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary { background: #234; border-color: #345; }
    button.primary:hover:not(:disabled) { background: #345; }
    button.warning { border-color: #653; }
    button.warning:hover:not(:disabled) { background: #432; }
    button.danger { border-color: #633; }
    button.danger:hover:not(:disabled) { background: #422; }
    
    .log { background: #1a1a1a; border: 1px solid #333; padding: 1rem; min-height: 150px; max-height: 500px; overflow-y: auto; font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; margin-bottom: 1rem; border-radius: 4px; }
    .log:empty::before { content: "Ready. Click 'Run Setup' to start."; color: #666; }
    
    .timing { font-size: 1.25rem; margin-bottom: 1rem; padding: 0.75rem; background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 4px; }
    .timing.restored { background: #1a3a1a; border-color: #2a5a2a; }
    .timing.fresh { background: #2a2a1a; border-color: #4a4a2a; }
    
    .status { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .status-item { padding: 0.25rem 0.5rem; background: #222; border-radius: 4px; }
    .status-item.ok { color: #6c6; }
    .status-item.missing { color: #c66; }
    
    .hidden { display: none; }
    .error { color: #f66; }
    .success { color: #6c6; }
  </style>
</head>
<body>
  <h1>Volume Snapshot Demo</h1>
  <p class="subtitle">See how snapshots restore container state in seconds instead of minutes</p>
  
  <div id="header-info" class="header-info hidden">
    <div class="sandbox-id">Sandbox: <strong>volume-snapshot-demo</strong></div>
    <div class="visit-info">
      <span class="visit-count" id="visit-count">Visit #1</span>
      <span id="status-badge" class="status-badge"></span>
      <span class="visit-meta" id="first-visit"></span>
    </div>
    <div class="timing-compare" id="timing-compare"></div>
  </div>
  
  <div class="buttons">
    <button id="btn-setup" class="primary">Run Setup</button>
    <button id="btn-sleep" class="warning">Force Sleep</button>
    <button id="btn-status">Check Status</button>
    <button id="btn-build">Run Build</button>
    <button id="btn-reset" class="danger">Reset</button>
  </div>
  
  <div id="timing" class="timing hidden"></div>
  
  <div id="status" class="status hidden"></div>
  
  <div id="log" class="log"></div>

  <script>
    const log = document.getElementById('log');
    const timing = document.getElementById('timing');
    const status = document.getElementById('status');
    const headerInfo = document.getElementById('header-info');
    const visitCountEl = document.getElementById('visit-count');
    const statusBadge = document.getElementById('status-badge');
    const firstVisitEl = document.getElementById('first-visit');
    const timingCompare = document.getElementById('timing-compare');
    const btnSetup = document.getElementById('btn-setup');
    const btnSleep = document.getElementById('btn-sleep');
    const btnStatus = document.getElementById('btn-status');
    const btnBuild = document.getElementById('btn-build');
    const btnReset = document.getElementById('btn-reset');
    
    function clearLog() {
      log.textContent = '';
      timing.classList.add('hidden');
      timing.className = 'timing hidden';
    }
    
    function appendLog(msg, className) {
      const line = document.createElement('div');
      line.textContent = msg;
      if (className) line.className = className;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }
    
    function setButtons(enabled) {
      [btnSetup, btnSleep, btnStatus, btnBuild, btnReset].forEach(b => b.disabled = !enabled);
    }
    
    function formatTime(ms) {
      if (!ms || ms === 0) return '-';
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
    }
    
    function formatDate(timestamp) {
      if (!timestamp) return '';
      return new Date(timestamp).toLocaleString();
    }
    
    function updateHeaderInfo(state, restored) {
      if (!state) return;
      
      headerInfo.classList.remove('hidden');
      visitCountEl.textContent = 'Visit #' + state.visitCount;
      
      if (restored) {
        statusBadge.textContent = 'RESTORED FROM SNAPSHOT';
        statusBadge.className = 'status-badge restored';
      } else {
        statusBadge.textContent = 'FRESH SETUP';
        statusBadge.className = 'status-badge fresh';
      }
      
      if (state.firstVisitTime) {
        firstVisitEl.textContent = 'First visit: ' + formatDate(state.firstVisitTime);
      }
      
      // Build timing comparison
      timingCompare.innerHTML = '';
      
      if (state.lastFreshSetupTime > 0) {
        const freshItem = document.createElement('span');
        freshItem.className = 'timing-item';
        freshItem.textContent = 'Fresh setup: ' + formatTime(state.lastFreshSetupTime);
        timingCompare.appendChild(freshItem);
      }
      
      if (state.lastRestoreTime > 0) {
        const restoreItem = document.createElement('span');
        restoreItem.className = 'timing-item highlight';
        restoreItem.textContent = 'Last restore: ' + formatTime(state.lastRestoreTime);
        timingCompare.appendChild(restoreItem);
        
        // Show speedup if we have both times
        if (state.lastFreshSetupTime > 0) {
          const speedup = (state.lastFreshSetupTime / state.lastRestoreTime).toFixed(1);
          const speedupItem = document.createElement('span');
          speedupItem.className = 'timing-speedup';
          speedupItem.textContent = speedup + 'x faster!';
          timingCompare.appendChild(speedupItem);
        }
      }
      
      if (state.snapshotCreatedAt) {
        const snapItem = document.createElement('span');
        snapItem.className = 'timing-item';
        snapItem.textContent = 'Snapshot: ' + formatDate(state.snapshotCreatedAt);
        timingCompare.appendChild(snapItem);
      }
    }
    
    function runSetup() {
      clearLog();
      setButtons(false);
      appendLog('Starting setup...');
      
      const start = performance.now();
      const eventSource = new EventSource('/setup');
      
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'step') {
          appendLog('> ' + data.message);
        } else if (data.type === 'complete') {
          const clientTime = performance.now() - start;
          appendLog('');
          
          // Update header with state info
          updateHeaderInfo(data.state, data.restored);
          
          if (data.restored) {
            appendLog('Restored from snapshot', 'success');
            timing.textContent = formatTime(clientTime) + ' (restored from snapshot)';
            timing.className = 'timing restored';
          } else {
            appendLog('Fresh setup complete, snapshot created', 'success');
            timing.textContent = formatTime(clientTime) + ' (fresh setup)';
            timing.className = 'timing fresh';
          }
          timing.classList.remove('hidden');
          eventSource.close();
          setButtons(true);
        } else if (data.type === 'error') {
          appendLog('Error: ' + data.message, 'error');
          eventSource.close();
          setButtons(true);
        }
      };
      
      eventSource.onerror = () => {
        appendLog('Connection lost', 'error');
        eventSource.close();
        setButtons(true);
      };
    }
    
    async function forceSleep() {
      if (!confirm('Put sandbox to sleep? This will trigger auto-snapshot. Click "Run Setup" after to see the fast restore.')) return;
      
      clearLog();
      setButtons(false);
      appendLog('Putting sandbox to sleep...');
      
      try {
        const res = await fetch('/sleep', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          appendLog('');
          appendLog('Sandbox is now sleeping', 'success');
          appendLog('');
          appendLog('Click "Run Setup" to wake the sandbox and see it restore from snapshot.');
          appendLog('The visit counter will persist, proving the state was saved.');
        } else {
          appendLog('Sleep failed: ' + data.error, 'error');
        }
      } catch (err) {
        appendLog('Request failed: ' + err.message, 'error');
      }
      setButtons(true);
    }
    
    async function checkStatus() {
      clearLog();
      setButtons(false);
      appendLog('Checking status...');
      
      try {
        const res = await fetch('/status');
        const data = await res.json();
        
        if (data.error) {
          appendLog('Error: ' + data.error, 'error');
        } else {
          // Update header with state info if available
          if (data.state && data.state.visitCount > 0) {
            updateHeaderInfo(data.state, data.state.lastRestoreTime > 0);
          }
          
          status.innerHTML = '';
          const files = data.filesExist || {};
          Object.entries(files).forEach(([name, exists]) => {
            const item = document.createElement('span');
            item.className = 'status-item ' + (exists ? 'ok' : 'missing');
            item.textContent = (exists ? '' : 'x ') + name;
            status.appendChild(item);
          });
          
          if (data.nodeModulesPackageCount > 0) {
            const item = document.createElement('span');
            item.className = 'status-item ok';
            item.textContent = data.nodeModulesPackageCount + ' packages';
            status.appendChild(item);
          }
          
          status.classList.remove('hidden');
          appendLog('');
          appendLog('Sandbox ID: ' + data.sandboxId);
          appendLog('Project dir: ' + data.projectDir);
          appendLog('Snapshot exists: ' + (data.snapshotExists ? 'Yes' : 'No'));
          
          if (data.state && data.state.visitCount > 0) {
            appendLog('');
            appendLog('Persistent State:');
            appendLog('  Visit count: ' + data.state.visitCount);
            if (data.state.firstVisitTime) {
              appendLog('  First visit: ' + formatDate(data.state.firstVisitTime));
            }
            if (data.state.lastFreshSetupTime) {
              appendLog('  Last fresh setup: ' + formatTime(data.state.lastFreshSetupTime));
            }
            if (data.state.lastRestoreTime) {
              appendLog('  Last restore: ' + formatTime(data.state.lastRestoreTime));
            }
          }
        }
      } catch (err) {
        appendLog('Request failed: ' + err.message, 'error');
      }
      setButtons(true);
    }
    
    async function runBuild() {
      clearLog();
      setButtons(false);
      appendLog('Running npm build...');
      
      const start = performance.now();
      try {
        const res = await fetch('/run');
        const data = await res.json();
        const clientTime = performance.now() - start;
        
        if (data.success) {
          appendLog('Build succeeded in ' + formatTime(clientTime), 'success');
          if (data.stdout) {
            appendLog('');
            appendLog('Output:');
            appendLog(data.stdout);
          }
        } else {
          appendLog('Build failed', 'error');
          if (data.stderr) appendLog(data.stderr, 'error');
          if (data.error) appendLog(data.error, 'error');
        }
      } catch (err) {
        appendLog('Request failed: ' + err.message, 'error');
      }
      setButtons(true);
    }
    
    async function resetSnapshot() {
      if (!confirm('Delete snapshot and start fresh? This will:\\n- Delete the snapshot from R2\\n- Run fresh setup (1-3 minutes)\\n- Reset visit counter')) return;
      
      clearLog();
      setButtons(false);
      headerInfo.classList.add('hidden');
      appendLog('Deleting snapshot...');
      
      try {
        const delRes = await fetch('/snapshot', { method: 'DELETE' });
        const delData = await delRes.json();
        
        if (delData.success) {
          appendLog('Snapshot deleted');
          appendLog('');
          appendLog('Running fresh setup...');
          
          const start = performance.now();
          const eventSource = new EventSource('/setup');
          
          eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'step') {
              appendLog('> ' + data.message);
            } else if (data.type === 'complete') {
              const clientTime = performance.now() - start;
              appendLog('');
              appendLog('Fresh setup complete', 'success');
              
              // Update header with new state
              updateHeaderInfo(data.state, false);
              
              timing.textContent = formatTime(clientTime) + ' (fresh setup after reset)';
              timing.className = 'timing fresh';
              timing.classList.remove('hidden');
              eventSource.close();
              setButtons(true);
            } else if (data.type === 'error') {
              appendLog('Error: ' + data.message, 'error');
              eventSource.close();
              setButtons(true);
            }
          };
          
          eventSource.onerror = () => {
            appendLog('Connection lost', 'error');
            eventSource.close();
            setButtons(true);
          };
        } else {
          appendLog('Delete failed: ' + delData.error, 'error');
          setButtons(true);
        }
      } catch (err) {
        appendLog('Request failed: ' + err.message, 'error');
        setButtons(true);
      }
    }
    
    btnSetup.addEventListener('click', runSetup);
    btnSleep.addEventListener('click', forceSleep);
    btnStatus.addEventListener('click', checkStatus);
    btnBuild.addEventListener('click', runBuild);
    btnReset.addEventListener('click', resetSnapshot);
  </script>
</body>
</html>`;
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

      case '/sleep':
        if (request.method === 'POST') return handleSleep(env);
        break;
    }

    // Serve HTML UI
    return new Response(getHtmlUI(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
} satisfies ExportedHandler<Env>;
