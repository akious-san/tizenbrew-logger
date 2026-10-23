/* TizenBrew evaluates serviceFile directly; no onStart export is invoked. */
(function () {
    'use strict';

    var MODULE_ID = 'tizenbrew-runtime-identity';
    var REPORT_PATH = '/v1/report';
    var CHECK_PATH = '/v1/id-check';
    var SHELL_PATH = '/v1/shell';
    var PC_LINK_PATH = '/v1/pc-link';
    var MAX_SHELL_BODY_BYTES = 32768;
    var PORT = 18765;
    var MAX_REPORT_BYTES = 16384;
    var runtime = typeof process === 'undefined' ? {} : process;
    var platform = typeof tizen === 'undefined' ? {} : tizen;
    var timers = require('timers');

    var fields = {
        nodeVersion: field('node.version', 'Node version', 'process.version', 'string'),
        osPlatform: field('node.platform', 'OS platform', 'process.platform', 'string'),
        architecture: field('node.architecture', 'Process architecture', 'process.arch', 'string'),
        uid: field('process.uid', 'Service UID', 'process.getuid()', 'integer'),
        gid: field('process.gid', 'Service GID', 'process.getgid()', 'integer'),
        appId: field('tizen.applicationId', 'Application ID', 'tizen.application.getAppInfo().id', 'string'),
        packageId: field('tizen.packageId', 'Package ID', 'tizen.application.getAppInfo().packageId', 'string'),
        platformVersion: field('tizen.platformVersion', 'Tizen version', 'tizen.systeminfo.getCapability(platform.version)', 'string'),
        webService: field('tizen.webService', 'Web service feature', 'tizen.systeminfo.getCapability(web.service)', 'boolean'),
        childProcess: field('node.childProcess', 'Subprocess module', 'require(child_process); no command executed', 'string')
    };

    function field(id, label, source, valueType) {
        return Object.freeze({ id: id, label: label, source: source, valueType: valueType });
    }

    function result(descriptor, status, payloadName, payload) {
        var observation = {
            id: descriptor.id,
            label: descriptor.label,
            source: descriptor.source,
            status: status
        };
        observation[payloadName] = payload;
        return Object.freeze(observation);
    }

    function unavailable(descriptor, reasonCode) {
        return result(descriptor, 'Unavailable', 'reasonCode', reasonCode);
    }

    function failed(descriptor, reasonCode) {
        return result(descriptor, 'Error', 'reasonCode', reasonCode);
    }

    function observed(descriptor, value) {
        var valid = false;
        if (descriptor.valueType === 'string') {
            valid = typeof value === 'string' && value.length > 0 && value.length <= 256;
        } else if (descriptor.valueType === 'integer') {
            valid = typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value;
        } else if (descriptor.valueType === 'boolean') {
            valid = typeof value === 'boolean';
        }
        if (!valid) {
            return failed(descriptor, 'UnexpectedValue');
        }
        return result(descriptor, 'Observed', 'value', value);
    }

    function readProperty(descriptor, owner, name) {
        try {
            if (!owner || typeof owner[name] === 'undefined') {
                return unavailable(descriptor, 'PropertyUnavailable');
            }
            return observed(descriptor, owner[name]);
        } catch (error) {
            return failed(descriptor, 'ApiReadFailed');
        }
    }

    function callMethod(descriptor, owner, name, args) {
        try {
            if (!owner || typeof owner[name] !== 'function') {
                return unavailable(descriptor, 'MethodUnavailable');
            }
            return observed(descriptor, owner[name].apply(owner, args));
        } catch (error) {
            return failed(descriptor, 'ApiCallFailed');
        }
    }

    function readAppInfo() {
        try {
            if (!platform.application || typeof platform.application.getAppInfo !== 'function') {
                return { status: 'Unavailable', reasonCode: 'MethodUnavailable' };
            }
            var info = platform.application.getAppInfo();
            if (!info || typeof info !== 'object') {
                return { status: 'Error', reasonCode: 'UnexpectedAppInfo' };
            }
            return { status: 'Observed', value: info };
        } catch (error) {
            return { status: 'Error', reasonCode: 'ApiCallFailed' };
        }
    }

    function appIdentity(descriptor, appInfo, property) {
        if (appInfo.status === 'Unavailable') {
            return unavailable(descriptor, appInfo.reasonCode);
        }
        if (appInfo.status === 'Error') {
            return failed(descriptor, appInfo.reasonCode);
        }
        return readProperty(descriptor, appInfo.value, property);
    }

    function capability(descriptor, name) {
        try {
            return callMethod(descriptor, platform.systeminfo, 'getCapability', [name]);
        } catch (error) {
            return failed(descriptor, 'ApiReadFailed');
        }
    }

    function subprocessAvailability() {
        try {
            var childProcess = require('child_process');
            if (!childProcess || typeof childProcess !== 'object') {
                return failed(fields.childProcess, 'UnexpectedModule');
            }
            return observed(fields.childProcess, 'Available; execution untested');
        } catch (error) {
            if (error && error.code === 'MODULE_NOT_FOUND') {
                return unavailable(fields.childProcess, 'ModuleUnavailable');
            }
            return failed(fields.childProcess, 'ModuleLoadFailed');
        }
    }

    function collectSnapshot() {
        var appInfo = readAppInfo();
        var observations = [
            readProperty(fields.nodeVersion, runtime, 'version'),
            readProperty(fields.osPlatform, runtime, 'platform'),
            readProperty(fields.architecture, runtime, 'arch'),
            callMethod(fields.uid, runtime, 'getuid', []),
            callMethod(fields.gid, runtime, 'getgid', []),
            appIdentity(fields.appId, appInfo, 'id'),
            appIdentity(fields.packageId, appInfo, 'packageId'),
            capability(fields.platformVersion, 'http://tizen.org/feature/platform.version'),
            capability(fields.webService, 'http://tizen.org/feature/web.service'),
            subprocessAvailability()
        ];
        return Object.freeze({
            moduleId: MODULE_ID,
            schemaVersion: 1,
            source: 'tizenbrew-service-process',
            collectedAtUtc: new Date().toISOString(),
            observations: Object.freeze(observations)
        });
    }

    // The fixed settings are composed here; HTTP input never selects a program.
    var identitySettings = Object.freeze({
        file: '/usr/bin/id',
        args: Object.freeze([]),
        timeoutMs: 3000,
        maxOutputBytesPerStream: 4096
    });

    function processStartFailure(error) {
        var code = error && error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'MODULE_NOT_FOUND') {
            return { status: 'Unavailable', reasonCode: 'ExecutableOrRuntimeUnavailable' };
        }
        if (code === 'EACCES' || code === 'EPERM') {
            return { status: 'Denied', reasonCode: 'ExecutionDenied' };
        }
        return { status: 'Failed', reasonCode: 'ProcessStartFailed' };
    }

    function observeExit(code, signal) {
        if (typeof code === 'number' && isFinite(code) && Math.floor(code) === code) {
            return { status: 'Observed', kind: 'Code', value: code };
        }
        if (typeof signal === 'string' && /^[A-Z0-9]{1,32}$/.test(signal)) {
            return { status: 'Observed', kind: 'Signal', value: signal };
        }
        return { status: 'NotObserved' };
    }

    function createIdentityCheck(settings) {
        var state = Object.freeze({ status: 'NotRun' });

        function running(attempt) {
            return state === attempt && attempt.phase === 'Running';
        }

        function captured(stream) {
            return Object.freeze({
                bytes: stream.bytes,
                text: Buffer.concat(stream.chunks, stream.bytes).toString('utf8')
            });
        }

        function complete(attempt, status, exit, termination, reasonCode) {
            if (state !== attempt || (attempt.phase !== 'Running' && attempt.phase !== 'Stopping')) {
                return;
            }
            attempt.phase = 'Completed';
            if (attempt.timer) {
                timers.clearTimeout(attempt.timer);
            }
            var outcome = {
                status: status,
                startedAtUtc: attempt.startedAtUtc,
                completedAtUtc: new Date().toISOString(),
                stdout: captured(attempt.stdout),
                stderr: captured(attempt.stderr),
                exit: Object.freeze(exit),
                termination: Object.freeze(termination)
            };
            if (reasonCode) {
                outcome.reasonCode = reasonCode;
            }
            state = Object.freeze(outcome);
        }

        function stop(attempt, status, reasonCode) {
            if (!running(attempt)) {
                return;
            }
            // Mark stopping before kill: late/synchronous child events cannot replace this outcome.
            attempt.phase = 'Stopping';
            var termination = { status: 'RequestFailed', signal: 'SIGKILL' };
            try {
                if (attempt.child && attempt.child.kill('SIGKILL')) {
                    termination.status = 'Requested';
                }
            } catch (error) {
                // A signal request failure is evidence, not proof that the child exited.
            }
            complete(attempt, status, { status: 'NotObserved' }, termination, reasonCode);
            ['stdout', 'stderr'].forEach(function (name) {
                var stream = attempt.child && attempt.child[name];
                if (stream && typeof stream.destroy === 'function') {
                    try { stream.destroy(); } catch (error) { /* Result already records the stop. */ }
                }
            });
        }

        function startFailure(attempt, error) {
            if (!running(attempt)) {
                return;
            }
            var failure = processStartFailure(error);
            complete(attempt, failure.status, { status: 'NotObserved' },
                { status: 'NotRequested' }, failure.reasonCode);
        }

        function capture(attempt, name, chunk) {
            if (!running(attempt)) {
                return;
            }
            if (!Buffer.isBuffer(chunk)) {
                stop(attempt, 'Failed', 'UnexpectedOutput');
                return;
            }
            var stream = attempt[name];
            var remaining = settings.maxOutputBytesPerStream - stream.bytes;
            var retained = Math.min(chunk.length, remaining);
            if (retained > 0) {
                stream.chunks.push(chunk.slice(0, retained));
                stream.bytes += retained;
            }
            if (chunk.length > remaining) {
                stop(attempt, 'OutputLimitExceeded', 'OutputLimitExceeded');
            }
        }

        function read() {
            var result = state;
            if (state.phase === 'Running' || state.phase === 'Stopping') {
                result = Object.freeze({ status: 'Running', startedAtUtc: state.startedAtUtc });
            }
            return Object.freeze({
                moduleId: MODULE_ID,
                schemaVersion: 1,
                checkId: 'fixed-posix-id',
                command: settings,
                result: result
            });
        }

        function start() {
            if (state.status !== 'NotRun') {
                return read();
            }
            var attempt = {
                phase: 'Running',
                startedAtUtc: new Date().toISOString(),
                stdout: { bytes: 0, chunks: [] },
                stderr: { bytes: 0, chunks: [] }
            };
            state = attempt;
            var childProcess;
            try {
                childProcess = require('child_process');
                if (!childProcess || typeof childProcess.spawn !== 'function') {
                    complete(attempt, 'Unavailable', { status: 'NotObserved' },
                        { status: 'NotRequested' }, 'SubprocessApiUnavailable');
                    return read();
                }
                attempt.child = childProcess.spawn(settings.file, settings.args.slice(), {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
            } catch (error) {
                startFailure(attempt, error);
                return read();
            }
            var child = attempt.child;
            child.on('error', function (error) { startFailure(attempt, error); });
            child.on('close', function (code, signal) {
                if (!running(attempt)) {
                    return;
                }
                var exit = observeExit(code, signal);
                complete(attempt, exit.kind === 'Code' && exit.value === 0 ? 'Succeeded' : 'Failed',
                    exit, { status: 'NotRequested' });
            });
            if (!child.stdout || !child.stderr || typeof child.stdout.on !== 'function' ||
                    typeof child.stderr.on !== 'function') {
                stop(attempt, 'Failed', 'OutputStreamsUnavailable');
                return read();
            }
            ['stdout', 'stderr'].forEach(function (name) {
                child[name].on('data', function (chunk) { capture(attempt, name, chunk); });
                child[name].on('error', function () { stop(attempt, 'Failed', 'OutputReadFailed'); });
            });
            attempt.timer = timers.setTimeout(function () { stop(attempt, 'TimedOut', 'DeadlineExceeded'); }, settings.timeoutMs);
            return read();
        }

        return Object.freeze({ read: read, start: start });
    }

    var shellSettings = Object.freeze({
        file: '/bin/sh',
        args: Object.freeze(['-s']),
        maxInputBytes: 4096,
        maxOutputBytesPerStream: 16384,
        idleTimeoutMs: 300000,
        sessionTimeoutMs: 900000
    });

    function createShell(settings, token, signalProcess) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
            throw new Error('SecureShellTokenUnavailable');
        }

        function newSession(id, status) {
            return {
                id: id,
                status: status,
                processStatus: 'NotStarted',
                nextInputSequence: 1,
                inputStatus: 'Closed',
                lastInput: { status: 'None' },
                stdout: { buffer: new Buffer(0), droppedBytes: 0 },
                stderr: { buffer: new Buffer(0), droppedBytes: 0 },
                exit: { status: 'NotObserved' },
                termination: { status: 'NotRequested' }
            };
        }

        var state = newSession(0, 'NotStarted');

        function active(attempt) {
            return state === attempt && (attempt.status === 'Running' || attempt.status === 'Stopping');
        }

        function clearTimers(attempt) {
            ['idleTimer', 'lifetimeTimer', 'drainTimer'].forEach(function (name) {
                if (attempt[name]) {
                    timers.clearTimeout(attempt[name]);
                }
            });
        }

        function output(stream) {
            return { bytes: stream.buffer.length, text: stream.buffer.toString('utf8'), droppedBytes: stream.droppedBytes };
        }

        function read(outcome) {
            var session = {
                id: state.id,
                status: state.status,
                nextInputSequence: state.nextInputSequence,
                inputStatus: state.inputStatus,
                lastInput: state.lastInput,
                stdout: output(state.stdout),
                stderr: output(state.stderr),
                exit: state.exit,
                termination: state.termination
            };
            ['startedAtUtc', 'completedAtUtc', 'reasonCode'].forEach(function (name) {
                if (Object.prototype.hasOwnProperty.call(state, name)) {
                    session[name] = state[name];
                }
            });
            return { moduleId: MODULE_ID, schemaVersion: 1, shellId: 'owner-shell',
                token: token, settings: settings, session: session, outcome: outcome || { status: 'Read' } };
        }

        function rejected(reasonCode) {
            return read({ status: 'Rejected', reasonCode: reasonCode });
        }

        function closePipes(attempt) {
            ['stdin', 'stdout', 'stderr'].forEach(function (name) {
                var stream = attempt.child && attempt.child[name];
                if (stream && typeof stream.destroy === 'function') {
                    try { stream.destroy(); } catch (error) { /* Never touch host-owned handles. */ }
                }
            });
        }

        function finish(attempt, status, reasonCode) {
            if (!active(attempt)) {
                return;
            }
            attempt.status = status;
            attempt.inputStatus = 'Closed';
            attempt.processStatus = 'Exited';
            attempt.completedAtUtc = new Date().toISOString();
            if (reasonCode) {
                attempt.reasonCode = reasonCode;
            }
            clearTimers(attempt);
        }

        function stop(attempt, reasonCode, retry) {
            if (!active(attempt) || attempt.processStatus === 'Exited' ||
                    (attempt.status === 'Stopping' && (retry !== true || attempt.termination.status !== 'RequestFailed'))) {
                return;
            }
            attempt.status = 'Stopping';
            attempt.inputStatus = 'Closed';
            attempt.reasonCode = reasonCode;
            clearTimers(attempt);
            // Only a PID captured from this detached spawn may select a process group.
            var pid = attempt.child && attempt.child.pid;
            var grouped = typeof pid === 'number' && isFinite(pid) && Math.floor(pid) === pid && pid > 1 &&
                signalProcess && typeof signalProcess.kill === 'function';
            var termination = { status: 'RequestFailed', signal: 'SIGKILL', scope: grouped ? 'ProcessGroup' : 'Child' };
            try {
                if (grouped) {
                    signalProcess.kill(-pid, 'SIGKILL');
                    termination.status = 'Requested';
                } else if (attempt.child && attempt.child.kill('SIGKILL')) {
                    termination.status = 'Requested';
                }
            } catch (error) {
                // The child handle remains owned even if its group was unavailable or signalling was denied.
            }
            if (grouped && termination.status === 'RequestFailed') {
                termination.scope = 'Child';
                try {
                    if (attempt.child.kill('SIGKILL')) {
                        termination.status = 'Requested';
                    }
                } catch (error) {
                    // A failed request remains visible and may be retried explicitly; never start a replacement.
                }
            }
            attempt.termination = termination;
        }

        function renewIdle(attempt) {
            if (attempt.idleTimer) {
                timers.clearTimeout(attempt.idleTimer);
            }
            attempt.idleTimer = timers.setTimeout(function () {
                if (active(attempt) && attempt.status === 'Running') {
                    stop(attempt, 'IdleExpired');
                }
            }, settings.idleTimeoutMs);
        }

        function capture(attempt, name, chunk) {
            if (!active(attempt)) {
                return;
            }
            if (!Buffer.isBuffer(chunk)) {
                stop(attempt, 'UnexpectedOutput');
                return;
            }
            var stream = attempt[name];
            var combined = Buffer.concat([stream.buffer, chunk]);
            var dropped = Math.max(0, combined.length - settings.maxOutputBytesPerStream);
            stream.buffer = dropped > 0 ? Buffer.concat([combined.slice(dropped)]) : combined;
            stream.droppedBytes += dropped;
        }

        function start() {
            var attempt = newSession(state.id + 1, 'Running');
            attempt.startedAtUtc = new Date().toISOString();
            state = attempt;
            try {
                var childProcess = require('child_process');
                attempt.child = childProcess.spawn(settings.file, settings.args.slice(), {
                    stdio: ['pipe', 'pipe', 'pipe'], detached: true
                });
            } catch (error) {
                finish(attempt, 'Failed', processStartFailure(error).reasonCode);
                return read({ status: 'Started' });
            }
            var child = attempt.child;
            attempt.processStatus = 'Spawned';
            child.on('error', function (error) {
                if (!active(attempt) || attempt.status !== 'Running') {
                    return;
                }
                if (typeof child.pid === 'number' && child.pid > 1) {
                    stop(attempt, 'ProcessError');
                } else {
                    finish(attempt, 'Failed', processStartFailure(error).reasonCode);
                    closePipes(attempt);
                }
            });
            child.on('exit', function (code, signal) {
                if (!active(attempt)) {
                    return;
                }
                attempt.exit = observeExit(code, signal);
                attempt.processStatus = 'Exited';
                attempt.status = 'Stopping';
                attempt.inputStatus = 'Closed';
                clearTimers(attempt);
                // Never signal a former PID after exit. Bound only our pipe handles, not surviving descendants.
                attempt.drainTimer = timers.setTimeout(function () {
                    if (active(attempt)) {
                        finish(attempt, 'Closed', 'OutputDrainDeadline');
                        closePipes(attempt);
                    }
                }, 3000);
            });
            child.on('close', function (code, signal) {
                if (active(attempt)) {
                    var observed = observeExit(code, signal);
                    if (observed.status === 'Observed') {
                        attempt.exit = observed;
                    }
                    finish(attempt, 'Closed');
                }
            });
            if (!child.stdin || typeof child.stdin.write !== 'function' || typeof child.stdin.on !== 'function' ||
                    !child.stdout || typeof child.stdout.on !== 'function' ||
                    !child.stderr || typeof child.stderr.on !== 'function') {
                stop(attempt, 'ShellPipesUnavailable');
                return read({ status: 'Started' });
            }
            ['stdout', 'stderr'].forEach(function (name) {
                child[name].on('data', function (chunk) { capture(attempt, name, chunk); });
                child[name].on('error', function () { stop(attempt, 'OutputReadFailed'); });
            });
            child.stdin.on('error', function () { stop(attempt, 'InputWriteFailed'); });
            child.stdin.on('drain', function () {
                if (state === attempt && attempt.status === 'Running') {
                    attempt.inputStatus = 'Ready';
                }
            });
            attempt.inputStatus = 'Ready';
            renewIdle(attempt);
            attempt.lifetimeTimer = timers.setTimeout(function () {
                if (active(attempt) && attempt.status === 'Running') {
                    stop(attempt, 'SessionExpired');
                }
            }, settings.sessionTimeoutMs);
            return read({ status: 'Started' });
        }

        function validInteger(value) {
            return typeof value === 'number' && isFinite(value) && Math.floor(value) === value &&
                value >= 0 && value < 9007199254740991;
        }

        function act(request) {
            if (!request || typeof request !== 'object' || Array.isArray(request)) {
                return rejected('InvalidAction');
            }
            if (typeof request.token !== 'string' || request.token !== token) {
                return rejected('CapabilityRequired');
            }
            var action = request.action;
            var keys = action === 'input' ? ['token', 'action', 'sessionId', 'sequence', 'command'] : ['token', 'action', 'sessionId'];
            if (['start', 'input', 'stop'].indexOf(action) < 0 || Object.keys(request).length !== keys.length ||
                    Object.keys(request).some(function (name) { return keys.indexOf(name) < 0; }) ||
                    !validInteger(request.sessionId)) {
                return rejected('InvalidAction');
            }
            if (action === 'start' && state.id > 0 && request.sessionId === state.id - 1) {
                return read({ status: 'Replay' });
            }
            if (request.sessionId !== state.id) {
                return rejected('StaleSession');
            }
            if (action === 'start') {
                if (state.status !== 'NotStarted' && state.status !== 'Closed' && state.status !== 'Failed') {
                    return rejected('ShellAlreadyActive');
                }
                return start();
            }
            if (action === 'stop') {
                if (state.status === 'Stopping' && state.processStatus !== 'Exited' && state.termination.status === 'RequestFailed') {
                    stop(state, 'UserStopped', true);
                    return read({ status: 'Stopped' });
                }
                if (state.status === 'Stopping' || state.status === 'Closed' || state.status === 'Failed') {
                    return read({ status: 'Replay' });
                }
                if (state.status !== 'Running') {
                    return rejected('ShellNotRunning');
                }
                stop(state, 'UserStopped');
                return read({ status: 'Stopped' });
            }
            if (!validInteger(request.sequence) || request.sequence < 1 || typeof request.command !== 'string' ||
                    !/\S/.test(request.command) || request.command.indexOf('\u0000') >= 0 ||
                    Buffer.byteLength(request.command, 'utf8') > settings.maxInputBytes) {
                return rejected('InvalidCommand');
            }
            if (state.lastInput.status === 'Submitted' && request.sequence === state.lastInput.sequence) {
                return state.lastInput.command === request.command ? read({ status: 'Replay' }) : rejected('ConflictingReplay');
            }
            if (state.status !== 'Running' || state.inputStatus !== 'Ready') {
                return rejected('InputNotReady');
            }
            if (request.sequence !== state.nextInputSequence) {
                return rejected('UnexpectedSequence');
            }
            var attempt = state;
            // Consume the sequence before the write; uncertainty never causes an automatic second write.
            attempt.lastInput = { status: 'Submitted', sequence: request.sequence, command: request.command };
            attempt.nextInputSequence += 1;
            renewIdle(attempt);
            try {
                var writable = attempt.child.stdin.write(request.command + '\n', 'utf8', function (error) {
                    if (error) {
                        stop(attempt, 'InputWriteFailed');
                    }
                });
                if (state === attempt && attempt.status === 'Running' && writable === false) {
                    attempt.inputStatus = 'Backpressured';
                }
            } catch (error) {
                stop(attempt, 'InputWriteFailed');
            }
            if (state === attempt && attempt.status === 'Stopping' && attempt.reasonCode === 'InputWriteFailed') {
                return rejected('InputWriteFailed');
            }
            return read({ status: 'Written' });
        }

        return { read: read, act: act };
    }

    var shellAvailability;
    try {
        var tokenBytes = require('crypto').randomBytes(32);
        if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) {
            throw new Error('SecureShellTokenUnavailable');
        }
        shellAvailability = { status: 'Available', shell: createShell(shellSettings, tokenBytes.toString('hex'), require('process')) };
    } catch (error) {
        shellAvailability = { status: 'Unavailable' };
    }

    var identityCheck = createIdentityCheck(identitySettings);
    var report = collectSnapshot();
    var responseBody = JSON.stringify(report);
    if (Buffer.byteLength(responseBody, 'utf8') > MAX_REPORT_BYTES) {
        throw new Error('RuntimeIdentityReportTooLarge');
    }

    var http = require('http');

    // One optional outbound link delegates jobs to the existing loopback shell route.
    function createPcLink() {
        var state = { status: 'Disabled' };

        function privateAddress(value) {
            if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) {
                return false;
            }
            var parts = value.split('.').map(Number);
            return parts.every(function (part) { return part <= 255; }) &&
                (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168));
        }

        function current(attempt) {
            return state === attempt && (attempt.status === 'Pairing' || attempt.status === 'Connected');
        }

        function abortRequest(pending) {
            if (pending.client && typeof pending.client.abort === 'function') {
                try { pending.client.abort(); } catch (error) { /* Cancellation is best effort. */ }
            }
            if (pending.response && typeof pending.response.destroy === 'function') {
                try { pending.response.destroy(); } catch (error) { /* Cancellation is best effort. */ }
            }
        }

        function cancel(attempt) {
            ['wait', 'expiry'].forEach(function (name) {
                if (attempt[name] && attempt[name].status === 'Scheduled') {
                    timers.clearTimeout(attempt[name].timer);
                }
                attempt[name] = { status: 'None' };
            });
            if (attempt.request && attempt.request.status === 'Pending') {
                var pending = attempt.request;
                pending.status = 'Cancelled';
                if (pending.deadline) {
                    timers.clearTimeout(pending.deadline);
                }
                abortRequest(pending);
            }
            attempt.request = { status: 'None' };
            delete attempt.token;
        }

        function fail(attempt, reason) {
            if (!current(attempt)) {
                return;
            }
            attempt.status = 'Failed';
            attempt.reasonCode = reason;
            cancel(attempt);
        }

        function read() {
            var observed = { status: state.status };
            ['reasonCode', 'pcAddress', 'expiresAtUtc'].forEach(function (name) {
                if (Object.prototype.hasOwnProperty.call(state, name)) {
                    observed[name] = state[name];
                }
            });
            return { moduleId: MODULE_ID, schemaVersion: 1, pcLink: observed };
        }

        function jsonRequest(attempt, options, payload, callback) {
            if (!current(attempt)) {
                return;
            }
            if (attempt.request.status !== 'None') {
                fail(attempt, 'ConcurrentRequest');
                return;
            }
            var pending = { status: 'Pending' };
            attempt.request = pending;
            var body;
            function finish(outcome) {
                if (pending.status !== 'Pending' || !current(attempt)) {
                    return;
                }
                pending.status = 'Completed';
                if (pending.deadline) {
                    timers.clearTimeout(pending.deadline);
                }
                attempt.request = { status: 'None' };
                if (outcome.status !== 'Received') {
                    abortRequest(pending);
                }
                callback(outcome);
            }
            function unavailable(reason) {
                finish({ status: 'Unavailable', reasonCode: reason });
            }
            try {
                if (typeof payload !== 'undefined') {
                    body = JSON.stringify(payload);
                    if (Buffer.byteLength(body, 'utf8') > 263168) {
                        unavailable('RequestTooLarge');
                        return;
                    }
                    options.headers['Content-Type'] = 'application/json';
                    options.headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
                }
                options.agent = false;
                options.headers.Connection = 'close';
                pending.client = http.request(options, function (response) {
                    if (pending.status !== 'Pending' || !current(attempt)) {
                        if (typeof response.destroy === 'function') {
                            response.destroy();
                        }
                        return;
                    }
                    pending.response = response;
                    var chunks = [];
                    var bytes = 0;
                    response.on('data', function (chunk) {
                        if (pending.status !== 'Pending' || !current(attempt)) {
                            return;
                        }
                        if (!Buffer.isBuffer(chunk) || bytes + chunk.length > 262144) {
                            unavailable('ResponseTooLargeOrInvalid');
                            return;
                        }
                        chunks.push(chunk);
                        bytes += chunk.length;
                    });
                    response.on('error', function () { unavailable('ResponseFailed'); });
                    response.on('aborted', function () { unavailable('ResponseAborted'); });
                    response.on('close', function () { unavailable('ResponseClosed'); });
                    response.on('end', function () {
                        if (pending.status !== 'Pending' || !current(attempt)) {
                            return;
                        }
                        var value;
                        try {
                            value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
                        } catch (error) {
                            unavailable('InvalidResponseJson');
                            return;
                        }
                        if (!value || typeof value !== 'object' || Array.isArray(value) ||
                                typeof response.statusCode !== 'number' || response.statusCode < 100 || response.statusCode > 599) {
                            unavailable('InvalidResponse');
                            return;
                        }
                        finish({ status: 'Received', statusCode: response.statusCode, body: value });
                    });
                });
                pending.client.on('error', function () { unavailable('RequestFailed'); });
                pending.deadline = timers.setTimeout(function () { unavailable('RequestTimedOut'); }, 3000);
                pending.client.end(body);
            } catch (error) {
                unavailable('RequestFailed');
            }
        }

        function brokerOptions(attempt, method, path) {
            var headers = {};
            if (attempt.status === 'Connected') {
                headers.Authorization = 'Bearer ' + attempt.token;
            }
            return { hostname: attempt.pcAddress, port: 18766, method: method, path: path, headers: headers };
        }

        function schedulePoll(attempt) {
            if (!current(attempt) || attempt.status !== 'Connected') {
                return;
            }
            var scheduled = { status: 'Scheduled' };
            attempt.wait = scheduled;
            scheduled.timer = timers.setTimeout(function () {
                if (!current(attempt) || attempt.wait !== scheduled) {
                    return;
                }
                attempt.wait = { status: 'None' };
                poll(attempt);
            }, 500);
        }

        function validJob(job) {
            if (!job || typeof job !== 'object' || Array.isArray(job) ||
                    typeof job.id !== 'number' || !isFinite(job.id) || Math.floor(job.id) !== job.id ||
                    job.id < 1 || job.id > 9007199254740991 || job.path !== SHELL_PATH ||
                    ['GET', 'POST'].indexOf(job.method) < 0 || Buffer.byteLength(JSON.stringify(job), 'utf8') > 32768) {
                return false;
            }
            return job.method === 'GET' ? job.body === null :
                (job.body && typeof job.body === 'object' && !Array.isArray(job.body) &&
                Buffer.byteLength(JSON.stringify(job.body), 'utf8') <= MAX_SHELL_BODY_BYTES);
        }

        function poll(attempt) {
            jsonRequest(attempt, brokerOptions(attempt, 'GET', '/v1/jobs'), undefined, function (outcome) {
                if (outcome.status !== 'Received' || outcome.statusCode !== 200) {
                    fail(attempt, outcome.reasonCode || 'JobsRejected');
                    return;
                }
                if (outcome.body.job === null) {
                    schedulePoll(attempt);
                    return;
                }
                var job = outcome.body.job;
                if (!validJob(job)) {
                    fail(attempt, 'InvalidJob');
                    return;
                }
                if (Object.prototype.hasOwnProperty.call(attempt.seen, String(job.id))) {
                    fail(attempt, 'DuplicateJob');
                    return;
                }
                // Reserve before issuing the request: delivery errors must never replay an action.
                attempt.seen[String(job.id)] = true;
                jsonRequest(attempt, {
                    hostname: '127.0.0.1', port: PORT, method: job.method, path: SHELL_PATH,
                    headers: { Host: '127.0.0.1:' + PORT, Origin: 'http://127.0.0.1:8081' }
                }, job.method === 'POST' ? job.body : undefined, function (forwarded) {
                    if (forwarded.status !== 'Received') {
                        fail(attempt, forwarded.reasonCode || 'ForwardFailed');
                        return;
                    }
                    jsonRequest(attempt, brokerOptions(attempt, 'POST', '/v1/results'), {
                        id: job.id, statusCode: forwarded.statusCode, body: forwarded.body
                    }, function (acknowledgement) {
                        if (acknowledgement.status !== 'Received' || acknowledgement.statusCode !== 200) {
                            fail(attempt, acknowledgement.reasonCode || 'ResultRejected');
                            return;
                        }
                        if (['Accepted', 'Expired', 'Duplicate'].indexOf(acknowledgement.body.status) < 0) {
                            fail(attempt, 'InvalidResultAcknowledgement');
                            return;
                        }
                        schedulePoll(attempt);
                    });
                });
            });
        }

        function act(action) {
            if (!action || typeof action !== 'object' || Array.isArray(action)) {
                return { statusCode: 400, body: { error: 'InvalidPcLinkAction' } };
            }
            var keys = Object.keys(action).sort().join(',');
            if (action.action === 'disable' && keys === 'action') {
                var previous = state;
                state = { status: 'Disabled' };
                cancel(previous);
                return { statusCode: 200, body: read() };
            }
            if (action.action !== 'enable' || keys !== 'action,pairCode,pcAddress' ||
                    !privateAddress(action.pcAddress) || typeof action.pairCode !== 'string' || !/^[0-9]{8}$/.test(action.pairCode)) {
                return { statusCode: 400, body: { error: 'InvalidPcLinkAction' } };
            }
            if (state.status === 'Pairing' || state.status === 'Connected') {
                return { statusCode: 409, body: { error: 'PcLinkAlreadyActive' } };
            }
            var attempt = { status: 'Pairing', pcAddress: action.pcAddress, request: { status: 'None' },
                wait: { status: 'None' }, expiry: { status: 'None' }, seen: Object.create(null) };
            state = attempt;
            jsonRequest(attempt, brokerOptions(attempt, 'POST', '/v1/pair'), {
                code: action.pairCode, moduleId: MODULE_ID, schemaVersion: 1
            }, function (paired) {
                if (paired.status !== 'Received' || paired.statusCode !== 200) {
                    fail(attempt, paired.reasonCode || 'PairingRejected');
                    return;
                }
                var response = paired.body;
                var expiry = typeof response.expiresAtUtc === 'string' ? Date.parse(response.expiresAtUtc) : NaN;
                // Bound the local lifetime even when the two device clocks differ.
                var remaining = Math.min(expiry - Date.now(), 900000);
                if (response.moduleId !== 'tizenbrew-pc-link' || response.schemaVersion !== 1 ||
                        typeof response.token !== 'string' || !/^[a-f0-9]{64}$/.test(response.token) ||
                        !isFinite(remaining) || remaining <= 0 ||
                        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(response.expiresAtUtc)) {
                    fail(attempt, 'InvalidPairingResponse');
                    return;
                }
                attempt.status = 'Connected';
                attempt.token = response.token;
                attempt.expiresAtUtc = response.expiresAtUtc;
                attempt.expiry = { status: 'Scheduled', timer: timers.setTimeout(function () {
                    fail(attempt, 'LinkExpired');
                }, remaining) };
                schedulePoll(attempt);
            });
            return { statusCode: 200, body: read() };
        }

        return { read: read, act: act };
    }

    var pcLink = createPcLink();
    var lifecycle = Object.freeze({ status: 'Starting' });
    var allowedOrigins = ['http://127.0.0.1:8081', 'http://localhost:8081'];
    var allowedHosts = ['127.0.0.1:' + PORT, 'localhost:' + PORT];

    function reply(response, statusCode, body) {
        response.statusCode = statusCode;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Connection', 'close');
        response.end(body);
    }

    function pcLinkRequest(request, response) {
        if (typeof request.headers.origin === 'undefined') {
            reply(response, 403, '{"error":"OriginRequired"}');
            return;
        }
        if (request.method === 'OPTIONS') {
            var headers = request.headers['access-control-request-headers'];
            if (request.headers['access-control-request-method'] !== 'POST' ||
                    (typeof headers !== 'undefined' &&
                    (typeof headers !== 'string' || headers.toLowerCase().trim() !== 'content-type'))) {
                reply(response, 403, '{"error":"PreflightNotAllowed"}');
                return;
            }
            response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.setHeader('Access-Control-Max-Age', '300');
            reply(response, 204, '');
            return;
        }
        if (request.method === 'GET') {
            reply(response, 200, JSON.stringify(pcLink.read()));
            return;
        }
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'GET, POST, OPTIONS');
            reply(response, 405, '{"error":"MethodNotAllowed"}');
            return;
        }
        if (typeof request.headers['content-type'] !== 'string' ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) {
            reply(response, 415, '{"error":"JsonRequired"}');
            return;
        }
        var length = request.headers['content-length'];
        if (typeof length !== 'undefined' &&
                (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 2048)) {
            reply(response, 413, '{"error":"BodyTooLargeOrInvalid"}');
            return;
        }
        var bodyState = 'Reading';
        var chunks = [];
        var bytes = 0;
        request.on('data', function (chunk) {
            if (bodyState !== 'Reading') {
                return;
            }
            if (!Buffer.isBuffer(chunk) || bytes + chunk.length > 2048) {
                bodyState = 'Rejected';
                chunks = [];
                reply(response, 413, '{"error":"BodyTooLargeOrInvalid"}');
                return;
            }
            chunks.push(chunk);
            bytes += chunk.length;
        });
        request.on('aborted', function () { bodyState = 'Aborted'; chunks = []; });
        request.on('error', function () {
            if (bodyState === 'Reading') {
                bodyState = 'Rejected';
                chunks = [];
                reply(response, 400, '{"error":"BodyReadFailed"}');
            }
        });
        request.on('end', function () {
            if (bodyState !== 'Reading') {
                return;
            }
            bodyState = 'Complete';
            var action;
            try {
                action = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
            } catch (error) {
                reply(response, 400, '{"error":"InvalidJson"}');
                return;
            }
            var outcome = pcLink.act(action);
            reply(response, outcome.statusCode, JSON.stringify(outcome.body));
        });
    }

    function shellRequest(request, response) {
        if (typeof request.headers.origin === 'undefined') {
            reply(response, 403, '{"error":"OriginRequired"}');
            return;
        }
        if (request.method === 'OPTIONS') {
            var requestedHeaders = request.headers['access-control-request-headers'];
            if (request.headers['access-control-request-method'] !== 'POST' ||
                    (typeof requestedHeaders !== 'undefined' &&
                    (typeof requestedHeaders !== 'string' || requestedHeaders.toLowerCase().trim() !== 'content-type'))) {
                reply(response, 403, '{"error":"PreflightNotAllowed"}');
                return;
            }
            response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.setHeader('Access-Control-Max-Age', '300');
            reply(response, 204, '');
            return;
        }
        if (request.method !== 'GET' && request.method !== 'POST') {
            response.setHeader('Allow', 'GET, POST, OPTIONS');
            reply(response, 405, '{"error":"MethodNotAllowed"}');
            return;
        }
        if (shellAvailability.status !== 'Available') {
            reply(response, 503, '{"error":"ShellUnavailable"}');
            return;
        }
        if (request.method === 'GET') {
            reply(response, 200, JSON.stringify(shellAvailability.shell.read()));
            return;
        }
        if (typeof request.headers['content-type'] !== 'string' ||
                !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) {
            reply(response, 415, '{"error":"JsonRequired"}');
            return;
        }
        var length = request.headers['content-length'];
        if (typeof length !== 'undefined' &&
                (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_SHELL_BODY_BYTES)) {
            reply(response, 413, '{"error":"BodyTooLargeOrInvalid"}');
            return;
        }
        var bodyState = 'Reading';
        var bytes = 0;
        var chunks = [];
        request.on('data', function (chunk) {
            if (bodyState !== 'Reading') {
                return;
            }
            if (!Buffer.isBuffer(chunk) || bytes + chunk.length > MAX_SHELL_BODY_BYTES) {
                bodyState = 'Rejected';
                chunks = [];
                reply(response, 413, '{"error":"BodyTooLargeOrInvalid"}');
                return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
        });
        request.on('aborted', function () { bodyState = 'Aborted'; chunks = []; });
        request.on('error', function () {
            if (bodyState === 'Reading') {
                bodyState = 'Rejected';
                chunks = [];
                reply(response, 400, '{"error":"BodyReadFailed"}');
            }
        });
        request.on('end', function () {
            if (bodyState !== 'Reading') {
                return;
            }
            bodyState = 'Complete';
            var payload;
            try {
                payload = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
            } catch (error) {
                reply(response, 400, '{"error":"InvalidJson"}');
                return;
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                reply(response, 400, '{"error":"InvalidAction"}');
                return;
            }
            var result = shellAvailability.shell.act(payload);
            if (result.outcome.status === 'Rejected' && result.outcome.reasonCode === 'CapabilityRequired') {
                reply(response, 403, '{"error":"CapabilityRequired"}');
                return;
            }
            reply(response, 200, JSON.stringify(result));
        });
    }

    var server = http.createServer(function (request, response) {
        if (allowedHosts.indexOf(request.headers.host) < 0) {
            reply(response, 403, '{"error":"HostNotAllowed"}');
            return;
        }
        var origin = request.headers.origin;
        if (typeof origin !== 'undefined') {
            if (allowedOrigins.indexOf(origin) < 0) {
                reply(response, 403, '{"error":"OriginNotAllowed"}');
                return;
            }
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Vary', 'Origin');
        }
        if (request.url === PC_LINK_PATH) {
            pcLinkRequest(request, response);
            return;
        }
        if (request.url === SHELL_PATH) {
            shellRequest(request, response);
            return;
        }
        if (request.url === CHECK_PATH) {
            if (request.method !== 'GET' && request.method !== 'POST') {
                response.setHeader('Allow', 'GET, POST');
                reply(response, 405, '{"error":"MethodNotAllowed"}');
                return;
            }
            if (request.method === 'POST' && typeof origin === 'undefined') {
                reply(response, 403, '{"error":"OriginRequired"}');
                return;
            }
            if (request.method === 'POST' &&
                    (typeof request.headers['transfer-encoding'] !== 'undefined' ||
                    (typeof request.headers['content-length'] !== 'undefined' && request.headers['content-length'] !== '0'))) {
                reply(response, 400, '{"error":"BodyNotAccepted"}');
                return;
            }
            var check = request.method === 'POST' ? identityCheck.start() : identityCheck.read();
            reply(response, check.result.status === 'Running' && request.method === 'POST' ? 202 : 200,
                JSON.stringify(check));
            return;
        }
        if (request.url !== REPORT_PATH) {
            reply(response, 404, '{"error":"NotFound"}');
            return;
        }
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            reply(response, 405, '{"error":"MethodNotAllowed"}');
            return;
        }
        reply(response, 200, responseBody);
    });

    server.maxHeadersCount = 32;
    server.setTimeout(3000, function (socket) { socket.destroy(); });
    server.on('listening', function () {
        lifecycle = Object.freeze({ status: 'Listening' });
        console.log('Runtime Identity: report listener ready on loopback.');
    });
    server.on('error', function (error) {
        var reason = error && error.code === 'EADDRINUSE' ? 'PortInUse' : 'TransportFailure';
        lifecycle = Object.freeze({ status: 'Failed', reasonCode: reason });
        console.log('Runtime Identity: report listener failed (' + reason + ').');
    });
    server.on('close', function () {
        if (lifecycle.status !== 'Failed') {
            lifecycle = Object.freeze({ status: 'Closed' });
        }
    });

    module.exports = {
        getTransportStatus: function () { return lifecycle; }
    };

    server.listen(PORT, '127.0.0.1');
    server.unref();
}());
