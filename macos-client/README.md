# OkProxy Client for macOS

A simple SwiftUI wrapper for the okproxy Node.js client.

## State directories

- Dev app (`OkProxy Client-Dev.app`): `~/.okproxy-dev`
- Production app (`OkProxy Client.app`): `~/.okproxy`

The app manages fixed paths inside that state directory:

- Repo: `<state-dir>/repo`
- Node.js: `<state-dir>/node/bin/node`

## Features

- **Setup tab**
  - Setup/update a local Node.js copy from the official latest LTS release index at `https://nodejs.org/dist/index.json`.
  - Clone/update `https://github.com/okbrainhq/okproxy` into the app state directory.
  - Set a branch before cloning/updating; update fetches, checks out, and pulls that branch so the physical repo branch changes.
  - No custom paths are exposed for Node.js or the proxy repo.

- **Connection tab**
  - Configure server `host:port` and local target `host:port`.
  - Pick required mTLS files: client key, client cert, and CA cert.
  - Toggle `--multipath` and `--preserve-host`.
  - Add optional `--domain` values, one per line.
  - Start/stop the client process.

- **Logs tab**
  - Streams setup command output and client stdout/stderr.

## Build and run

```bash
cd macos-client
./scripts/build.sh        # builds OkProxy Client-Dev.app
./scripts/run.sh          # opens dev app
./scripts/build.sh --prod # builds OkProxy Client.app
```

## Client command generated

The app runs:

```bash
node apps/client/index.js \
  --server <host:port> \
  --target <host:port> \
  --key <client-key.pem> \
  --cert <client-cert.pem> \
  --ca <ca-cert.pem>
```

It appends `--multipath`, `--preserve-host`, and repeated `--domain <domain>` options when configured.
