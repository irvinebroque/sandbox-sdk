# Volume Snapshot Example

This example demonstrates how to use **volume snapshots** to persist container state across sandbox restarts. It shows:

1. **Cloning a git repository** into the sandbox
2. **Installing npm dependencies** (`node_modules`)
3. **Creating a snapshot** of the workspace
4. **Restoring from the snapshot** on subsequent sandbox starts
5. **Tracking persistent state** that proves restoration works (visit counter, timing)
6. **Force sleep** to trigger snapshot and test restoration

## Why Use Volume Snapshots?

Without snapshots, every time your sandbox restarts (due to inactivity timeout, deployment, etc.), you lose all container state. This means:

- Re-cloning repositories (~10-30 seconds)
- Re-installing dependencies (~30-120 seconds)

With snapshots:

- First run: Clone + install (~1-3 minutes)
- Subsequent runs: Restore from snapshot (~10-30 seconds)

The snapshot includes everything in `/workspace`, so your git repo, node_modules, and any other files are instantly available.

## Demo Features

### Visit Counter (Proves Persistence)

The demo tracks a visit counter in `/workspace/.sandbox-state.json`. Each time you click "Run Setup", the counter increments. When you Force Sleep and wake the sandbox, the counter persists - proving the snapshot/restore cycle preserved your state.

### Timing Comparison

The UI shows:

- **Fresh setup time**: How long the initial clone + npm install took
- **Last restore time**: How fast the snapshot restored
- **Speedup**: The multiplier showing how much faster restore is (typically 5-10x)

### Force Sleep Button

Click "Force Sleep" to:

1. Trigger an auto-snapshot (saves current state to R2)
2. Put the sandbox to sleep

Then click "Run Setup" to wake it and see the fast restore in action.

## Prerequisites

1. **Cloudflare account** with R2 enabled
2. **R2 bucket** for storing snapshots
3. **R2 API credentials** for generating presigned URLs

## Setup

### 1. Create an R2 Bucket

```bash
npx wrangler r2 bucket create sandbox-snapshots
```

### 2. Create R2 API Credentials

1. Go to [R2 API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens)
2. Click **Create API Token**
3. Select **Object Read & Write** permission
4. Choose your bucket or allow access to all buckets
5. Click **Create API Token**
6. Copy the **Access Key ID** and **Secret Access Key** (only shown once!)

> **Note**: These are S3-compatible credentials, not regular Cloudflare API tokens. You need both the Access Key ID and Secret Access Key for presigned URLs to work.

### 3. Configure Environment Variables

Copy the example file and fill in your credentials:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```bash
CF_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET_NAME=sandbox-snapshots
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
```

> **Note**: Get your Account ID from the Cloudflare Dashboard URL or R2 settings page.

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the Example

```bash
npm run dev
```

## Usage

### First Run (Fresh Setup)

Visit `http://localhost:8787/setup`

This will:

1. Clone the [Astro Blog Starter Template](https://github.com/irvinebroque/astro-blog-starter-template)
2. Install npm dependencies
3. Create a snapshot of the workspace

**Expected time**: 1-3 minutes

### Subsequent Runs (Snapshot Restore)

After the sandbox sleeps (default 10 minutes of inactivity) or restarts:

Visit `http://localhost:8787/setup` again

This will:

1. Detect existing snapshot
2. Restore from snapshot

**Expected time**: 10-30 seconds

### Check Status

Visit `http://localhost:8787/status`

Returns whether key files exist:

- `package.json`
- `node_modules/`
- `.git/`

### Verify Build Works

Visit `http://localhost:8787/run`

Runs `npm run build` to verify the project is fully functional.

## API Endpoints

| Endpoint    | Method | Description                                        |
| ----------- | ------ | -------------------------------------------------- |
| `/`         | GET    | Show the interactive UI                            |
| `/setup`    | GET    | Clone repo + install deps OR restore from snapshot |
| `/status`   | GET    | Check file status and persistent state             |
| `/sleep`    | POST   | Force sandbox to sleep (triggers auto-snapshot)    |
| `/snapshot` | POST   | Manually create a new snapshot                     |
| `/snapshot` | DELETE | Delete the snapshot (for reset)                    |
| `/restore`  | POST   | Manually restore from snapshot                     |
| `/run`      | GET    | Run `npm build` to verify project                  |

## How It Works

### Snapshot Creation

1. Worker generates a **presigned URL** for R2 upload
2. Container archives `/workspace` using **tar + zstd compression**
3. Container streams archive directly to R2 (efficient, doesn't go through Worker)
4. Worker stores metadata for tracking

### Snapshot Restoration

1. Worker generates a **presigned URL** for R2 download
2. Container downloads archive directly from R2
3. Container extracts archive to `/workspace`
4. All files (git repo, node_modules, etc.) are restored

### Auto Snapshot/Restore

When configured with `autoSnapshotOnSleep: true` and `autoRestoreOnWake: true`:

- Snapshot is automatically created when sandbox goes to sleep
- Snapshot is automatically restored when sandbox wakes up

## Configuration

The example uses these snapshot settings:

```typescript
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  maxSnapshots: 5,
  compressionLevel: 'balanced',
  excludePatterns: [],
  autoRestoreOnWake: true,
  autoSnapshotOnSleep: true
});
```

## Deploying to Production

1. Set secrets for production:

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put R2_BUCKET_NAME
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

2. Deploy:

```bash
npm run deploy
```

## Troubleshooting

### "Missing R2 credentials" error

Ensure all environment variables are set in `.dev.vars` (local) or as secrets (production).

### Snapshot restore fails

1. Check if snapshot exists: `GET /status`
2. Delete and recreate: `DELETE /snapshot`, then `GET /setup`

### Container takes too long to start

First container start after deployment can take 1-2 minutes for provisioning. Subsequent starts are faster.

## Learn More

- [Sandbox SDK Documentation](https://developers.cloudflare.com/sandbox/)
- [R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
