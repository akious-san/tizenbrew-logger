# TizenBrew runtime identity

A small TizenBrew application module that reports the runtime and identity of TizenBrew's Node service process. This is the first evidence-collection step toward choosing a compatible app-level command interface.

Status: source prepared locally. It has not been run, tested, published, installed, or checked on a TV. The user's installed TizenBrew version is unknown. The user reports an older installation with TizenTube and a second, unidentified Jelly-like application.

## Target versions

Checked against public release sources on 2026-10-22, after the user clarified that version 1.1.3 refers to TizenBrew Installer.

| Component | Version | Role |
| --- | --- | --- |
| TizenBrew Installer | `1.1.3` | Installs TV application packages; its repository installation path fetches the selected repository's latest release dynamically. |
| TizenBrew TV app | `2.0.5` | The currently published app release and the pinned module-loader contract used by these sources. |
| Diagnostic module | `0.1.0` | This independent module's version; it does not track the installer's version number. |
| TV platform baseline | Tizen `3.0`, Node `4.4.3` generation | The existing device record and compatibility baseline preserved by the module's syntax and API choices. |

Using Installer 1.1.3 to install/update TizenBrew currently resolves to the 2.0.5 TV application release. That selection can change when the app publishes another release. The installer installs application packages; it does not update the TV's Tizen operating system. A TV OS update is not a prerequisite established by the inspected app manifest, which declares a minimum platform version of 3.0.

The diagnostic already uses the 2.0.5 loader contract, so this clarification required no JavaScript changes. These are source-based target versions, not a passed compatibility test. After a later TizenBrew app update, the diagnostic remains a module loaded through TizenBrew's module manager. Its source ZIP is not a WGT/TPK package for the installer.

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

No environment variables, command-line arguments, filesystem contents, credentials, tokens, process paths, shell commands, or D-Bus calls are collected. A loaded subprocess module establishes API availability only. The report does not establish successful command execution, elevated access, writable system partitions, or acceptance of modified libraries.

## Reuse and module lifecycle

The existing TizenBrew service owns module loading. `package.json` reuses its `packageType`, `appPath`, and `serviceFile` contract. The new `service.js` has the separate responsibility of collecting this snapshot and exposing it to the display page. It uses built-in Node modules only and ES5 syntax for the documented Node 4.4.3 generation.

TizenBrew's inspected loader evaluates `serviceFile` directly. It does not call a module's `onStart`, so this file initializes at top level. The supplied `require` belongs to the host; there are no relative service imports or npm dependencies. The module does not call `process.exit`, change the host's globals, or create its own Tizen service package.

The module owns one HTTP listener bound explicitly to `127.0.0.1:18765`. Its only report route is `GET /v1/report`. The service accepts the local endpoint's Host header and allows browser reads only from the inspected TizenBrew module origin, `http://127.0.0.1:8081` or `http://localhost:8081`. No LAN listener or command endpoint is created. A request without an Origin header still needs the local Host header.

The listener lifecycle is `Starting`, `Listening`, `Failed`, or `Closed`, with its state held by this module. A port conflict produces `Failed / PortInUse` in the service log; it never takes over or terminates an existing listener. The page validates the response's module identity and schema before displaying it. These checks identify the expected report format; they are not cryptographic authentication of a process.

The listener remains associated with TizenBrew's background service. Leaving the page does not necessarily stop that process. The listener is unreferenced so it cannot keep the host alive by itself. Stopping the owning background process closes it. TizenBrew caches module services, so an instance with a transport failure is not assumed to rerun merely because the page is reopened; a full restart of the host service may be needed. No boot launch or autolaunch configuration is supplied.

## Files and delivery

- `package.json`: TizenBrew module metadata; the npm `private` flag prevents accidental npm publication.
- `service.js`: self-contained collector and loopback report adapter.
- `app/index.html` and `app/main.js`: display page, remote-friendly Refresh button, bounded request, and explicit connection/report errors.

The folder and accompanying ZIP are source artifacts, not signed WGT installers. No build or dependency installation is needed for these sources. Opening `app/index.html` on the PC does not start the service or reproduce the TV runtime.

The inspected TizenBrew loader obtains module metadata and service source through jsDelivr. For later deployment, these files would need an approved, CDN-accessible module location with `package.json` at its root. For example, after publishing an approved GitHub repository and tag, its module reference has the shape `gh/OWNER/REPOSITORY@TAG`. This is a format example, not an existing repository or installation instruction. Nothing has been published or added to the TV.

## Expected display behavior

On a later authorized launch, the page makes one request to the local report endpoint with a three-second timeout. If the asynchronously loaded service is not ready yet, Refresh allows another request. There is no polling loop. Refresh is disabled while a request is active. A malformed, oversized, unknown, or unreachable report is shown as unavailable rather than rendered as evidence. Values are inserted as text.

The inspected host serves application modules over local HTTP on port 8081. An older host using another origin, a different content-security policy, or a different module contract can prevent display. That compatibility has not been tested. The page provides a short failure message; detailed source/contract limitations belong in this file rather than the TV's user flow.

## Validation record

Only source inspection and metadata/archive checks are permitted in this preparation step. No JavaScript, application, test, shell payload, or firmware was executed. No connection to the TV was made. Do not interpret this file or the package's existence as a passed runtime or integration test.

## Source references

- [TizenBrew v2.0.5 module contract](https://github.com/reisxd/TizenBrew/blob/v2.0.5/docs/MODULES.md)
- [TizenBrew v2.0.5 module service loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/serviceLauncher.js)
- [TizenBrew v2.0.5 host service](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/index.js)
- [TizenBrew v2.0.5 module metadata loader](https://github.com/reisxd/TizenBrew/blob/v2.0.5/tizenbrew-app/TizenBrew/service-nextgen/service/utils/moduleLoader.js)
- [Older TizenTube module manifest example](https://github.com/reisxd/TizenTube/blob/v2.0.1/package.json)

These references describe inspected public sources. They do not identify the version installed on the user's TV.
