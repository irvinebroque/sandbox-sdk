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
  generatePresignedGetUrl,
  generatePresignedPutUrl,
  getSandbox,
  parseSSEStream,
  type R2CredentialConfig,
  type SnapshotProgressEvent
} from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

/**
 * Wraps a promise with periodic "still waiting" logs every 5 seconds.
 * Helps identify where operations are hanging.
 */
async function withPeriodicLogging<T>(
  promise: Promise<T>,
  operation: string,
  logger: SimpleLogger
): Promise<T> {
  let elapsed = 0;
  const interval = setInterval(() => {
    elapsed += 5;
    logger.warn(`Still waiting for ${operation}... (${elapsed}s elapsed)`);
  }, 5000);

  try {
    return await promise;
  } finally {
    clearInterval(interval);
  }
}

/**
 * Wraps an async generator with periodic "still waiting" logs if no events
 * are received for 5+ seconds. Also tracks total time without events.
 */
async function* withStreamLogging<T>(
  stream: AsyncIterable<T>,
  operation: string,
  logger: SimpleLogger
): AsyncGenerator<T> {
  let lastEventTime = Date.now();
  let warningCount = 0;

  const interval = setInterval(() => {
    const timeSinceLastEvent = Date.now() - lastEventTime;
    if (timeSinceLastEvent >= 5000) {
      warningCount++;
      const totalSeconds = Math.floor(timeSinceLastEvent / 1000);
      logger.warn(
        `No events from ${operation} for ${totalSeconds}s (warning #${warningCount})`
      );

      // Extra warning if it's been a really long time
      if (totalSeconds >= 60 && totalSeconds % 30 === 0) {
        logger.warn(
          `${operation} may be hung - no events for ${totalSeconds}s. Check container logs.`
        );
      }
    }
  }, 5000);

  try {
    for await (const event of stream) {
      lastEventTime = Date.now();
      yield event;
    }
  } finally {
    clearInterval(interval);
    if (warningCount > 0) {
      logger.info(
        `${operation} stream completed after ${warningCount} timeout warnings`
      );
    }
  }
}

/**
 * Simple self-contained logger for dual output (console + SSE)
 * Outputs structured JSON for wrangler tail, plus optional UI streaming
 */
interface SimpleLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(
    message: string,
    error?: Error,
    context?: Record<string, unknown>
  ): void;
}

function createSimpleLogger(
  baseContext: Record<string, unknown>,
  sendToUI?: (level: string, message: string) => void
): SimpleLogger {
  const log = (
    level: string,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ) => {
    // Console output (structured JSON for wrangler tail)
    const logData: Record<string, unknown> = {
      level,
      msg: message,
      ...baseContext,
      ...context,
      timestamp: new Date().toISOString()
    };
    if (error) {
      logData.error = { message: error.message, stack: error.stack };
    }
    console.log(JSON.stringify(logData));

    // UI output if provided
    if (sendToUI) {
      const suffix = formatContextSuffixSimple(context);
      const errorSuffix = error ? `: ${error.message}` : '';
      sendToUI(level, message + errorSuffix + suffix);
    }
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, err, ctx) => log('error', msg, ctx, err)
  };
}

/**
 * Format context fields into a human-readable suffix for UI display
 */
function formatContextSuffixSimple(context?: Record<string, unknown>): string {
  if (!context) return '';

  const parts: string[] = [];
  const displayFields = [
    'duration',
    'visitCount',
    'filesRestored',
    'totalFiles',
    'compressedBytes',
    'repoUrl'
  ];

  for (const field of displayFields) {
    const value = context[field];
    if (value !== undefined) {
      if (field === 'duration') {
        parts.push(`${value}ms`);
      } else if (field === 'compressedBytes') {
        parts.push(formatBytes(value as number));
      } else if (field === 'repoUrl') {
        parts.push(String(value));
      } else {
        parts.push(`${field}: ${value}`);
      }
    }
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

// Repository to clone - Astro blog starter template
const REPO_URL =
  'https://github.com/irvinebroque/astro-blog-starter-template.git';
const SANDBOX_ID = 'volume-snapshot-demo';
const WORKSPACE = '/workspace';
const PROJECT_DIR = `${WORKSPACE}/astro-blog-starter-template`;
const STATE_FILE = `${WORKSPACE}/.sandbox-state.json`;

// Snapshot configuration
const SNAPSHOT_OBJECT_KEY = `snapshots/${SANDBOX_ID}/latest.tar.zst`;
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

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

interface SetupRawEvent {
  type: 'raw';
  data: string;
}

type SetupEvent =
  | SetupStepEvent
  | SetupLogEvent
  | SetupRawEvent
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
  state: SandboxState,
  logger: SimpleLogger
): Promise<void> {
  const json = JSON.stringify(state, null, 2);

  // Phase 1: Health check - verify container is responsive
  logger.info('State write phase 1: checking container health');
  await withPeriodicLogging(
    sandbox.exec('true', { timeout: 5000 }),
    'health check (pre-state-write)',
    logger
  );
  logger.info('State write phase 1: container responsive');

  // Phase 2: Test exec - verify exec works with simple command
  logger.info('State write phase 2: testing exec with simple command');
  const testResult = await withPeriodicLogging(
    sandbox.exec('echo "exec-test-ok"', { timeout: 5000 }),
    'test exec',
    logger
  );
  logger.info('State write phase 2: test exec completed', {
    exitCode: testResult.exitCode,
    stdout: testResult.stdout.trim()
  });

  // Phase 3: Actual state write
  logger.info('State write phase 3: writing state file', {
    path: STATE_FILE,
    jsonSize: json.length
  });
  await withPeriodicLogging(
    sandbox.writeFile(STATE_FILE, `${json}\n`),
    'state file write',
    logger
  );
  logger.info('State write phase 3: state file written successfully');
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
  const startTime = Date.now();

  const sendEvent = (event: SetupEvent) => {
    if (writer.desiredSize !== null && writer.desiredSize <= 0) {
      return;
    }
    void writer
      .write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      .catch(() => {});
  };

  // Create sendToUI function for streaming logs to client
  const sendToUI = (level: string, message: string) => {
    sendEvent({
      type: 'log',
      level: level as 'debug' | 'info' | 'warn' | 'error',
      message,
      timestamp: new Date().toISOString(),
      elapsed: Date.now() - startTime
    });
  };

  // Create logger with dual output (console JSON + SSE to UI)
  const logger = createSimpleLogger(
    {
      component: 'sandbox-do',
      sandboxId: SANDBOX_ID,
      operation: 'setup'
    },
    sendToUI
  );

  // Run setup in background, streaming progress
  (async () => {
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
      debug: true
    });

    try {
      // Wake container and measure startup time
      logger.info('Waking container');
      const wakeStart = Date.now();
      await sandbox.exec('echo ready', { timeout: 120000 });
      const wakeTime = Date.now() - wakeStart;
      logger.info('Container ready', { duration: wakeTime });

      // Read existing state (may have been restored from snapshot)
      let state = await readSandboxState(sandbox);
      const isFirstEverVisit = state.visitCount === 0;

      // Increment visit count
      state.visitCount++;
      if (isFirstEverVisit) {
        state.firstVisitTime = Date.now();
      }

      logger.info('Configuring snapshots...');
      await withPeriodicLogging(
        sandbox.configureSnapshots({
          enabled: true,
          volumePath: WORKSPACE,
          compressionLevel: 'fast',
          excludePatterns: []
        }),
        'configureSnapshots',
        logger
      );
      logger.info('Snapshots configured');

      logger.info('Checking for snapshot metadata', {
        visitCount: state.visitCount
      });
      const metadata = await sandbox.getSnapshotMetadata('latest');

      if (metadata) {
        logger.info('Snapshot metadata found, starting restore', {
          r2Key: metadata.r2Key
        });
        const downloadUrl = await withPeriodicLogging(
          getDownloadUrl(env, metadata.r2Key),
          'generate download URL',
          logger
        );
        logger.info('Download URL generated, restoring snapshot...');
        const restoreResult = await withPeriodicLogging(
          sandbox.restoreSnapshot(downloadUrl, 'latest'),
          'restoreSnapshot',
          logger
        );
        logger.info('Restore operation completed');

        if (restoreResult.success) {
          const duration = Date.now() - startTime;
          state = await readSandboxState(sandbox);
          state.visitCount++;
          if (state.firstVisitTime === 0) {
            state.firstVisitTime = Date.now();
          }
          state.lastRestoreTime = duration;
          state.snapshotCreatedAt = metadata.createdAt;

          await writeSandboxState(sandbox, state, logger);

          logger.info('Snapshot restored', {
            filesRestored: restoreResult.stats.filesRestored,
            duration: restoreResult.stats.duration
          });

          sendEvent({
            type: 'complete',
            success: true,
            restored: true,
            duration,
            state,
            stats: { filesRestored: restoreResult.stats.filesRestored }
          });
          return;
        }

        logger.warn('Snapshot restore failed, falling back to fresh setup');
      }

      // No snapshot or restore failed - do fresh setup
      logger.info('No snapshot found, performing fresh setup');

      // Clone the repository with streaming output
      logger.info('Cloning repository', { repoUrl: REPO_URL });
      const cloneStart = Date.now();

      await sandbox.exec(
        `git clone --progress ${REPO_URL} astro-blog-starter-template`,
        {
          cwd: WORKSPACE,
          timeout: 120000,
          stream: true,
          onOutput: (_stream, data) => {
            // Send raw output to terminal for proper \r handling
            sendEvent({
              type: 'raw' as const,
              data: data
            });
          }
        }
      );

      const cloneDuration = Date.now() - cloneStart;
      logger.info('Repository cloned', { duration: cloneDuration });

      // Install npm dependencies with streaming output
      logger.info('Installing npm dependencies');
      const npmStart = Date.now();

      const npmResult = await withPeriodicLogging(
        sandbox.exec('npm install', {
          cwd: PROJECT_DIR,
          timeout: 300000,
          stream: true,
          onOutput: (_stream, data) => {
            // Send raw output to terminal for proper \r handling
            sendEvent({
              type: 'raw' as const,
              data: data
            });
          }
        }),
        'npm install',
        logger
      );

      if (!npmResult.success) {
        const error = new Error(`npm install failed: ${npmResult.stderr}`);
        logger.error('npm install failed', error);
        throw error;
      }

      const npmDuration = Date.now() - npmStart;
      logger.info('Dependencies installed', { duration: npmDuration });

      // Update state before creating snapshot
      const totalDuration = Date.now() - startTime;
      state.lastFreshSetupTime = totalDuration;
      state.snapshotCreatedAt = Date.now();

      // Write state file so it's included in the snapshot
      logger.info('Starting sandbox state write sequence');
      await writeSandboxState(sandbox, state, logger);
      logger.info('Sandbox state write sequence completed');

      // Create snapshot with streaming progress
      const snapshotStart = Date.now();

      const r2Key = SNAPSHOT_OBJECT_KEY;
      logger.info('Generating upload URL');
      const uploadUrl = await getUploadUrl(env, r2Key);

      // Use streaming API for real-time progress updates (fallback for old containers)
      let snapshotStats: {
        compressedBytes?: number;
      } = {};

      try {
        logger.info('Starting snapshot stream');
        const snapshotStream = await withPeriodicLogging(
          sandbox.createSnapshotStream(uploadUrl),
          'createSnapshotStream',
          logger
        );
        logger.info('Snapshot stream created, processing events...');
        for await (const event of withStreamLogging(
          parseSSEStream<SnapshotProgressEvent>(snapshotStream),
          'snapshot creation',
          logger
        )) {
          // Forward progress events to the client
          logger.info(`[${event.phase}] ${event.message}`);

          if (event.type === 'error') {
            const error = new Error(`Snapshot creation failed: ${event.error}`);
            logger.error('Snapshot creation failed', error);
            throw error;
          }

          // Capture final stats
          if (event.stats) {
            snapshotStats = {
              compressedBytes:
                event.stats.compressedBytes ?? snapshotStats.compressedBytes
            };
          }
        }
      } catch (error) {
        const httpStatus =
          error && typeof error === 'object' && 'httpStatus' in error
            ? (error as { httpStatus?: number }).httpStatus
            : undefined;
        if (httpStatus === 404) {
          logger.warn(
            'Snapshot streaming endpoint not found. Falling back to non-streaming createSnapshot.'
          );
          const metadata = await withPeriodicLogging(
            sandbox.createSnapshot(uploadUrl),
            'createSnapshot',
            logger
          );
          snapshotStats = {
            compressedBytes: metadata.sizeBytes
          };
        } else {
          throw error;
        }
      }

      const snapshotDuration = Date.now() - snapshotStart;
      logger.info('Snapshot created', {
        duration: snapshotDuration,
        compressedBytes: snapshotStats.compressedBytes
      });

      sendEvent({
        type: 'complete',
        success: true,
        restored: false,
        duration: totalDuration,
        state,
        stats: {
          compressedBytes: snapshotStats.compressedBytes
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Setup failed', error instanceof Error ? error : undefined);
      sendEvent({ type: 'error', message });
    } finally {
      try {
        await writer.close();
      } catch {
        // Ignore double-close errors
      }
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
  const startTime = Date.now();
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'status'
  });

  logger.info('Checking status');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    // Check for key files
    logger.info('Checking file existence');
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
    logger.info('Reading sandbox state');
    const state = await readSandboxState(sandbox);

    const metadata = await sandbox.getSnapshotMetadata('latest');

    const duration = Date.now() - startTime;
    logger.info('Status check complete', { duration });

    return Response.json({
      sandboxId: SANDBOX_ID,
      projectDir: PROJECT_DIR,
      filesExist: {
        'package.json': packageJson.stdout.includes('exists'),
        node_modules: nodeModules.stdout.includes('exists'),
        '.git': gitDir.stdout.includes('exists')
      },
      nodeModulesPackageCount:
        parseInt(nodeModulesCount.stdout.trim(), 10) || 0,
      snapshotExists: metadata != null,
      snapshotMetadata: metadata,
      state
    });
  } catch (error) {
    logger.error(
      'Status check failed',
      error instanceof Error ? error : undefined
    );
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/version - Get container version (if supported by the image)
 */
async function handleApiVersion(env: Env): Promise<Response> {
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'version'
  });
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    const version = await sandbox.client.utils.getVersion();
    return new Response(JSON.stringify({ version }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      'Version check failed',
      error instanceof Error ? error : undefined
    );
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * POST /snapshot - Manually create a new snapshot
 */
async function handleCreateSnapshot(env: Env): Promise<Response> {
  const startTime = Date.now();
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'create-snapshot'
  });

  logger.info('Creating snapshot manually');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    logger.info('Configuring snapshots...');
    await withPeriodicLogging(
      sandbox.configureSnapshots({
        enabled: true,
        volumePath: WORKSPACE,
        compressionLevel: 'fast',
        excludePatterns: []
      }),
      'configureSnapshots',
      logger
    );
    logger.info('Snapshots configured');

    const r2Key = SNAPSHOT_OBJECT_KEY;
    logger.info('Generating upload URL...');
    const uploadUrl = await withPeriodicLogging(
      getUploadUrl(env, r2Key),
      'generate upload URL',
      logger
    );
    logger.info('Upload URL generated');

    const createStart = Date.now();
    logger.info('Creating snapshot (non-streaming)...');
    const metadata = await withPeriodicLogging(
      sandbox.createSnapshot(uploadUrl),
      'createSnapshot',
      logger
    );
    const duration = Date.now() - createStart;
    logger.info('Snapshot creation completed');

    const totalDuration = Date.now() - startTime;
    logger.info('Snapshot created', { duration: totalDuration });

    return Response.json({
      success: true,
      duration,
      stats: {
        fileCount: metadata.fileCount,
        sizeBytes: metadata.sizeBytes
      }
    });
  } catch (error) {
    logger.error(
      'Snapshot creation failed',
      error instanceof Error ? error : undefined
    );
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * POST /restore - Manually restore from snapshot
 */
async function handleRestore(env: Env): Promise<Response> {
  const startTime = Date.now();
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'restore'
  });

  logger.info('Restoring snapshot manually');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    // Check if snapshot metadata exists
    logger.info('Checking snapshot metadata');
    const metadata = await sandbox.getSnapshotMetadata('latest');
    if (!metadata) {
      logger.warn('No snapshot found');
      return Response.json(
        { success: false, error: 'No snapshot found. Run /setup first.' },
        { status: 404 }
      );
    }

    // Configure snapshots
    logger.info('Configuring snapshots...');
    await withPeriodicLogging(
      sandbox.configureSnapshots({
        enabled: true,
        volumePath: WORKSPACE,
        compressionLevel: 'fast',
        excludePatterns: []
      }),
      'configureSnapshots',
      logger
    );
    logger.info('Snapshots configured');

    logger.info('Generating download URL...');
    const downloadUrl = await withPeriodicLogging(
      getDownloadUrl(env, metadata.r2Key),
      'generate download URL',
      logger
    );
    logger.info('Download URL generated');

    const restoreStart = Date.now();
    logger.info('Restoring snapshot...');
    const result = await withPeriodicLogging(
      sandbox.restoreSnapshot(downloadUrl, 'latest'),
      'restoreSnapshot',
      logger
    );
    const duration = Date.now() - restoreStart;
    logger.info('Restore completed');

    if (!result.success) {
      const error = new Error('Restore failed');
      logger.error('Restore failed', error);
      throw error;
    }

    const totalDuration = Date.now() - startTime;
    logger.info('Snapshot restored', {
      duration: totalDuration,
      filesRestored: result.stats.filesRestored
    });

    return Response.json({
      success: true,
      duration,
      stats: result.stats
    });
  } catch (error) {
    logger.error('Restore failed', error instanceof Error ? error : undefined);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /snapshot - Delete the snapshot and reset sandbox state
 */
async function handleDeleteSnapshot(env: Env): Promise<Response> {
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'delete-snapshot'
  });

  logger.info('Deleting snapshot and resetting sandbox state');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    // 1. Destroy the container first to ensure a clean slate
    logger.info('Destroying sandbox container');
    await sandbox.destroy();

    // 2. Disable snapshots for the next run
    logger.info('Disabling snapshot configuration');
    await sandbox.configureSnapshots({
      enabled: false,
      volumePath: WORKSPACE,
      compressionLevel: 'fast',
      excludePatterns: []
    });

    // 3. Delete snapshot metadata from DO storage
    logger.info('Deleting snapshot metadata');
    const metadata = await sandbox.getSnapshotMetadata('latest');
    if (metadata) {
      await sandbox.deleteSnapshotMetadata('latest');
      logger.info('Deleted snapshot metadata');
    } else {
      logger.info('No snapshot metadata found');
    }

    // 4. Delete R2 files
    logger.info('Deleting R2 files');
    await env.SNAPSHOTS.delete(SNAPSHOT_OBJECT_KEY);

    logger.info('Snapshot and sandbox state reset complete');
    return Response.json({
      success: true,
      message: 'Snapshot deleted and sandbox reset',
      deletedMetadata: metadata ? 1 : 0
    });
  } catch (error) {
    logger.error(
      'Snapshot deletion failed',
      error instanceof Error ? error : undefined
    );
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * GET /run - Run npm command to verify the project works
 */
async function handleRun(env: Env): Promise<Response> {
  const startTime = Date.now();
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'run'
  });

  logger.info('Running npm build');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    // Run a quick npm command to verify everything works
    const result = await sandbox.exec('npm run build', {
      cwd: PROJECT_DIR,
      timeout: 120000
    });

    const duration = Date.now() - startTime;
    if (result.success) {
      logger.info('Build completed', { duration });
    } else {
      logger.warn('Build failed', { duration, exitCode: result.exitCode });
    }

    return Response.json({
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration: result.duration
    });
  } catch (error) {
    logger.error('Build failed', error instanceof Error ? error : undefined);
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * POST /sleep - Force the sandbox to sleep
 * Next request will need to restore from snapshot manually.
 */
async function handleSleep(env: Env): Promise<Response> {
  const logger = createSimpleLogger({
    component: 'sandbox-do',
    sandboxId: SANDBOX_ID,
    operation: 'sleep'
  });

  logger.info('Putting sandbox to sleep');
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, {
    debug: true
  });

  try {
    logger.info('Reading state');
    const state = await readSandboxState(sandbox);

    // Destroy container to force sleep
    logger.info('Destroying sandbox');
    await sandbox.destroy();

    logger.info('Sandbox sleeping', { visitCount: state.visitCount });
    return Response.json({
      success: true,
      message:
        'Sandbox is now sleeping. Next request can restore the snapshot.',
      visitCount: state.visitCount
    });
  } catch (error) {
    logger.error('Sleep failed', error instanceof Error ? error : undefined);
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
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
    
    .terminal-container { 
      height: 400px; 
      border: 1px solid #333; 
      border-radius: 4px; 
      margin-bottom: 1rem;
      overflow: hidden;
    }
    
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
    <div class="sandbox-id">Sandbox: <strong>${SANDBOX_ID}</strong></div>
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
  
  <div id="terminal-container" class="terminal-container"></div>

  <script>
    // Initialize xterm.js terminal
    const term = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#eee',
        cursor: '#eee',
        green: '#6c6',
        yellow: '#ca6',
        red: '#f66',
        brightBlack: '#888'
      },
      fontSize: 14,
      fontFamily: 'monospace',
      cursorBlink: false,
      disableStdin: true,
      convertEol: true
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    window.addEventListener('resize', () => fitAddon.fit());
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
      term.clear();
      timing.classList.add('hidden');
      timing.className = 'timing hidden';
    }
    
    function appendLog(msg, className) {
      if (className === 'error') {
        term.writeln('\\x1b[31m' + msg + '\\x1b[0m');
      } else if (className === 'success') {
        term.writeln('\\x1b[32m' + msg + '\\x1b[0m');
      } else {
        term.writeln(msg);
      }
    }
    
    function writeRaw(data) {
      term.write(data);
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
    
    function appendLogEvent(level, message, elapsed, timestamp) {
      const elapsedSec = (elapsed / 1000).toFixed(1);
      const time = new Date(timestamp).toLocaleTimeString('en-US', { 
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' 
      });
      
      const colors = {
        debug: '\\x1b[90m',
        info: '\\x1b[32m',
        warn: '\\x1b[33m',
        error: '\\x1b[31m'
      };
      const reset = '\\x1b[0m';
      const color = colors[level] || '';
      
      term.writeln(
        '\\x1b[90m+' + elapsedSec + 's ' + time + reset + ' ' + color + '[' + level.toUpperCase() + ']' + reset + ' ' + message
      );
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
      let setupCompleted = false;
      
      const start = performance.now();
      const eventSource = new EventSource('/setup');
      
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'raw') {
          writeRaw(data.data);
        } else if (data.type === 'log') {
          appendLogEvent(data.level, data.message, data.elapsed, data.timestamp);
        } else if (data.type === 'step') {
          // Legacy support for 'step' events
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
        setupCompleted = true;
        eventSource.close();
        setButtons(true);
      } else if (data.type === 'error') {
        appendLog('Error: ' + data.message, 'error');
        eventSource.close();
        setButtons(true);
      }
    };
    
    eventSource.onerror = () => {
      if (setupCompleted) return;
      appendLog('Connection lost', 'error');
      eventSource.close();
      setButtons(true);
    };
  }
    
    async function forceSleep() {
      if (!confirm('Put sandbox to sleep? Click "Run Setup" after to restore from the snapshot.')) return;
      
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
            
            if (data.type === 'raw') {
              writeRaw(data.data);
            } else if (data.type === 'log') {
              appendLogEvent(data.level, data.message, data.elapsed, data.timestamp);
            } else if (data.type === 'step') {
              // Legacy support for 'step' events
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

      case '/api/version':
        if (request.method === 'GET') return handleApiVersion(env);
        break;
    }

    // Serve HTML UI
    return new Response(getHtmlUI(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
} satisfies ExportedHandler<Env>;
