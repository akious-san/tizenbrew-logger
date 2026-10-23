/* TizenBrew evaluates serviceFile directly; no onStart export is invoked. */
(function () {
    'use strict';

    var MODULE_ID = 'tizenbrew-runtime-identity';
    var REPORT_PATH = '/v1/report';
    var PORT = 18765;
    var MAX_REPORT_BYTES = 16384;
    var runtime = typeof process === 'undefined' ? {} : process;
    var platform = typeof tizen === 'undefined' ? {} : tizen;

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
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            reply(response, 405, '{"error":"MethodNotAllowed"}');
            return;
        }
        if (request.url !== REPORT_PATH) {
            reply(response, 404, '{"error":"NotFound"}');
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
