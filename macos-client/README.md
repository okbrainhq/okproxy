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
  - Start/stop the client process, with an always-available **Force Stop** and a
    **Clean Up Leftover Processes** action for supervisors stranded by an earlier
    run.

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
`run.sh` uses plain `open` (not `open -n`) so an already-running copy is
activated instead of duplicated; the app additionally holds an exclusive
`flock` on `<state-dir>/app.lock`, so a second copy exits and activates the
first rather than sharing config/logs.

## Robustness notes

- **Robustness notes**

- `ProcessSupervisor` owns a persistent direct-child `OkProxyProcessHelper`.
  The helper retains its workload leader unreaped through final descendant group
  signaling. Swift signaling/reaping share a synchronous lock, and **every child
  reaches exactly one terminal outcome**: a confirmed exit, a lost `waitpid`, an
  externally killed helper and a forced reclaim are all reported, so no operation
  gate can be retained indefinitely.
- Stopping is bounded at every rung: graceful group `SIGTERM` (helper), the
  helper's force control, then a reclaim that signals the workload group
  recorded by the helper and `SIGKILL`s the helper itself. A result that could
  not be verified is reported as `cleanupIncomplete`/`forcedUnconfirmed` instead
  of silently blocking the app.
- **Force Stop** (menu bar and Connection tab) and **Clean Up Leftover
  Processes** are always available. The helper records the workload's process
  group under `<state-dir>/run/`, so a stranded or frozen supervisor can still
  be reclaimed after a crash, a force quit or an external kill. Startup reclaims
  leftovers from earlier launches before autostart. No PID is ever signalled
  before its identity (uid, executable name, process group, start time) is
  verified, so PID reuse cannot cause a stray kill.
- Log output is decoded incrementally (UTF-8 scalars split across reads), the
  output buffer, in-memory history and per-write payloads are bounded with
  explicit overflow markers, at most one delivery is in flight, and all log file
  I/O runs off the main thread. Pipe chunks use synchronous bounded append, not
  an unbounded queue of captured-string closures.
- Node.js installs verify the official `SHASUMS256.txt` checksum (fails closed),
  validate the staged binary before swapping, keep the previous install until the
  activated copy validates, and recover an interrupted transaction on the next
  startup before probes/autostart, using persistent transaction phases.
- Setup and start/stop transactions share one exclusion gate, so repo/Node work
  cannot race a running client and nothing new starts while the app is quitting.
- Server/target accept `host:port` and bracketed IPv6 (`[::1]:9443`); update
  checks compare full semantic versions (major/minor/patch).

See `../docs/macos-fixes.md` for details, limitations and Mac validation steps.

## Tests

```bash
python3 ./tests/critical-invariants.py # Linux: production C helper + offline installer fixtures
./tests/macos-robustness-checks.sh   # source checks, plist XML, bash -n, embedded scripts
./tests/macos-behavior-checks.sh     # executes the install script + build lock against fixtures
./tests/macos-stop-guarantees.sh     # macOS: helper exit/cleanup guarantees + reclaim path (skips elsewhere)
python3 ./tests/reviewer3-swift-checks.py # extracted Swift regressions; skips without swiftc
./scripts/test.sh                    # Swift build + focused regressions (requires macOS/Swift)
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
