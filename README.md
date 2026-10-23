# TizenBrew runtime identity

A TizenBrew application module with a runtime identity report, a fixed identity check, an optional owner-account shell console, and explicit paired PC access.

Status: user photographs establish the runtime report, identity check, persistent shell, and permission-check output as owner (UID 5001, GID 100). Version 0.4.0 adds paired PC access. Its on-TV pairing and PC-driven shell execution remain separate runtime outcomes until recorded explicitly.

## PC access and logging (0.4.0)

Keep the TV's Developer Mode Host PC IP at `127.0.0.1`, as required by TizenBrew's documented setup. That field is separate from the TV's LAN address. On the inspected TV, the SDB TCP port accepted connections but SDB could not establish a device session in this configuration, so no forward was created. The bundled TizenBrew service is also bound to TV loopback and supplies no existing PC shell proxy.

The optional PC link reuses the existing shell protocol. After an explicit Pair PC action on the TV, the module makes outbound requests to one entered private IPv4 address on port 18766. It opens no TV LAN listener. Pairing never starts a shell or submits a command. The PC broker exposes the same shell protocol locally on `127.0.0.1:18765`; the PC-only controller records command intents, receipts, lifecycle changes, decoded output snapshots, and dropped-output evidence in JSONL.

The PC tools require Node.js 24 or newer and use only its built-in modules. Start the broker from this repository, substituting the actual PC and TV LAN addresses:

```powershell
node tools/pc-link.mjs --pc-ip 192.168.1.245 --tv-ip 192.168.1.208
```

The broker displays an eight-digit pairing code valid for five minutes. It binds port 18766 only to the specified PC address, accepts pairing/jobs/results only from the specified TV address, and locks pairing after five incorrect codes. If Windows Firewall blocks the connection, any allowance should be limited to that PC port and TV address. No firewall rule is created by these tools.

Update the module on the TV to 0.4.0 and restart its owning TizenBrew service so the newly published service source is actually loaded. In Runtime Identity, enter the PC's address and the displayed code, then choose Pair PC. The connected session uses an in-memory random capability and expires within fifteen minutes; after expiry, restart the broker and pair explicitly again. Disconnect PC cancels the relay but does not stop an existing shell. Closing the PC tools also leaves the shell under its existing idle/lifetime limits.

This is a temporary private-LAN HTTP debugging connection. Traffic is not encrypted. Pair only on a trusted network: a paired PC can run commands with the application's permissions. Capability tokens are omitted from broker/controller logs; command text and captured output are intentionally recorded.

From a second PC terminal in this repository:

```powershell
node tools/pc-shell.mjs status
node tools/pc-shell.mjs start
node tools/pc-shell.mjs send "id"
node tools/pc-shell.mjs status
node tools/pc-shell.mjs watch
node tools/pc-shell.mjs stop
```

These are separately requested actions, not an automatic startup sequence. `start` attaches to an already-running shell rather than replacing it. `send` acknowledges pipe submission; it does not prove command completion. `watch` reads output until Ctrl+C and never sends input. Logs default to `pc-shell-logs/session.jsonl`; use `--log <path>` for another file. Broker logs are separate `broker-*.jsonl` files in the same ignored directory. The broker pairing code appears only in its startup display, not its structured activity log.

If a POST's outcome becomes uncertain, the client performs recovery reads and never resends the action automatically. Durable unresolved intents block later mutations until reconciled. The explicit `--acknowledge-uncertain` option acknowledges any remaining uncertainty and permits only the newly requested action; it does not replay the old one. Reads remain available without that option. Do not edit or share a log containing unresolved intents as if it were a complete transcript.

The TV API retains only 16 KiB per output stream and exposes decoded text plus byte counters. Logs preserve changed snapshots and report gaps, including output already dropped before attachment. They are not a byte-exact or necessarily complete transcript of all output. This connection adds no elevated identity, firmware writes, native-code loader, or startup persistence.

## Permission check button (0.3.1)

After Start shell, Run permission checks submits one fixed read-only script through the existing shell input path. It reports identity, capabilities, the shell security label, relevant mounts, directory/file modes, reported write access, four-byte library reads, and up to twenty library mapping lines each for the shell and its parent service. Its three library targets are `/usr/lib/libCLogger.so`, `/usr/lib/libvoltKPIBridge.so`, and `/usr/lib/libvoltEngine.so.1.22.4`.

The button requires a fresh Running/Ready session with `nextInputSequence: 1`, `lastInput: None`, and no unresolved input request. This first-input rule prevents the script from entering an earlier command's unfinished quote/heredoc or foreground stdin reader. If commands were already sent, Stop shell and Start shell provide a new session for the checks. The button is independent of the command editor and preserves its draft. A click sends the script once. Refresh, polling, loading, and recovery never submit it. A recovery read must match the existing session, sequence, and exact preset text before acknowledging receipt. Receipt is not a completed or successful permission check; the output has section labels and an explicit finished marker, and failures remain in standard error.

The script stays within the existing 4096-byte input limit, uses absolute utility paths, and runs inside a subshell so its temporary loop variable and relaxed error handling do not change the parent shell's variables or options. It does not change mounts, permissions, labels, library contents, or firmware. The only output redirection is the four-byte read into `/dev/null`. Write checks query access without attempting writes. The existing `service.js` and its forty prepared contract cases are reused without changes; this UI addition is reviewed statically and is not executed during preparation.

## Owner shell contract (0.3.0)

Version 0.3.0 adds a pipe-based shell console to the existing page and loopback service. An explicit Start shell action spawns `/bin/sh -s` with piped stdin/stdout/stderr and a separate POSIX process group. Submitted commands share this shell, including its working directory and variables. There is no pseudo-terminal: full-screen terminal programs, password prompts, and job-control shortcuts are not supported. Nothing starts on page load, report refresh, or TV boot.

The existing service owns one shell session at a time. Its lifecycle is `NotStarted -> Running -> Stopping -> Closed`, with `Failed` for a start failure. A new session can start only after the previous shell closes. Stop and expiry request termination of the owned shell process group, with a direct child-handle fallback if the group request fails. A requested signal is not proof of termination. If both requests fail, the session stays Stopping and the user may retry Stop explicitly; a replacement cannot start. Session inactivity expires after five minutes without accepted command input; an absolute fifteen-minute lifetime also applies. These deadlines trigger termination requests, not a guarantee that a denied signal stopped a process. Reads do not prolong the session. Output retains the latest 16 KiB of raw bytes per stream and reports dropped-byte counts.

`GET /v1/shell` reads state and obtains a random 32-byte hex capability token. Both reads and actions require the existing exact loopback Host and allowed Origin. `POST /v1/shell` accepts JSON with `token`, `action`, and `sessionId`; `input` additionally requires `sequence` and `command`. Actions are `start`, `input`, or `stop`. Input is at most 4096 UTF-8 bytes, cannot contain NUL, and is never submitted automatically. The request body is capped at 32768 raw bytes and must be `application/json`; browser preflight permits only that header. No LAN listener, remote connection, elevated identity, or startup persistence is added.

The envelope contains `moduleId`, `schemaVersion: 1`, `shellId: owner-shell`, `token`, `settings`, `session`, and `outcome`. Settings contain `file: /bin/sh`, `args: [-s]`, `maxInputBytes: 4096`, `maxOutputBytesPerStream: 16384`, `idleTimeoutMs: 300000`, and `sessionTimeoutMs: 900000`. A session always includes integer `id`, explicit `status`, `nextInputSequence`, `inputStatus` (`Ready`, `Backpressured`, or `Closed`), bounded `stdout`/`stderr` objects (`bytes`, `text`, `droppedBytes`), explicit `exit`, and explicit `termination`. Start/completion timestamps appear only when observed. Initial session ID is zero. Each start attempt increments the ID; a repeat start for the immediately preceding ID reads the same new session. Stale session actions are rejected. Input sequence starts at one: identical replay of the most recent input is acknowledged without writing twice, while conflicting or out-of-order input is rejected.

`outcome.status` is `Read`, `Started`, `Written`, `Stopped`, `Replay`, or `Rejected`; rejected actions include a bounded `reasonCode`. `Written` means input was submitted to the pipe, not that a command completed successfully. Backpressure blocks further input until drain. Domain rejections return the current envelope. Invalid transport requests return a bounded error response without consuming an action. Session statuses are `NotStarted`, `Running`, `Stopping`, `Closed`, and `Failed`. The existing exit and termination result shapes are reused; termination may also report `scope: ProcessGroup` or `Child`. Unknown or failed delivery is resolved by reading state, never by automatically resending a command. The session exposes `lastInput` as `None` or `Submitted` with its `sequence` and `command`, so a recovery read can identify the actual accepted command rather than assuming another client's input was ours. Only that one input is retained in memory for replay handling. After shell exit is observed, no later timer signals its former PID; up to three seconds are allowed to drain output before owned pipe handles are closed. Background jobs may outlive natural shell exit, and commands that create separate sessions/groups can outlive group termination. This console does not guarantee cleanup of every descendant.

The UI provides Start shell, command input, Send command, Stop shell, and Refresh shell. It polls state every second only while a visible page has a Running/Stopping shell. Polling never sends commands. Leaving or hiding the page stops polling; the service deadlines remain in force. Commands and output are not saved to browser storage or written to a log by this module. No shell, command, test, or application JavaScript is run by the agent during implementation.

## Fixed identity check contract

The fixed identity route owns its original lifecycle: `NotRun -> Running -> terminal result`. That route executes only `/usr/bin/id`, with an empty argument array and no shell interpreter. Its HTTP callers cannot supply executable settings or command input. The separate shell route follows the owner-shell contract above.

| Setting | Value |
| --- | --- |
| User action | Run identity check |
| Start request | Empty `POST /v1/id-check` with an existing allowed browser Origin |
| Read-only request | `GET /v1/id-check` |
| Time budget | 3 seconds, then request `SIGKILL` and report the timeout |
| Captured output | At most 4 KiB of raw bytes per stdout/stderr stream |
| Concurrency and replay | One attempt per module instance; duplicate POST reads the current/cached result |
| Terminal results | `Succeeded`, `Unavailable`, `Denied`, `TimedOut`, `OutputLimitExceeded`, `Failed` |

The result envelope identifies this module, schema version 1, and check ID `fixed-posix-id`. It includes the fixed command settings and a `result` object. `NotRun` has no fabricated timestamps/output. `Running` includes its start timestamp. A terminal result includes start/completion timestamps, bounded captured streams, an explicit exit/signal observation or `NotObserved`, and an explicit termination-request outcome. A kill request is never reported as confirmed process termination. Late process events cannot overwrite a completed result.

The transport requires the existing exact Host/Origin checks. A POST without an allowed Origin, with a body, with transfer encoding, or to another/query-modified route is rejected before the attempt is consumed. GET requests never create a process. The POST returns the current state immediately rather than holding a request for the process deadline.

The page reads the check state on load. Its button sends the empty POST only on an explicit click. It may make two bounded follow-up GETs to display completion; Refresh also reads current state without rerunning the command. No action is configured on boot or on snapshot fetch.

Contract cases cover no execution on load/GET, rejected origins and bodies, fixed program/arguments, duplicate-request idempotence, bounded output, timeout/late-event ordering, missing executable, permission denial, exit failures, and successful completion after streams close. Synthetic tests use fake subprocesses and transport; they are not evidence about the TV. Test execution remains deferred.

## Target versions

Checked against public release sources on 2026-10-22, after the user clarified that version 1.1.3 refers to TizenBrew Installer.

| Component | Version | Role |
| --- | --- | --- |
| TizenBrew Installer | `1.1.3` | Installs TV application packages; its repository installation path fetches the selected repository's latest release dynamically. |
| TizenBrew TV app | `2.0.5` | The currently published app release and the pinned module-loader contract used by these sources. |
| Diagnostic module | `0.3.1` | Adds the fixed read-only permission-check button; this version does not track the installer's number. |
| TV platform baseline | Tizen `3.0`, Node `4.4.3` generation | The existing device record and compatibility baseline preserved by the module's syntax and API choices. |

Using Installer 1.1.3 to install/update TizenBrew currently resolves to the 2.0.5 TV application release. That selection can change when the app publishes another release. The installer installs application packages; it does not update the TV's Tizen operating system. A TV OS update is not a prerequisite established by the inspected app manifest, which declares a minimum platform version of 3.0.

The diagnostic uses the 2.0.5 loader contract. Version 0.1.0's snapshot and version 0.2.0's identity subprocess check were observed working in user-supplied TV photographs. Those results do not validate the new persistent shell. The module is loaded through TizenBrew's module manager. Its source ZIP is not a WGT/TPK package for the installer.

Sources: [Installer 1.1.3](https://github.com/reisxd/TizenBrewInstaller/releases/tag/v1.1.3), [installer package-selection code](https://github.com/reisxd/TizenBrewInstaller/blob/v1.1.3/client/services/tizenbrew-installer-service/index.js#L228), [TizenBrew 2.0.5](https://github.com/reisxd/TizenBrew/releases/tag/v2.0.5), [app manifest](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/config.xml).

## Owning contract

The service collects one snapshot through fixed Node and Tizen API calls. The browser displays that snapshot. Collection does not decide whether system changes are permitted.

Each observation has an `id`, `label`, `source`, and exactly one outcome:

| Status | Payload | Meaning |
| --- | --- | --- |
| `Observed` | `value`, a bounded string, nonnegative integer, or Boolean | An API returned a value of the expected type. UID zero and Boolean false are ordinary observed values. |
| `Unavailable` | `reasonCode` | The API or module is unavailable. There is no fabricated value. |
| `Error` | `reasonCode` | An API threw or returned an unexpected value. Exception messages and stacks are excluded. |

The report envelope identifies `moduleId: tizenbrew-runtime-identity`, `schemaVersion: 1`, `source: tizenbrew-service-process`, and `collectedAtUtc`. The snapshot includes these fixed fields:

| Observation | Source |
| --- | --- |
| Node version | `process.version` |
| OS platform | `process.platform` |
| Process architecture | `process.arch` |
| Service UID | `process.getuid()` when available |
| Service GID | `process.getgid()` when available |
| Application ID | `tizen.application.getAppInfo().id` |
| Package ID | `tizen.application.getAppInfo().packageId` |
| Tizen platform version | `tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version')` |
| Web service feature | `tizen.systeminfo.getCapability('http://tizen.org/feature/web.service')` |
| Subprocess module availability | Whether the built-in `child_process` module can be loaded; no subprocess is started |

The collector owns construction of valid observations. App metadata is read once and shared by its two identity observations. A collection failure is represented explicitly and does not erase other results. The snapshot is cached for the lifetime of this module instance; browser Refresh reads the same snapshot and timestamp.

The snapshot does not collect environment variables, command-line arguments, filesystem contents, credentials, tokens, process paths, shell commands, or D-Bus calls. A loaded subprocess module establishes API availability only. The separate fixed command result applies only to that invocation; it does not establish an interactive shell, elevated access, writable system partitions, or acceptance of modified libraries.

## Reuse and module lifecycle

The existing TizenBrew service owns module loading. `package.json` reuses its `packageType`, `appPath`, and `serviceFile` contract. The existing `service.js` owns snapshot collection, the fixed check, the separate persistent shell lifecycle, and their local transport. Exit observation and process-start error classification are shared. The page reuses one bounded JSON request adapter across its views. These sources use built-in Node modules only and ES5 syntax for Node 4.4.3. Timers are imported explicitly, rather than assuming that the host VM injects timer globals. The persistent shell is a separate lifecycle inside the existing file because it owns repeated input, session IDs, backpressure, deadlines, and output tails; it is not another fixed one-shot check.

TizenBrew's inspected loader evaluates `serviceFile` directly. It does not call a module's `onStart`, so this file initializes at top level. The supplied `require` belongs to the host; there are no relative service imports or npm dependencies. The module does not call `process.exit`, change the host's globals, or create its own Tizen service package.

The module owns one HTTP listener bound explicitly to `127.0.0.1:18765`. `GET /v1/report` returns the snapshot; `GET /v1/id-check` reads the check; empty `POST /v1/id-check` starts its one permitted attempt. `GET/POST /v1/shell` manage the explicit shell session. The service accepts the local endpoint's Host header and the inspected TizenBrew module origins, `http://127.0.0.1:8081` or `http://localhost:8081`. No LAN listener is created. Snapshot/check reads without Origin still need the local Host header; every shell request and every POST requires an allowed Origin. The capability token is additional protection against unintended requests, not authentication between native processes or other trusted modules sharing that origin and account.

The listener lifecycle is `Starting`, `Listening`, `Failed`, or `Closed`, with its state held by this module. A port conflict produces `Failed / PortInUse` in the service log; it never takes over or terminates an existing listener. The page validates the response's module identity and schema before displaying it. These checks identify the expected report format; they are not cryptographic authentication of a process.

The listener remains associated with TizenBrew's background service. Leaving the page does not necessarily stop that process. The listener is unreferenced so it cannot keep the host alive by itself. Stopping the owning background process closes it. TizenBrew caches module services, so an instance with a transport failure is not assumed to rerun merely because the page is reopened; a full restart of the host service may be needed. No boot launch or autolaunch configuration is supplied.

## Files and delivery

- `package.json`: TizenBrew module metadata; the npm `private` flag prevents accidental npm publication.
- `service.js`: self-contained collector, fixed identity check, persistent shell, and loopback transport adapter.
- `app/index.html` and `app/main.js`: report and shell controls, bounded requests, and explicit outcomes.
- `tests/identity-check.contract.js`: synthetic service contract cases with fake processes, sockets, timers, and capability tokens; never invokes a real subprocess.

The folder and accompanying ZIP are source artifacts, not signed WGT installers. No build or dependency installation is needed for these sources. Opening `app/index.html` on the PC does not start the service or reproduce the TV runtime.

The inspected TizenBrew loader obtains module metadata and service source through jsDelivr. The user's repository is `akious-san/tizenbrew-logger`; it must remain publicly readable for this delivery path. The package.json `private` flag only prevents npm publication and is independent of GitHub visibility.

Version 0.3.1 uses the GitHub tag `v0.3.1` for a stable module reference. The TV fetches that tag rather than uncommitted files on the PC.

In TizenBrew's Module Manager, remove the old module entry and add a GitHub module using `akious-san/tizenbrew-logger@v0.3.1` (the UI adds `gh/`). A new tag avoids reusing previously fetched branch contents. Restart the TV fully before opening the new entry: TizenBrew can retain the old service instance and loopback listener after merely leaving a page. There is no need to reinstall TizenBrew or update firmware for this module source change.

Open Runtime Identity. Choose Start shell, enter a command, then Send command. Each command is sent once to the same running shell. Stop shell requests session termination. Refresh shell reads state and output. For example, entering `pwd` asks the shell to print its working directory; entering `cd /tmp` and then `pwd` uses that directory in the same session. These are usage examples, not commands executed by the agent. Publishing the module does not start a shell.

For the fixed diagnostics, choose Start shell and then Run permission checks before sending any other command. The editor can contain an unsent draft; the button leaves it intact. After earlier input, Stop shell and Start shell enable the button in a fresh session. Read the labelled results in standard output and any failures in standard error. FINISHED indicates the script reached its end, not that access was granted or that all queries succeeded.

Use the remote's Left/Right buttons to move between enabled controls. Down from Send focuses standard output; arrows scroll inside it, Left/Right switch output streams, and Back/Escape returns to controls. New output follows the bottom while it is already in view; scrolling up keeps the reader's position. Up/Down otherwise remain available for scrolling the report.

## Expected display behavior

On launch, the page reads the snapshot and current check state without starting a process. Requests have finite timeouts and size limits. If the asynchronously loaded service is not ready yet, Refresh allows another read. Clicking Run identity check sends an empty POST. If the result is still Running, at most two delayed GETs read completion; no indefinite polling or execution retry occurs. A malformed, oversized, unknown, or unreachable response is shown as unavailable rather than rendered as evidence. Values and captured output are inserted as text.

The inspected host serves application modules over local HTTP on port 8081, which worked for the photographed version 0.1.0 report. A different host origin, policy, or module contract can still prevent display. The page provides a short failure message; detailed contract limitations belong in this file rather than the TV's user flow.

## Validation record

User photographs supply the existing shell and permission-check runtime evidence. Version 0.4.0 has separate local synthetic contract suites for the original service, TV relay, PC broker and PC controller. The synthetic suites replace network/process boundaries with fakes and do not establish on-TV pairing, shell execution or firmware compatibility. Publication and PC listeners must likewise be reported separately from a completed TV connection. See the task's delivery record for actual test counts and live outcomes.

## Source references

- [TizenBrew v2.0.5 module contract](https://github.com/reisxd/TizenBrew/blob/v2.0.5/docs/MODULES.md)
- [TizenBrew v2.0.5 module service loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/serviceLauncher.js)
- [TizenBrew v2.0.5 host service](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/index.js)
- [TizenBrew v2.0.5 module metadata loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js)
- [Older TizenTube module manifest example](https://github.com/reisxd/TizenTube/blob/v2.0.1/package.json)
- [Node 4.4.3 child-process API](https://nodejs.org/download/release/v4.4.3/docs/api/child_process.html)
- [Node 4.4.3 stream write API](https://nodejs.org/download/release/v4.4.3/docs/api/stream.html#stream_writable_write_chunk_encoding_callback)

These references describe inspected public sources. The installation record and the user's photo supply the separate device evidence; the public sources alone do not identify an installed version.
