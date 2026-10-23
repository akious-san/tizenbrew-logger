# TizenBrew runtime identity

A small TizenBrew application module that reports the runtime and identity of TizenBrew's Node service process. This is the first evidence-collection step toward choosing a compatible app-level command interface.

Status: version 0.1.0's runtime report was observed working on the user's TV in a photograph: Node 4.4.3, ARM/Linux, UID 5001, GID 100, Tizen 3.0. Version 0.2.0 adds the authorized fixed identity command check. Its command check has not been run on the TV by the agent.

## Fixed identity check contract

The existing service owns one additional lifecycle: `NotRun -> Running -> terminal result`. The only executable is `/usr/bin/id`, with an empty argument array and no shell interpreter. No executable, arguments, environment, working directory, or input can be supplied by an HTTP caller.

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
| Diagnostic module | `0.2.0` | Adds the explicitly triggered fixed identity check; this version does not track the installer's number. |
| TV platform baseline | Tizen `3.0`, Node `4.4.3` generation | The existing device record and compatibility baseline preserved by the module's syntax and API choices. |

Using Installer 1.1.3 to install/update TizenBrew currently resolves to the 2.0.5 TV application release. That selection can change when the app publishes another release. The installer installs application packages; it does not update the TV's Tizen operating system. A TV OS update is not a prerequisite established by the inspected app manifest, which declares a minimum platform version of 3.0.

The diagnostic uses the 2.0.5 loader contract. Version 0.1.0's snapshot was observed working on the TV; that does not validate the new subprocess check. The diagnostic remains a module loaded through TizenBrew's module manager. Its source ZIP is not a WGT/TPK package for the installer.

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

The existing TizenBrew service owns module loading. `package.json` reuses its `packageType`, `appPath`, and `serviceFile` contract. The existing `service.js` owns snapshot collection, the fixed check lifecycle, and their local transport. The page reuses one bounded JSON request adapter for both views. These sources use built-in Node modules only and ES5 syntax for the documented Node 4.4.3 generation. The service imports the built-in `timers` module explicitly, rather than assuming that the host VM injects timer globals.

TizenBrew's inspected loader evaluates `serviceFile` directly. It does not call a module's `onStart`, so this file initializes at top level. The supplied `require` belongs to the host; there are no relative service imports or npm dependencies. The module does not call `process.exit`, change the host's globals, or create its own Tizen service package.

The module owns one HTTP listener bound explicitly to `127.0.0.1:18765`. `GET /v1/report` returns the snapshot; `GET /v1/id-check` reads the check; empty `POST /v1/id-check` starts its one permitted attempt. The service accepts the local endpoint's Host header and the inspected TizenBrew module origins, `http://127.0.0.1:8081` or `http://localhost:8081`. No LAN listener or arbitrary-command interface is created. Reads without an Origin header still need the local Host header; POST requires an allowed Origin.

The listener lifecycle is `Starting`, `Listening`, `Failed`, or `Closed`, with its state held by this module. A port conflict produces `Failed / PortInUse` in the service log; it never takes over or terminates an existing listener. The page validates the response's module identity and schema before displaying it. These checks identify the expected report format; they are not cryptographic authentication of a process.

The listener remains associated with TizenBrew's background service. Leaving the page does not necessarily stop that process. The listener is unreferenced so it cannot keep the host alive by itself. Stopping the owning background process closes it. TizenBrew caches module services, so an instance with a transport failure is not assumed to rerun merely because the page is reopened; a full restart of the host service may be needed. No boot launch or autolaunch configuration is supplied.

## Files and delivery

- `package.json`: TizenBrew module metadata; the npm `private` flag prevents accidental npm publication.
- `service.js`: self-contained collector, fixed identity check, and loopback transport adapter.
- `app/index.html` and `app/main.js`: display page, Refresh and Run identity check buttons, bounded requests, and explicit outcomes.
- `tests/identity-check.contract.js`: synthetic contract cases with fake processes, sockets, and timers; never invokes a real subprocess.

The folder and accompanying ZIP are source artifacts, not signed WGT installers. No build or dependency installation is needed for these sources. Opening `app/index.html` on the PC does not start the service or reproduce the TV runtime.

The inspected TizenBrew loader obtains module metadata and service source through jsDelivr. The user's repository is `akious-san/tizenbrew-logger`; it must remain publicly readable for this delivery path. The package.json `private` flag only prevents npm publication and is independent of GitHub visibility.

Version 0.2.0 uses the GitHub tag `v0.2.0` for a stable module reference.

In TizenBrew's Module Manager, remove the old module entry and add a GitHub module using `akious-san/tizenbrew-logger@v0.2.0` (the UI adds `gh/`). A new tag avoids reusing the previously fetched branch contents. Restart the TV fully before opening the new entry: TizenBrew can retain the old service instance and its loopback listener after merely leaving a page. There is no need to reinstall TizenBrew or update firmware for this module source change.

Open Runtime Identity and choose Run identity check when you want to perform the one check. Refresh reads its existing result. Publishing the module does not execute the check; the agent has not run it on the TV.

Use the remote's Left/Right buttons to move between the two enabled buttons; Up/Down remain available for scrolling the report.

## Expected display behavior

On launch, the page reads the snapshot and current check state without starting a process. Requests have finite timeouts and size limits. If the asynchronously loaded service is not ready yet, Refresh allows another read. Clicking Run identity check sends an empty POST. If the result is still Running, at most two delayed GETs read completion; no indefinite polling or execution retry occurs. A malformed, oversized, unknown, or unreachable response is shown as unavailable rather than rendered as evidence. Values and captured output are inserted as text.

The inspected host serves application modules over local HTTP on port 8081, which worked for the photographed version 0.1.0 report. A different host origin, policy, or module contract can still prevent display. The page provides a short failure message; detailed contract limitations belong in this file rather than the TV's user flow.

## Validation record

The earlier snapshot has user-supplied on-TV evidence. The new version's preparation uses source inspection and metadata/archive checks only. Synthetic tests are supplied but have not been executed; no real `/usr/bin/id` invocation, TV connection, or deployment is performed by the agent in this step. Do not interpret a prepared package as a passed command-execution or integration test.

## Source references

- [TizenBrew v2.0.5 module contract](https://github.com/reisxd/TizenBrew/blob/v2.0.5/docs/MODULES.md)
- [TizenBrew v2.0.5 module service loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/serviceLauncher.js)
- [TizenBrew v2.0.5 host service](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/index.js)
- [TizenBrew v2.0.5 module metadata loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js)
- [Older TizenTube module manifest example](https://github.com/reisxd/TizenTube/blob/v2.0.1/package.json)
- [Node 4.4.3 child-process API](https://nodejs.org/download/release/v4.4.3/docs/api/child_process.html)

These references describe inspected public sources. The installation record and the user's photo supply the separate device evidence; the public sources alone do not identify an installed version.
