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
- Each edit records its origin, `ui` or `agent`, in an edit-origin map in the live document. The map holds at most one key for each connected client: when a client disconnects, the server removes its key. Each removed key leaves a small record in memory until the server restarts.

**Caution: while the server runs, do not edit a flow file by hand.** The server does not read the file again. Its next write replaces your edit. Stop the server, edit the file, then start the server again.

## Server security

- The server listens on `127.0.0.1` only.
- The server refuses a request when the `Host` header is not `localhost` or `127.0.0.1` with the server's port.
- The server refuses a websocket when the `Origin` header is present and is not the server's own origin. Add more origins with `--allow-origin`.
- Every websocket client must send the token from `.flowplan/server.json` as the `token` query parameter. This applies to the CLI and to the browser app.
- `.flowplan/server.json` holds the port, the process ID and the token. Only its owner can read it. The server deletes it when it stops.
- At start, the server makes sure that `.flowplan/.gitignore` lists `server.json`, `*.tmp`, `server.log` and `server.lock`. It adds a missing line and keeps every other line. Git then ignores the token file and temporary files in the repo that you plan. If `.flowplan/.gitignore` is a symlink or is not a regular file, the server does not start.
- Only one server can run for a directory. When `server.json` names a process that is running, a second server does not start.

## Agent guide

An agent reads, edits and watches a flow with the `flowplan` command. The command connects to the server as a live client, so the user sees each edit at once.

### Run the command

Run the command from the root of the repo that you plan. Replace `<flowplan>` with the path of the flowplan repo:

```bash
node <flowplan>/packages/cli/bin/flowplan.ts show
```

To type `flowplan` instead, add a shell alias, for example `alias flowplan="node <flowplan>/packages/cli/bin/flowplan.ts"`. The examples below use `flowplan`.

- `--root <dir>` sets the planned repo. Default: the current directory.
- `--flow <name>` sets the flow. Default: `main`.
- `flowplan <command> --help` prints the options of each command.
- Exit codes: 0 for success, 1 when the command fails or refuses an edit, 2 for a usage error. Each error goes to stderr.

### Read a flow

```bash
flowplan show              # outline of the main flow: ID, level, title, source and connections
flowplan show billing      # outline of the flow 'billing'
flowplan focus             # the canvas path and the blocks that the user selected
flowplan validate plan.json  # check a snapshot file; needs no server
```

`flowplan show` reads the live flow when the server runs, and the snapshot file when it does not. `flowplan focus` starts no server.

### Edit a flow

Each edit command starts the server when it is not running. If the server cannot start, the command exits with code 1 and changes nothing.

```bash
flowplan add-block --level service --parent b_root --title "Mailer" --pseudocode "queue the mail"
flowplan set b_api title "API gateway"
flowplan set b_api pseudocode --stdin < pseudocode.txt
flowplan set b_api parentId null
flowplan set b_api position 120,40
flowplan connect b_api b_store --label "user id"
flowplan delete c_api_store
flowplan import draft.json
```

- `flowplan add-block` and `flowplan connect` print only the new ID.
- `flowplan set` takes a block field (`title`, `pseudocode`, `level`, `parentId`, `position`, `source`, `meta`) or a connection field (`label`, `from`, `to`). Put `--` before a value that starts with `-`.
- `flowplan delete` on a block also deletes its child canvas and every connection to those blocks.
- `flowplan import` adds a whole draft in one edit, so the user sees all of it at once. The file must be a valid snapshot on its own, and no ID in it may already be in the flow. Import never changes or deletes a block that exists.
- The command refuses an edit that breaks a rule, for example a parent cycle or a function block as a parent.
- The command refuses an edit whose update is over the server's message limit of 16 MiB, before it sends anything. Split a large import into smaller files.
- An edit command exits with code 0 only after the server closed the connection cleanly, so the server has applied the edit. If the server refuses the edit or stops during the command, the command exits with code 1 and prints the reason.

### Watch the user

```bash
flowplan watch
```

`flowplan watch` prints one JSON object on each line of stdout until you stop it. Notices go to stderr.

- An `edit` event lists the blocks and connections that changed, with each item after the change.
- A `focus` event gives the user's canvas path and selected blocks, with titles.
- Each event has an `origin`: `ui` for the user, `agent` for an agent, `server` for a repair that the server made, or `mixed`.
- Each event also has the flow name and the time (`at`).
- Skip the events whose `origin` is `agent` to see only the user's edits.
- `flowplan watch` exits with code 1 when the connection to the server closes, for example when the server stops.

Example events:

```json
{"type":"edit","origin":"ui","changes":[{"kind":"block","id":"b_api","action":"update","fields":["title"],"item":{"id":"b_api","level":"service","parentId":"b_root","title":"API gateway","pseudocode":"","position":{"x":0,"y":0}}}],"flow":"main","at":"2026-01-01T00:00:00.000Z"}
{"type":"focus","origin":"ui","client":123,"canvas":[{"id":"b_root","title":"Auth"}],"selected":[{"id":"b_api","title":"API gateway"}],"flow":"main","at":"2026-01-01T00:00:00.000Z"}
```

A server that an edit command started keeps running after the command ends. Stop it with `kill <pid>`; `.flowplan/server.json` holds the pid.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run check:release-age
```
