# OkProxy Client for macOS

A simple SwiftUI wrapper for the okproxy Node.js client.

## State directories

- Dev app (`OkProxy Client-Dev.app`): `~/.okproxy-dev`
- Production app (`OkProxy Client.app`): `~/.okproxy`

The app manages fixed paths inside that state directory:

- Repo: `<state-dir>/repo`
- Node.js: `<state-dir>/node/bin/node`
- Logs: `<state-dir>/logs/client.log` with rotation to `client.log.1` ... `client.log.4`

## Features

- **Setup tab**
  - Shows Node.js and repository readiness with warning/OK icons.
  - Shows the currently installed local Node.js version.
  - Setup/update a local Node.js copy from the official latest LTS release index at `https://nodejs.org/dist/index.json`.
  - Clone/update `https://github.com/okbrainhq/okproxy` into the app state directory.
  - Set a branch before cloning/updating; update fetches, checks out, and pulls that branch so the physical repo branch changes.
  - No custom paths are exposed for Node.js or the proxy repo.

- **Connection tab**
  - Configure server `host:port` and local target `host:port`.
  - Pick required mTLS files: client key, client cert, and CA cert.
  - The file chooser shows hidden files and dot-directories for keys stored under paths like `.certs`.
  - Toggle `--multipath`, `--preserve-host`, and **Start Client Automatically**.
  - Add optional `--domain` values, one per line.
  - Start/stop the client process.

- **Logs**
  - A compact live log view is always visible at the bottom of the app.
  - The Logs tab shows the log stream and log file path.
  - Opening the Logs tab jumps to the newest line; scrolling up pauses auto-follow until the user scrolls back to the bottom.
  - The visible log view is capped to the latest 2,000 entries for responsive tab switching and lower RAM usage.
  - Logs are stored locally and reloaded when the app launches later.
  - Logs rotate at about 1 MB, keeping four rotated files.

- **App behavior**
  - Closing the main window keeps the client available from the macOS menu bar.
  - The menu bar item can show the window, start/stop the client, toggle auto-start, and quit.
  - Dev builds use a visibly different orange-accent app icon/menu bar symbol.

## Build and run

```bash
cd macos-client
./scripts/build.sh        # builds OkProxy Client-Dev.app
./scripts/run.sh          # opens dev app
./scripts/build.sh --prod # builds OkProxy Client.app
```

The build script generates bundled `.icns` app icons for dev/prod and self-signs the app.

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
