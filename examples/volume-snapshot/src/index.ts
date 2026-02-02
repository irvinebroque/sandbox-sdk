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
 * SSE event types for setup streaming
 */
interface SetupStepEvent {
  type: 'step';
  message: string;
}

interface SetupCompleteEvent {
  type: 'complete';
  success: true;
  restored: boolean;
  duration: number;
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

type SetupEvent = SetupStepEvent | SetupCompleteEvent | SetupErrorEvent;

/**
 * GET /setup - Clone repo, install deps, create snapshot (SSE streaming)
 *
 * This endpoint streams progress via Server-Sent Events:
 * 1. Checks if a snapshot exists and restores it if so
 * 2. Otherwise, clones the repo and installs npm dependencies
 * 3. Creates a snapshot for future use
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
      // Check for existing snapshot
      await sendStep('Checking for existing snapshot...');
      const existingSnapshot = await env.SNAPSHOTS.head(
        `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`
      );

      if (existingSnapshot) {
        await sendStep('Found existing snapshot, restoring...');

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
          await sendStep(
            `Restored ${restoreResult.stats.filesRestored} files in ${restoreResult.stats.duration}ms`
          );

          // Verify restoration
          await sandbox.exec(`ls -la ${PROJECT_DIR}`);
          await sendStep('Verified project directory exists');

          await sendEvent({
            type: 'complete',
            success: true,
            restored: true,
            duration: Date.now() - startTime,
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
      await sendStep('Configured snapshot settings');

      // Clone the repository with sparse checkout for just the template we need
      await sendStep(`Cloning ${REPO_URL}...`);
      const cloneStart = Date.now();

      // Use sparse checkout to only get the astro-blog-starter-template directory
      await sandbox.exec(
        `git clone --filter=blob:none --sparse ${REPO_URL} templates-repo`,
        {
          cwd: WORKSPACE,
          timeout: 120000 // 2 minutes
        }
      );

      await sandbox.exec(
        'git sparse-checkout set astro-blog-starter-template',
        {
          cwd: `${WORKSPACE}/templates-repo`
        }
      );

      // Move the template to the workspace root
      await sandbox.exec(`mv templates-repo/${REPO_SUBDIR} ${PROJECT_DIR}`);
      await sandbox.exec('rm -rf templates-repo', { cwd: WORKSPACE });

      const cloneDuration = Date.now() - cloneStart;
      await sendStep(`Cloned repository in ${cloneDuration}ms`);

      // Install npm dependencies
      await sendStep('Installing npm dependencies...');
      const npmStart = Date.now();

      const npmResult = await sandbox.exec('npm install', {
        cwd: PROJECT_DIR,
        timeout: 300000 // 5 minutes
      });

      if (!npmResult.success) {
        throw new Error(`npm install failed: ${npmResult.stderr}`);
      }

      const npmDuration = Date.now() - npmStart;
      await sendStep(`Installed dependencies in ${npmDuration}ms`);

      // Create snapshot with streaming progress
      const snapshotStart = Date.now();

      const snapshotId = `snapshot-${Date.now()}`;
      const r2Key = `${SNAPSHOT_KEY_PREFIX}latest.tar.zst`;
      const uploadUrl = await getUploadUrl(env, r2Key);

      // Use streaming API for real-time progress updates
      let snapshotStats: {
        totalFiles?: number;
        compressedBytes?: number;
      } = {};

      for await (const event of sandbox.createSnapshotStream(uploadUrl)) {
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
        duration: Date.now() - startTime,
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
    // Ensure snapshots are configured with optimizations
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
      excludePatterns: [],
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
      skipped: false,
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

    // Configure snapshots with optimizations
    await sandbox.configureSnapshots({
      enabled: true,
      volumePath: WORKSPACE,
      maxSnapshots: 5,
      compressionLevel: 'fast', // Uses optimized zstd --fast=1 -T4
      excludePatterns: [],
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
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 2rem auto; padding: 0 1rem; background: #111; color: #eee; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 1.5rem; }
    .buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    button { padding: 0.5rem 1rem; border: 1px solid #444; background: #222; color: #eee; cursor: pointer; border-radius: 4px; }
    button:hover:not(:disabled) { background: #333; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.danger { border-color: #633; }
    button.danger:hover:not(:disabled) { background: #422; }
    .log { background: #1a1a1a; border: 1px solid #333; padding: 1rem; min-height: 150px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.875rem; white-space: pre-wrap; margin-bottom: 1rem; }
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
  
  <div class="buttons">
    <button id="btn-setup">Run Setup</button>
    <button id="btn-status">Check Status</button>
    <button id="btn-build">Run Build</button>
    <button id="btn-reset" class="danger">Reset (Delete Snapshot)</button>
  </div>
  
  <div id="timing" class="timing hidden"></div>
  
  <div id="status" class="status hidden"></div>
  
  <div id="log" class="log"></div>

  <script>
    const log = document.getElementById('log');
    const timing = document.getElementById('timing');
    const status = document.getElementById('status');
    const btnSetup = document.getElementById('btn-setup');
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
      [btnSetup, btnStatus, btnBuild, btnReset].forEach(b => b.disabled = !enabled);
    }
    
    function formatTime(ms) {
      return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
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
          appendLog('• ' + data.message);
        } else if (data.type === 'complete') {
          const clientTime = performance.now() - start;
          appendLog('');
          if (data.restored) {
            appendLog('✓ Restored from snapshot', 'success');
            timing.textContent = '⏱ ' + formatTime(clientTime) + ' (restored from snapshot)';
            timing.className = 'timing restored';
          } else {
            appendLog('✓ Fresh setup complete, snapshot created', 'success');
            timing.textContent = '⏱ ' + formatTime(clientTime) + ' (fresh setup)';
            timing.className = 'timing fresh';
          }
          timing.classList.remove('hidden');
          eventSource.close();
          setButtons(true);
        } else if (data.type === 'error') {
          appendLog('✗ ' + data.message, 'error');
          eventSource.close();
          setButtons(true);
        }
      };
      
      eventSource.onerror = () => {
        appendLog('✗ Connection lost', 'error');
        eventSource.close();
        setButtons(true);
      };
    }
    
    async function checkStatus() {
      clearLog();
      setButtons(false);
      appendLog('Checking status...');
      
      try {
        const res = await fetch('/status');
        const data = await res.json();
        
        if (data.error) {
          appendLog('✗ ' + data.error, 'error');
        } else {
          status.innerHTML = '';
          const files = data.filesExist || {};
          Object.entries(files).forEach(([name, exists]) => {
            const item = document.createElement('span');
            item.className = 'status-item ' + (exists ? 'ok' : 'missing');
            item.textContent = (exists ? '✓ ' : '✗ ') + name;
            status.appendChild(item);
          });
          
          if (data.nodeModulesPackageCount > 0) {
            const item = document.createElement('span');
            item.className = 'status-item ok';
            item.textContent = data.nodeModulesPackageCount + ' packages';
            status.appendChild(item);
          }
          
          status.classList.remove('hidden');
          appendLog('Snapshot exists: ' + (data.snapshotExists ? 'Yes' : 'No'));
          appendLog('Project dir: ' + data.projectDir);
        }
      } catch (err) {
        appendLog('✗ Request failed: ' + err.message, 'error');
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
          appendLog('✓ Build succeeded in ' + formatTime(clientTime), 'success');
          if (data.stdout) {
            appendLog('');
            appendLog('Output:');
            appendLog(data.stdout);
          }
        } else {
          appendLog('✗ Build failed', 'error');
          if (data.stderr) appendLog(data.stderr, 'error');
          if (data.error) appendLog(data.error, 'error');
        }
      } catch (err) {
        appendLog('✗ Request failed: ' + err.message, 'error');
      }
      setButtons(true);
    }
    
    async function resetSnapshot() {
      if (!confirm('Delete snapshot and run fresh setup? This will take 1-3 minutes.')) return;
      
      clearLog();
      setButtons(false);
      appendLog('Deleting snapshot...');
      
      try {
        const delRes = await fetch('/snapshot', { method: 'DELETE' });
        const delData = await delRes.json();
        
        if (delData.success) {
          appendLog('✓ Snapshot deleted');
          appendLog('');
          appendLog('Running fresh setup...');
          
          const start = performance.now();
          const eventSource = new EventSource('/setup');
          
          eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'step') {
              appendLog('• ' + data.message);
            } else if (data.type === 'complete') {
              const clientTime = performance.now() - start;
              appendLog('');
              appendLog('✓ Fresh setup complete', 'success');
              timing.textContent = '⏱ ' + formatTime(clientTime) + ' (fresh setup after reset)';
              timing.className = 'timing fresh';
              timing.classList.remove('hidden');
              eventSource.close();
              setButtons(true);
            } else if (data.type === 'error') {
              appendLog('✗ ' + data.message, 'error');
              eventSource.close();
              setButtons(true);
            }
          };
          
          eventSource.onerror = () => {
            appendLog('✗ Connection lost', 'error');
            eventSource.close();
            setButtons(true);
          };
        } else {
          appendLog('✗ Delete failed: ' + delData.error, 'error');
          setButtons(true);
        }
      } catch (err) {
        appendLog('✗ Request failed: ' + err.message, 'error');
        setButtons(true);
      }
    }
    
    btnSetup.addEventListener('click', runSetup);
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
    }

    // Serve HTML UI
    return new Response(getHtmlUI(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
} satisfies ExportedHandler<Env>;
