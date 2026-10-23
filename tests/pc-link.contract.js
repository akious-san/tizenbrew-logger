/*
 * Local-only relay contract fixtures. Every HTTP connection, subprocess and
 * timer exposed to service.js is synthetic. This file never imports a host
 * network or child_process module and never contacts a TV or PC.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var EventEmitter = require('events').EventEmitter;
var serviceSource = fs.readFileSync(__dirname + '/../service.js', 'utf8');
var cases = [];
var PC = '192.168.1.23';
var CODE = '12345678';
var TOKEN = new Array(65).join('a');

function test(name, check) { cases.push({ name: name, check: check }); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function bytes(value) { return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); }

function harness(options) {
    options = options || {};
    var handler;
    var outbound = [];
    var spawnCalls = [];
    var timers = [];
    var clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };
    var server = new EventEmitter();
    server.listen = function (port, address) {
        server.port = port;
        server.address = address;
        server.emit('listening');
        return server;
    };
    server.unref = function () { return server; };
    server.setTimeout = function () { return server; };

    function FakeDate(value) { return new Date(arguments.length ? value : clock.now); }
    FakeDate.now = function () { return clock.now; };
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    FakeDate.prototype = Date.prototype;

    function outgoing(settings, callback) {
        assert.strictEqual(typeof settings, 'object', 'Outbound requests must use explicit connection settings.');
        assert.strictEqual(typeof callback, 'function');
        if (options.requestThrows) { throw new Error('SyntheticRequestFailure'); }
        var request = new EventEmitter();
        request.options = plain(settings);
        request.writes = [];
        request.ended = false;
        request.aborted = false;
        request.write = function (chunk) { request.writes.push(bytes(chunk)); return true; };
        request.end = function (chunk) {
            if (typeof chunk !== 'undefined') { request.write(chunk); }
            request.ended = true;
            request.body = Buffer.concat(request.writes).toString('utf8');
        };
        request.abort = function () { request.aborted = true; };
        request.destroy = function () { request.aborted = true; };
        request.setTimeout = function (delay, timeoutCallback) {
            request.timeoutMs = delay;
            if (timeoutCallback) { request.on('timeout', timeoutCallback); }
            return request;
        };
        request.beginResponse = function (statusCode, headers) {
            assert.strictEqual(request.ended, true, 'A response cannot precede request completion.');
            var response = new EventEmitter();
            response.statusCode = statusCode;
            response.headers = headers || {};
            response.destroyed = false;
            response.setEncoding = function (encoding) { response.encoding = encoding; };
            response.destroy = function () { response.destroyed = true; };
            response.push = function (chunk) {
                var raw = bytes(chunk);
                response.emit('data', response.encoding === 'utf8' ? raw.toString('utf8') : raw);
            };
            request.response = response;
            callback(response);
            return response;
        };
        request.respond = function (statusCode, body, headers) {
            var response = request.beginResponse(statusCode, headers);
            if (typeof body !== 'undefined') { response.push(typeof body === 'string' ? body : JSON.stringify(body)); }
            response.emit('end');
            return response;
        };
        outbound.push(request);
        return request;
    }

    var context = {
        require: function (name) {
            if (name === 'http') {
                return {
                    createServer: function (next) { handler = next; return server; },
                    request: outgoing
                };
            }
            if (name === 'timers') { return { setTimeout: context.setTimeout, clearTimeout: context.clearTimeout }; }
            if (name === 'crypto') { return { randomBytes: function (size) { return Buffer.alloc(size, 7); } }; }
            if (name === 'process') { return context.process; }
            if (name === 'child_process') {
                return {
                    spawn: function () {
                        spawnCalls.push(Array.prototype.slice.call(arguments));
                        throw new Error('A relay fixture must never start a subprocess.');
                    }
                };
            }
            throw new Error('Unexpected VM dependency: ' + name);
        },
        module: { exports: {} },
        Buffer: Buffer,
        Date: FakeDate,
        console: { log: function () {} },
        process: { version: 'v4.4.3', platform: 'linux', arch: 'arm', getuid: function () { return 5001; }, getgid: function () { return 100; } },
        tizen: {
            application: { getAppInfo: function () { return { id: 'example.StandaloneService', packageId: 'example' }; } },
            systeminfo: { getCapability: function (name) { return name === 'http://tizen.org/feature/platform.version' ? '3.0' : false; } }
        },
        setTimeout: function (callback, delay) {
            var timer = { callback: callback, delay: delay, due: clock.now + delay, cleared: false, fired: false };
            timer.unref = function () { return timer; };
            timer.ref = function () { return timer; };
            timers.push(timer);
            return timer;
        },
        clearTimeout: function (timer) { if (timer) { timer.cleared = true; } }
    };
    vm.runInNewContext(serviceSource, context, { filename: 'service.js' });
    assert.strictEqual(typeof handler, 'function');
    assert.strictEqual(server.port, 18765);
    assert.strictEqual(server.address, '127.0.0.1');

    function local(method, payload, overrides, route, rawChunks) {
        var incoming = new EventEmitter();
        var raw = typeof payload === 'undefined' ? '' : JSON.stringify(payload);
        incoming.method = method;
        incoming.url = route || '/v1/pc-link';
        incoming.headers = { host: '127.0.0.1:18765', origin: 'http://127.0.0.1:8081' };
        if (method === 'POST') {
            incoming.headers['content-type'] = 'application/json';
            incoming.headers['content-length'] = String(Buffer.byteLength(raw, 'utf8'));
        }
        Object.keys(overrides || {}).forEach(function (key) {
            if (overrides[key] === null) { delete incoming.headers[key]; }
            else { incoming.headers[key] = overrides[key]; }
        });
        incoming.resume = function () {};
        incoming.destroy = function () { incoming.destroyed = true; };
        incoming.setEncoding = function (encoding) { incoming.encoding = encoding; };
        var response = {
            headers: {}, ended: false, statusCode: 200,
            setHeader: function (name, value) { response.headers[name] = value; },
            end: function (body) { response.ended = true; response.body = body || ''; }
        };
        handler(incoming, response);
        if (method === 'POST' || typeof rawChunks !== 'undefined') {
            var chunks = typeof rawChunks === 'undefined' ? [raw] : rawChunks;
            chunks.forEach(function (chunk) { incoming.emit('data', bytes(chunk)); });
            incoming.emit('end');
        }
        assert.strictEqual(response.ended, true, 'A completed local request must receive a response.');
        response.json = response.body ? JSON.parse(response.body) : {};
        return response;
    }

    function advance(milliseconds) {
        var target = clock.now + milliseconds;
        var count = 0;
        while (true) {
            var active = timers.filter(function (timer) { return !timer.cleared && !timer.fired && timer.due <= target; })
                .sort(function (left, right) { return left.due - right.due; });
            if (!active.length) { break; }
            assert(count < 2000, 'Synthetic timer progression must be bounded.');
            count += 1;
            active[0].fired = true;
            clock.now = active[0].due;
            active[0].callback();
        }
        clock.now = target;
    }

    function byPath(path) { return outbound.filter(function (request) { return request.options.path === path; }); }
    function read() {
        var response = local('GET');
        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.json.moduleId, 'tizenbrew-runtime-identity');
        assert.strictEqual(response.json.schemaVersion, 1);
        return response.json;
    }
    function enable(address, code) { return local('POST', { action: 'enable', pcAddress: address || PC, pairCode: code || CODE }); }
    function pair(expiry, token) {
        var request = byPath('/v1/pair').slice(-1)[0];
        assert(request, 'An explicit enable must request pairing.');
        request.respond(200, { moduleId: 'tizenbrew-pc-link', schemaVersion: 1, token: token || TOKEN,
            expiresAtUtc: new Date(clock.now + (typeof expiry === 'number' ? expiry : 900000)).toISOString() });
        return request;
    }
    return {
        local: local, read: read, enable: enable, pair: pair, advance: advance, byPath: byPath,
        outbound: outbound, spawnCalls: spawnCalls, timers: timers, clock: clock
    };
}

function state(subject) { return subject.read().pcLink; }
function connected() {
    var subject = harness();
    assert(subject.enable().statusCode < 300);
    subject.pair();
    assert.strictEqual(state(subject).status, 'Connected');
    return subject;
}
function poll(subject) {
    var before = subject.byPath('/v1/jobs').length;
    subject.advance(500);
    assert.strictEqual(subject.byPath('/v1/jobs').length, before + 1, 'Exactly one poll may be scheduled.');
    return subject.byPath('/v1/jobs').slice(-1)[0];
}
function job(id, method, body) {
    var value = { id: id, method: method || 'GET', path: '/v1/shell', body: null };
    if (typeof body !== 'undefined') { value.body = body; }
    return value;
}
function deliveredJob(subject, next) { poll(subject).respond(200, { job: next }); return subject.byPath('/v1/shell').slice(-1)[0]; }
function failStopped(subject) {
    assert.strictEqual(state(subject).status, 'Failed');
    var count = subject.outbound.length;
    subject.advance(16000);
    assert.strictEqual(subject.outbound.length, count, 'Failure must stop polling and must not replay a request.');
    assert.strictEqual(subject.spawnCalls.length, 0);
}

test('Loading, reading and disabling the relay never opens a connection or starts a shell', function () {
    var subject = harness();
    assert.strictEqual(state(subject).status, 'Disabled');
    subject.read();
    subject.local('POST', { action: 'disable' });
    subject.advance(1000000);
    assert.strictEqual(state(subject).status, 'Disabled');
    assert.deepStrictEqual(subject.outbound, []);
    assert.deepStrictEqual(subject.spawnCalls, []);
});

test('The local relay boundary requires exact permitted Origin and Host on reads and writes', function () {
    var rejected = [
        { origin: null }, { origin: 'null' }, { origin: 'https://example.test' },
        { origin: 'http://127.0.0.1:8081.evil.test' }, { origin: 'http://127.0.0.1:8081/' },
        { host: '192.168.1.23:18765' }, { host: '127.0.0.1:18765.evil.test' }, { host: null }
    ];
    ['GET', 'POST'].forEach(function (method) {
        rejected.forEach(function (headers) {
            var subject = harness();
            var response = subject.local(method, method === 'POST' ? { action: 'enable', pcAddress: PC, pairCode: CODE } : undefined, headers);
            assert(response.statusCode >= 400 && response.statusCode < 500);
            assert.strictEqual(subject.outbound.length, 0);
        });
    });
    var allowed = harness();
    assert.strictEqual(allowed.local('GET', undefined, { host: 'localhost:18765', origin: 'http://localhost:8081' }).statusCode, 200);
});

test('Alternate routes and methods cannot trigger pairing', function () {
    ['/v1/pc-link/', '/v1/pc-link?enable=true', '/v1/pc-link#enable'].forEach(function (route) {
        var subject = harness();
        assert(subject.local('POST', { action: 'enable', pcAddress: PC, pairCode: CODE }, {}, route).statusCode >= 400);
        assert.strictEqual(subject.outbound.length, 0);
    });
    ['PUT', 'DELETE', 'PATCH'].forEach(function (method) {
        var subject = harness();
        assert.strictEqual(subject.local(method).statusCode, 405);
        assert.strictEqual(subject.outbound.length, 0);
    });
});

test('Preflight permits only the JSON POST contract and never enables the relay', function () {
    var subject = harness();
    var allowed = subject.local('OPTIONS', undefined, {
        'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'
    });
    assert.strictEqual(allowed.statusCode, 204);
    assert.strictEqual(allowed.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:8081');
    assert.strictEqual(allowed.headers['Access-Control-Allow-Headers'], 'Content-Type');
    ['authorization', 'content-type, authorization', 'x-forwarded-host'].forEach(function (headers) {
        assert.strictEqual(subject.local('OPTIONS', undefined, {
            'access-control-request-method': 'POST', 'access-control-request-headers': headers
        }).statusCode, 403);
    });
    assert.strictEqual(subject.local('OPTIONS', undefined, { 'access-control-request-method': 'DELETE' }).statusCode, 403);
    assert.strictEqual(subject.outbound.length, 0);
});

test('Malformed, non-JSON and oversized local bodies are rejected without consuming enable', function () {
    var selection = { action: 'enable', pcAddress: PC, pairCode: CODE };
    [
        { headers: { 'content-type': null }, status: 415 },
        { headers: { 'content-type': 'text/plain' }, status: 415 },
        { headers: { 'content-length': '2049' }, status: 413 },
        { headers: { 'content-length': '-1' }, status: 413 },
        { headers: { 'content-length': 'not-a-length' }, status: 413 },
        { headers: { 'content-length': null }, chunks: ['{not-json'], status: 400 },
        { headers: { 'content-length': null }, chunks: [Buffer.alloc(1024, 65), Buffer.alloc(1025, 65)], status: 413 }
    ].forEach(function (invalid) {
        var subject = harness();
        assert.strictEqual(subject.local('POST', selection, invalid.headers, undefined, invalid.chunks).statusCode, invalid.status);
        assert.strictEqual(state(subject).status, 'Disabled');
        assert.strictEqual(subject.outbound.length, 0);
        subject.enable();
        assert.strictEqual(subject.byPath('/v1/pair').length, 1, 'Rejected transport input must not consume an explicit enable.');
    });
});

test('Invalid action shapes do not disable or replace an existing connection', function () {
    var subject = connected();
    [null, [], { action: 'other' }, { action: 'disable', token: TOKEN },
        { action: 'enable', pcAddress: PC, pairCode: CODE, url: 'http://example.test' }].forEach(function (payload) {
        assert.strictEqual(subject.local('POST', payload).statusCode, 400);
        assert.strictEqual(state(subject).status, 'Connected');
        assert.strictEqual(subject.outbound.length, 1);
    });
    assert.strictEqual(subject.enable('10.0.0.23', '87654321').statusCode, 409);
    assert.strictEqual(subject.outbound.length, 1, 'An active link requires an explicit disable before replacement.');
    assert.strictEqual(subject.outbound[0].aborted, false);
});

test('Only canonical RFC1918 IPv4 addresses and eight digit pairing codes pass construction', function () {
    var invalidAddresses = ['127.0.0.1', '169.254.1.2', '172.15.1.2', '172.32.1.2', '192.169.1.2', '8.8.8.8',
        'localhost', '192.168.1.23:18766', 'http://192.168.1.23', '192.168.1.23/path', '192.168.01.23',
        '192.168.1.256', '10.1.2', '10.1.2.3\n', ' 10.1.2.3', '10.1.2.3.evil.test', '::ffff:192.168.1.23'];
    invalidAddresses.forEach(function (address) {
        var subject = harness();
        var response = subject.enable(address);
        assert(response.statusCode >= 400 || response.json.outcome.status === 'Rejected', address);
        assert.strictEqual(state(subject).status, 'Disabled');
        assert.strictEqual(subject.outbound.length, 0);
    });
    ['1234567', '123456789', 'abcdefgh', '1234567\n', '12345678 ', 12345678, null].forEach(function (code) {
        var subject = harness();
        var response = subject.local('POST', { action: 'enable', pcAddress: PC, pairCode: code });
        assert(response.statusCode >= 400 || response.json.outcome.status === 'Rejected');
        assert.strictEqual(subject.outbound.length, 0);
    });
    ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.255.254'].forEach(function (address) {
        var subject = harness();
        subject.enable(address);
        assert.strictEqual(subject.byPath('/v1/pair').length, 1, address);
    });
});

test('Enable sends the fixed pair endpoint and a minimal body without a shell side effect', function () {
    var subject = harness();
    subject.enable();
    assert.strictEqual(state(subject).status, 'Pairing');
    assert.strictEqual(subject.outbound.length, 1);
    var request = subject.outbound[0];
    assert.strictEqual(request.options.hostname || request.options.host, PC);
    assert.strictEqual(request.options.port, 18766);
    assert.strictEqual(request.options.method, 'POST');
    assert.strictEqual(request.options.path, '/v1/pair');
    assert.deepStrictEqual(JSON.parse(request.body), { code: CODE, moduleId: 'tizenbrew-runtime-identity', schemaVersion: 1 });
    assert.strictEqual(subject.spawnCalls.length, 0);
    assert.strictEqual(JSON.stringify(subject.read()).indexOf(CODE), -1, 'The code must not be disclosed by status.');
    subject.pair();
    assert.strictEqual(state(subject).status, 'Connected');
    assert.strictEqual(JSON.stringify(subject.read()).indexOf(TOKEN), -1, 'Bearer capability must remain private to the relay.');
});

test('A paired link polls serially at 500ms and authenticates only to the paired PC', function () {
    var subject = connected();
    subject.advance(499);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 0);
    var request = poll(subject);
    assert.strictEqual(request.options.hostname || request.options.host, PC);
    assert.strictEqual(request.options.port, 18766);
    assert.strictEqual(request.options.method, 'GET');
    assert.strictEqual(request.options.headers.Authorization || request.options.headers.authorization, 'Bearer ' + TOKEN);
    subject.advance(500);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 1, 'A pending poll cannot overlap a new poll.');
    request.respond(200, { job: null });
    subject.advance(499);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 1);
    subject.advance(1);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 2);
});

test('A GET job forwards only the exact local shell endpoint and returns its observed response', function () {
    var subject = connected();
    var forward = deliveredJob(subject, job(1));
    assert(forward);
    assert.strictEqual(forward.options.hostname || forward.options.host, '127.0.0.1');
    assert.strictEqual(forward.options.port, 18765);
    assert.strictEqual(forward.options.method, 'GET');
    assert.strictEqual(forward.options.headers.Origin || forward.options.headers.origin, 'http://127.0.0.1:8081');
    assert.strictEqual(forward.options.headers.Host || forward.options.headers.host, '127.0.0.1:18765');
    assert.strictEqual(typeof (forward.options.headers.Authorization || forward.options.headers.authorization), 'undefined', 'The PC token must not leak to a local service.');
    var body = JSON.stringify({ session: { status: 'NotStarted' } });
    forward.respond(200, body);
    var result = subject.byPath('/v1/results')[0];
    assert(result);
    assert.strictEqual(result.options.method, 'POST');
    assert.strictEqual(result.options.headers.Authorization || result.options.headers.authorization, 'Bearer ' + TOKEN);
    assert.deepStrictEqual(JSON.parse(result.body), { id: 1, statusCode: 200, body: JSON.parse(body) });
    subject.advance(500);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 1, 'The next poll must wait for result acknowledgment.');
    result.respond(200, { status: 'Accepted' });
    subject.advance(500);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 2);
    assert.strictEqual(subject.spawnCalls.length, 0, 'Forwarding a request must not execute a command in the relay itself.');
});

test('An explicit POST job preserves its shell action body without interpreting commands', function () {
    var subject = connected();
    var payload = { action: 'input', token: new Array(65).join('b'), sessionId: 1, sequence: 2, command: 'printf "fixture-marker"' };
    var forward = deliveredJob(subject, job(2, 'POST', payload));
    assert(forward);
    assert.strictEqual(forward.options.method, 'POST');
    assert.deepStrictEqual(JSON.parse(forward.body), payload);
    assert.strictEqual(subject.spawnCalls.length, 0);
    forward.respond(403, '{"error":"CapabilityRequired"}');
    assert.deepStrictEqual(JSON.parse(subject.byPath('/v1/results')[0].body), { id: 2, statusCode: 403, body: { error: 'CapabilityRequired' } });
});

test('An acknowledged job cannot be replayed through polling', function () {
    var subject = connected();
    deliveredJob(subject, job(3)).respond(200, '{}');
    subject.byPath('/v1/results')[0].respond(200, { status: 'Accepted' });
    poll(subject).respond(200, { job: job(3) });
    assert.strictEqual(subject.byPath('/v1/shell').length, 1);
    failStopped(subject);
});

test('Conflicting replay of a job ID never substitutes a second shell action', function () {
    var subject = connected();
    deliveredJob(subject, job(3)).respond(200, '{}');
    subject.byPath('/v1/results')[0].respond(200, { status: 'Accepted' });
    poll(subject).respond(200, { job: job(3, 'POST', { action: 'start' }) });
    assert.strictEqual(subject.byPath('/v1/shell').length, 1);
    failStopped(subject);
});

test('Accepted, Expired and Duplicate acknowledgments resume polling without repeating an action', function () {
    ['Accepted', 'Expired', 'Duplicate'].forEach(function (acknowledgment) {
        var subject = connected();
        deliveredJob(subject, job(12)).respond(200, { fixtureMarker: acknowledgment });
        var result = subject.byPath('/v1/results')[0];
        result.respond(200, { status: acknowledgment });
        assert.strictEqual(state(subject).status, 'Connected', acknowledgment);
        assert.strictEqual(subject.byPath('/v1/shell').length, 1);
        assert.strictEqual(subject.byPath('/v1/results').length, 1);
        var next = poll(subject);
        next.respond(200, { job: null });
        assert.strictEqual(subject.byPath('/v1/shell').length, 1, 'Acknowledgments never trigger another execution.');
        assert.strictEqual(subject.byPath('/v1/results').length, 1, 'Acknowledgments never resubmit a result.');
    });
});

test('Missing or unrecognized result acknowledgment status stops without replay', function () {
    [{}, { status: 'accepted' }, { status: 'Rejected' }, { status: null }, { status: 200 }].forEach(function (acknowledgment) {
        var subject = connected();
        deliveredJob(subject, job(13)).respond(200, { fixtureMarker: 'single-result' });
        subject.byPath('/v1/results')[0].respond(200, acknowledgment);
        assert.strictEqual(state(subject).reasonCode, 'InvalidResultAcknowledgement');
        failStopped(subject);
        assert.strictEqual(subject.byPath('/v1/shell').length, 1);
        assert.strictEqual(subject.byPath('/v1/results').length, 1);
    });
});

test('Remote jobs cannot select a URL, another route, or a non-GET/POST method', function () {
    var invalid = [
        { id: 9, method: 'GET', path: 'http://example.test/v1/shell', body: null },
        { id: 9, method: 'GET', path: '//example.test/v1/shell', body: null },
        { id: 9, method: 'GET', path: '/v1/report', body: null },
        { id: 9, method: 'GET', path: '/v1/shell?run=true', body: null },
        { id: 9, method: 'GET', path: '/v1/shell/', body: null },
        { id: 9, method: 'PUT', path: '/v1/shell', body: null },
        { id: 9, method: 'POST', path: '/v1/shell', body: 'console.log("fixture")' },
        { id: 9, method: 'GET', path: '/v1/shell', body: { action: 'start' } }
    ];
    invalid.forEach(function (next) {
        var subject = connected();
        poll(subject).respond(200, { job: next });
        assert.strictEqual(subject.byPath('/v1/shell').length, 0, JSON.stringify(next));
        failStopped(subject);
    });
});

test('Additional remote fields cannot override the canonical loopback request', function () {
    var subject = connected();
    var next = job(10);
    next.headers = { Host: 'example.test', Origin: 'http://example.test', Authorization: 'Bearer remote-marker' };
    next.url = 'http://example.test/';
    next.hostname = 'example.test';
    next.port = 80;
    var forward = deliveredJob(subject, next);
    assert(forward);
    assert.strictEqual(forward.options.hostname, '127.0.0.1');
    assert.strictEqual(forward.options.port, 18765);
    assert.strictEqual(forward.options.path, '/v1/shell');
    assert.deepStrictEqual(forward.options.headers, {
        Host: '127.0.0.1:18765', Origin: 'http://127.0.0.1:8081', Connection: 'close'
    });
    assert.strictEqual(subject.outbound.some(function (request) { return request.options.hostname === 'example.test'; }), false);
});

test('Remote job identities must be positive safe integers before reserving an action', function () {
    [0, -1, 0.5, 9007199254740992, '1', null].forEach(function (id) {
        var subject = connected();
        poll(subject).respond(200, { job: job(id) });
        assert.strictEqual(subject.byPath('/v1/shell').length, 0);
        failStopped(subject);
    });
});

test('Invalid pairing capabilities and lifetimes never start polling', function () {
    [
        { token: 'short', offset: 900000 }, { token: TOKEN.toUpperCase(), offset: 900000 },
        { token: TOKEN, offset: 0 }, { token: TOKEN, offset: -1 }
    ].forEach(function (invalid) {
        var subject = harness();
        subject.enable();
        subject.pair(invalid.offset, invalid.token);
        assert.strictEqual(subject.byPath('/v1/jobs').length, 0);
        failStopped(subject);
    });
});

test('A pairing response must identify the expected broker contract', function () {
    [
        { moduleId: 'other-service', schemaVersion: 1 },
        { moduleId: 'tizenbrew-pc-link', schemaVersion: 2 },
        { moduleId: 'tizenbrew-pc-link', schemaVersion: '1' },
        { moduleId: 'tizenbrew-pc-link' }
    ].forEach(function (identity) {
        var subject = harness();
        subject.enable();
        identity.token = TOKEN;
        identity.expiresAtUtc = new Date(subject.clock.now + 900000).toISOString();
        subject.byPath('/v1/pair')[0].respond(200, identity);
        failStopped(subject);
        assert.strictEqual(subject.byPath('/v1/jobs').length, 0);
    });
});

test('A distant broker clock cannot extend local relay ownership beyond fifteen minutes', function () {
    var subject = harness();
    subject.enable();
    subject.pair(86400000);
    assert.strictEqual(state(subject).status, 'Connected');
    var expiry = subject.timers.filter(function (timer) { return !timer.cleared && timer.delay === 900000; });
    assert.strictEqual(expiry.length, 1, 'The local expiry must clamp the broker lifetime to fifteen minutes.');
    expiry[0].fired = true;
    subject.clock.now = expiry[0].due;
    expiry[0].callback();
    failStopped(subject);
});

test('The paired lifetime expires even when the current poll has no response', function () {
    var subject = harness();
    subject.enable();
    subject.pair(750);
    var pending = poll(subject);
    subject.advance(250);
    assert.strictEqual(pending.aborted, true);
    failStopped(subject);
    pending.respond(200, { job: job(4) });
    assert.strictEqual(subject.byPath('/v1/shell').length, 0);
});

test('Pair, poll, local forward and result transport failures stop without retrying', function () {
    ['pair', 'poll', 'forward', 'result'].forEach(function (phase) {
        var subject = phase === 'pair' ? harness() : connected();
        var pending;
        if (phase === 'pair') { subject.enable(); pending = subject.byPath('/v1/pair')[0]; }
        else if (phase === 'poll') { pending = poll(subject); }
        else {
            pending = deliveredJob(subject, job(5));
            if (phase === 'result') { pending.respond(200, '{}'); pending = subject.byPath('/v1/results')[0]; }
        }
        pending.emit('error', new Error('SyntheticTransportFailure'));
        failStopped(subject);
        pending.emit('error', new Error('DuplicateTransportFailure'));
        assert.strictEqual(subject.byPath('/v1/shell').length, phase === 'forward' || phase === 'result' ? 1 : 0);
    });
});

test('A synchronous request creation failure has a readable failed outcome without retry', function () {
    var subject = harness({ requestThrows: true });
    subject.enable();
    failStopped(subject);
    assert.strictEqual(subject.outbound.length, 0);
});

test('Every outbound stage has an absolute deadline and a timed-out action is never retried', function () {
    ['pair', 'poll', 'forward', 'result'].forEach(function (phase) {
        var subject = phase === 'pair' ? harness() : connected();
        var pending;
        if (phase === 'pair') { subject.enable(); pending = subject.byPath('/v1/pair')[0]; }
        else if (phase === 'poll') { pending = poll(subject); }
        else {
            pending = deliveredJob(subject, job(6));
            if (phase === 'result') { pending.respond(200, '{}'); pending = subject.byPath('/v1/results')[0]; }
        }
        subject.advance(3000);
        assert.strictEqual(pending.aborted, true, phase);
        failStopped(subject);
    });
});

test('HTTP rejection, malformed responses and interrupted responses fail closed', function () {
    [
        function (request) { request.respond(403, '{}'); },
        function (request) { request.respond(200, '{invalid-json'); },
        function (request) { request.respond(200, '[]'); },
        function (request) { var response = request.beginResponse(200); response.push('{'); response.emit('aborted'); },
        function (request) { var response = request.beginResponse(200); response.emit('error', new Error('SyntheticResponseFailure')); }
    ].forEach(function (deliver) {
        var subject = connected();
        deliver(poll(subject));
        failStopped(subject);
        assert.strictEqual(subject.byPath('/v1/shell').length, 0);
    });
});

test('Late close and error events cannot replace an already received response', function () {
    var subject = connected();
    var request = poll(subject);
    var response = request.respond(200, { job: null });
    response.emit('close');
    response.emit('error', new Error('LateResponseError'));
    request.emit('error', new Error('LateRequestError'));
    assert.strictEqual(state(subject).status, 'Connected');
    subject.advance(500);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 2);
});

test('Remote data and local shell response buffers have finite byte bounds', function () {
    ['pair', 'poll', 'forward', 'result'].forEach(function (phase) {
        var subject = phase === 'pair' ? harness() : connected();
        var pending;
        if (phase === 'pair') { subject.enable(); pending = subject.byPath('/v1/pair')[0]; }
        else if (phase === 'poll') { pending = poll(subject); }
        else {
            pending = deliveredJob(subject, job(7));
            if (phase === 'result') { pending.respond(200, '{}'); pending = subject.byPath('/v1/results')[0]; }
        }
        var response = pending.beginResponse(200);
        response.push(Buffer.alloc(1048576, 65));
        response.emit('end');
        assert.strictEqual(response.destroyed || pending.aborted, true, phase);
        failStopped(subject);
    });
});

test('Disabling while pairing cancels ownership and ignores late success', function () {
    var subject = harness();
    subject.enable();
    var pending = subject.byPath('/v1/pair')[0];
    subject.local('POST', { action: 'disable' });
    assert.strictEqual(pending.aborted, true);
    pending.respond(200, { moduleId: 'tizenbrew-pc-link', schemaVersion: 1, token: TOKEN,
        expiresAtUtc: new Date(subject.clock.now + 900000).toISOString() });
    subject.advance(10000);
    assert.strictEqual(state(subject).status, 'Disabled');
    assert.strictEqual(subject.outbound.length, 1);
});

test('Disabling during a forwarded action prevents results and further polls', function () {
    var subject = connected();
    var pending = deliveredJob(subject, job(8));
    subject.local('POST', { action: 'disable' });
    assert.strictEqual(pending.aborted, true);
    pending.respond(200, '{"late":true}');
    subject.advance(10000);
    assert.strictEqual(state(subject).status, 'Disabled');
    assert.strictEqual(subject.byPath('/v1/results').length, 0);
    assert.strictEqual(subject.byPath('/v1/jobs').length, 1);
});

test('Re-enabling creates a new generation which stale pair and error callbacks cannot overwrite', function () {
    var subject = harness();
    subject.enable();
    var oldPair = subject.byPath('/v1/pair')[0];
    subject.local('POST', { action: 'disable' });
    subject.enable('10.0.0.24', '87654321');
    assert.strictEqual(oldPair.aborted, true);
    var newPair = subject.byPath('/v1/pair')[1];
    assert(newPair);
    newPair.respond(200, { moduleId: 'tizenbrew-pc-link', schemaVersion: 1, token: new Array(65).join('c'),
        expiresAtUtc: new Date(subject.clock.now + 900000).toISOString() });
    oldPair.respond(200, { moduleId: 'tizenbrew-pc-link', schemaVersion: 1, token: TOKEN,
        expiresAtUtc: new Date(subject.clock.now + 900000).toISOString() });
    oldPair.emit('error', new Error('LateOldGenerationError'));
    assert.strictEqual(state(subject).status, 'Connected');
    var next = poll(subject);
    assert.strictEqual(next.options.hostname || next.options.host, '10.0.0.24');
    assert.strictEqual(next.options.headers.Authorization || next.options.headers.authorization, 'Bearer ' + new Array(65).join('c'));
    assert.strictEqual(subject.byPath('/v1/jobs').length, 1);
});

test('A previous generation cannot publish shell output into a new PC connection', function () {
    var subject = connected();
    var oldForward = deliveredJob(subject, job(11));
    subject.local('POST', { action: 'disable' });
    subject.enable('10.0.0.24', '87654321');
    subject.pair(900000, new Array(65).join('c'));
    oldForward.respond(200, { fixtureMarker: 'old-generation-output' });
    oldForward.emit('error', new Error('LateOldForwardError'));
    assert.strictEqual(state(subject).status, 'Connected');
    assert.strictEqual(subject.byPath('/v1/results').length, 0);
    var next = poll(subject);
    assert.strictEqual(next.options.hostname, '10.0.0.24');
    assert.strictEqual(subject.outbound.some(function (request) { return request.body.indexOf('old-generation-output') >= 0; }), false);
});

var failures = [];
cases.forEach(function (entry) {
    try { entry.check(); console.log('PASS ' + entry.name); }
    catch (error) { failures.push(entry.name); console.error('FAIL ' + entry.name + ': ' + error.message); }
});
assert.strictEqual(failures.length, 0, failures.length + ' PC-link contract case(s) failed.');
console.log('Completed ' + cases.length + ' synthetic PC-link contract cases.');
