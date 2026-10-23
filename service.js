/* TizenBrew evaluates serviceFile directly; no onStart export is invoked. */
(function () {
    'use strict';

    var MODULE_ID = 'tizenbrew-runtime-identity';
    var REPORT_PATH = '/v1/report';
    var CHECK_PATH = '/v1/id-check';
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
            var code = error && error.code;
            var status = 'Failed';
            var reason = 'ProcessStartFailed';
            if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'MODULE_NOT_FOUND') {
                status = 'Unavailable';
                reason = 'ExecutableOrRuntimeUnavailable';
            } else if (code === 'EACCES' || code === 'EPERM') {
                status = 'Denied';
                reason = 'ExecutionDenied';
            }
            complete(attempt, status, { status: 'NotObserved' }, { status: 'NotRequested' }, reason);
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
                var exit = { status: 'NotObserved' };
                if (typeof code === 'number' && isFinite(code) && Math.floor(code) === code) {
                    exit = { status: 'Observed', kind: 'Code', value: code };
                } else if (typeof signal === 'string' && /^[A-Z0-9]{1,32}$/.test(signal)) {
                    exit = { status: 'Observed', kind: 'Signal', value: signal };
                }
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

    var identityCheck = createIdentityCheck(identitySettings);
    var report = collectSnapshot();
    var responseBody = JSON.stringify(report);
    if (Buffer.byteLength(responseBody, 'utf8') > MAX_REPORT_BYTES) {
        throw new Error('RuntimeIdentityReportTooLarge');
    }

    var http = require('http');
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
