# Volume Snapshot Example

This example demonstrates a **simple snapshot flow** that persists `/workspace` in R2 and restores it on demand.

## What it shows

1. Clone a repo into `/workspace`
2. Run `npm install`
3. Create a snapshot at `snapshots/<sandboxId>/latest.tar.zst`
4. Restore from that snapshot on subsequent runs

## Setup

### 1. Create an R2 bucket

```bash
npx wrangler r2 bucket create sandbox-snapshots
```

### 2. Create R2 API credentials

1. Go to [R2 API Tokens](https://dash.cloudflare.com/?to=/:account/r2/api-tokens)
2. Create a token with **Object Read & Write**
3. Copy the Access Key ID + Secret Access Key

### 3. Configure environment variables

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```
CF_ACCOUNT_ID=your-cloudflare-account-id
R2_BUCKET_NAME=sandbox-snapshots
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
```

### 4. Install dependencies

```bash
npm install
```

### 5. Run the example

```bash
npm run dev
```

## Usage

### First run (fresh setup)

Visit `http://localhost:8787/setup`.

This will:

1. Clone the repo
2. Run `npm install`
3. Create a snapshot in R2

### Subsequent runs (restore)

After calling `/sleep` (or any restart), visit `/setup` again.

The Worker will:

1. Detect snapshot metadata
2. Restore from R2 via presigned URL

### Check status

Visit `http://localhost:8787/status` to verify:

- `package.json`
- `node_modules/`
- `.git/`

### Manual snapshot / restore

- `POST /snapshot` creates a new snapshot
- `POST /restore` restores from the snapshot

## Snapshot configuration

The example uses:

```ts
await sandbox.configureSnapshots({
  enabled: true,
  volumePath: '/workspace',
  compressionLevel: 'fast',
  excludePatterns: []
});
```

## Endpoints

| Endpoint    | Method | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `/`         | GET    | Interactive UI                               |
| `/setup`    | GET    | Restore if snapshot exists, else fresh setup |
| `/status`   | GET    | Check file status and snapshot metadata      |
| `/sleep`    | POST   | Force sandbox to sleep                       |
| `/snapshot` | POST   | Create a snapshot                            |
| `/snapshot` | DELETE | Delete snapshot metadata + R2 object         |
| `/restore`  | POST   | Restore from snapshot                        |
| `/run`      | GET    | Run `npm build` to verify the project        |

## Notes

- Presigned URLs must use the `*.r2.cloudflarestorage.com` domain.
- The snapshot key is fixed to `snapshots/<sandboxId>/latest.tar.zst`.
