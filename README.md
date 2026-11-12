# flowplan

flowplan is a tool to plan a feature as a flow of blocks and connections. A person in a browser and an agent on the command line edit the same flow at the same time.

## Start the server

Run this command in the flowplan repo. Set `--root` to the repo that you plan:

```bash
npm start -- --root /path/to/planned-repo
```

With no `--root`, the server uses the current directory, so `npm start` alone keeps the flows of the flowplan repo.

The server prints its address, for example `flowplan server: http://127.0.0.1:52811 (flows in /path/to/planned-repo/.flowplan)`.

To use a fixed port, add `--port`:

```bash
npm start -- --root /path/to/planned-repo --port 4747
```

Stop the server with Ctrl+C. The server writes each pending snapshot before it stops.

## Flow files

- The server keeps each flow in `.flowplan/<flow>.json`. Commit these files.
- At start, the server loads each flow from its file. If a file is not valid, the server logs each error and does not load that flow. A client cannot open that flow until you correct the file and restart the server.
- The server writes a flow's file 500 ms after the last edit. It writes a temporary file and then renames it, so a reader never sees a partly written file.
- Before each write, the server validates the snapshot. If the snapshot is not valid, the server logs the error and keeps the last valid file.

**Caution: while the server runs, do not edit a flow file by hand.** The server does not read the file again. Its next write replaces your edit. Stop the server, edit the file, then start the server again.

## Server security

- The server listens on `127.0.0.1` only.
- The server refuses a request when the `Host` header is not `localhost` or `127.0.0.1` with the server's port.
- The server refuses a websocket when the `Origin` header is present and is not the server's own origin. Add more origins with `--allow-origin`.
- Every websocket client must send the token from `.flowplan/server.json` as the `token` query parameter. This applies to the CLI and to the browser app.
- `.flowplan/server.json` holds the port, the process ID and the token. Only its owner can read it. Git ignores it. The server deletes it when it stops.
- Only one server can run for a directory. When `server.json` names a process that is running, a second server does not start.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run check:release-age
```
