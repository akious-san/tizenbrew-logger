/*
 * Deferred synthetic contract checks. This file has not been executed by the agent.
 * The VM receives fake HTTP, subprocesses and timers. Never import the host's
 * child_process module here, even when extending these checks.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var EventEmitter = require('events').EventEmitter;
var serviceSource = fs.readFileSync(__dirname + '/../service.js', 'utf8');
var cases = [];

function test(name, check) {
    cases.push({ name: name, check: check });
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function repeated(character, length) {
    return new Array(length + 1).join(character);
}

function errorWithCode(code) {
    var error = new Error('Synthetic subprocess error');
    error.code = code;
    return error;
}

function fakeStream() {
    var stream = new EventEmitter();
    stream.destroyed = false;
    stream.destroy = function () { stream.destroyed = true; };
    return stream;
}

function harness(options) {
    options = options || {};
    var requestHandler;
    var spawnCalls = [];
    var timers = [];
    var child = new EventEmitter();
    child.stdout = fakeStream();
    child.stderr = fakeStream();
    child.stdin = null;
    child.killCalls = [];
    child.kill = function (signal) {
        child.killCalls.push(signal);
        if (options.killThrows) {
            throw new Error('Synthetic termination request failure');
        }
        return options.killResult !== false;
    };

    var server = new EventEmitter();
    server.listen = function (port, address) {
        server.port = port;
        server.address = address;
        server.emit('listening');
        return server;
    };
    server.unref = function () { return server; };
    server.setTimeout = function () { return server; };

    var fakeHttp = {
        createServer: function (handler) {
            assert.strictEqual(typeof handler, 'function');
            requestHandler = handler;
            return server;
        }
    };
    var fakeChildProcess = {
        spawn: function (file, args, spawnOptions) {
            spawnCalls.push({ file: file, args: plain(args), options: plain(spawnOptions) });
            if (options.spawnThrows) {
                throw errorWithCode(options.spawnThrows);
            }
            return child;
        }
    };
    var context = {
        require: function (name) {
            if (name === 'http') {
                return fakeHttp;
            }
            if (name === 'timers') {
                return { setTimeout: context.setTimeout, clearTimeout: context.clearTimeout };
            }
            if (name === 'child_process') {
                if (options.moduleUnavailable) {
                    throw errorWithCode('MODULE_NOT_FOUND');
                }
                return fakeChildProcess;
            }
            throw new Error('Unexpected VM dependency: ' + name);
        },
        module: { exports: {} },
        console: { log: function () {} },
        Buffer: Buffer,
        process: {
            version: 'v4.4.3',
            platform: 'linux',
            arch: 'arm',
            getuid: function () { return 5001; },
            getgid: function () { return 100; }
        },
        tizen: {
            application: {
                getAppInfo: function () {
                    return { id: 'example.StandaloneService', packageId: 'example' };
                }
            },
            systeminfo: {
                getCapability: function (name) {
                    return name === 'http://tizen.org/feature/platform.version' ? '3.0' : false;
                }
            }
        },
        setTimeout: function (callback, delay) {
            var timer = {
                callback: callback,
                delay: delay,
                cleared: false,
                fired: false,
                unref: function () { return timer; },
                ref: function () { return timer; }
            };
            timers.push(timer);
            return timer;
        },
        clearTimeout: function (timer) {
            if (timer) {
                timer.cleared = true;
            }
        }
    };

    vm.runInNewContext(serviceSource, context, { filename: 'service.js' });
    assert.strictEqual(typeof requestHandler, 'function', 'The service must install its HTTP adapter.');
    assert.strictEqual(server.port, 18765);
    assert.strictEqual(server.address, '127.0.0.1', 'The listener must remain on loopback.');

    function request(method, route, overrides) {
        var headers = {
            host: '127.0.0.1:18765',
            origin: 'http://127.0.0.1:8081'
        };
        Object.keys(overrides || {}).forEach(function (name) {
            if (overrides[name] === null) {
                delete headers[name];
            } else {
                headers[name] = overrides[name];
            }
        });
        var incoming = new EventEmitter();
        incoming.method = method;
        incoming.url = route;
        incoming.headers = headers;
        incoming.resume = function () {};
        incoming.destroy = function () {};
        var response = {
            statusCode: 200,
            headers: {},
            ended: false,
            setHeader: function (name, value) { response.headers[name] = value; },
            end: function (body) {
                response.ended = true;
                response.body = body || '';
            }
        };
        requestHandler(incoming, response);
        assert.strictEqual(response.ended, true, 'HTTP requests must receive an immediate response.');
        return response;
    }

    function envelope(method, headers) {
        var response = request(method || 'GET', '/v1/id-check', headers);
        assert(response.statusCode >= 200 && response.statusCode < 300, 'Expected an accepted check-state response.');
        var body = JSON.parse(response.body);
        assert.strictEqual(body.moduleId, 'tizenbrew-runtime-identity');
        assert.strictEqual(body.schemaVersion, 1);
        assert.strictEqual(body.checkId, 'fixed-posix-id');
        assert.deepStrictEqual(body.command, {
            file: '/usr/bin/id',
            args: [],
            timeoutMs: 3000,
            maxOutputBytesPerStream: 4096
        });
        assert(body.result && typeof body.result === 'object');
        return body;
    }

    function fireDeadline() {
        var active = timers.filter(function (timer) {
            return timer.delay === 3000 && !timer.cleared && !timer.fired;
        });
        assert.strictEqual(active.length, 1, 'One active identity-check deadline is required.');
        active[0].fired = true;
        active[0].callback();
    }

    return {
        request: request,
        envelope: envelope,
        state: function () { return envelope('GET').result; },
        start: function (headers) { return envelope('POST', headers).result; },
        fireDeadline: fireDeadline,
        spawnCalls: spawnCalls,
        child: child,
        timers: timers
    };
}

function timestamp(value) {
    assert.strictEqual(typeof value, 'string');
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
    assert(!isNaN(Date.parse(value)));
}

function terminal(result, expectedStatus) {
    assert.strictEqual(result.status, expectedStatus);
    timestamp(result.startedAtUtc);
    timestamp(result.completedAtUtc);
    ['stdout', 'stderr'].forEach(function (name) {
        assert(result[name] && typeof result[name] === 'object');
        assert.strictEqual(typeof result[name].text, 'string');
        assert.strictEqual(typeof result[name].bytes, 'number');
        assert(result[name].bytes >= 0 && result[name].bytes <= 4096);
        assert.strictEqual(Math.floor(result[name].bytes), result[name].bytes);
    });
    assert(result.exit && typeof result.exit === 'object');
    assert(result.termination && typeof result.termination === 'object');
}

function rejectedWithoutStarting(method, route, headers) {
    var subject = harness();
    var response = subject.request(method, route, headers);
    assert(response.statusCode >= 400 && response.statusCode < 500);
    assert.strictEqual(subject.state().status, 'NotRun');
    assert.strictEqual(subject.spawnCalls.length, 0);
    subject.start();
    assert.strictEqual(subject.spawnCalls.length, 1, 'A rejected request must not consume the one attempt.');
}

test('Loading the service and GET requests never start the fixed command', function () {
    var subject = harness();
    assert.strictEqual(subject.spawnCalls.length, 0);
    var initial = subject.state();
    assert.strictEqual(initial.status, 'NotRun');
    ['startedAtUtc', 'completedAtUtc', 'stdout', 'stderr', 'exit', 'termination'].forEach(function (name) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(initial, name), false);
    });
    subject.envelope('GET');
    var report = subject.request('GET', '/v1/report');
    assert.strictEqual(report.statusCode, 200);
    assert.strictEqual(subject.spawnCalls.length, 0);
});

test('POST requires an exact permitted Origin and Host', function () {
    rejectedWithoutStarting('POST', '/v1/id-check', { origin: null });
    rejectedWithoutStarting('POST', '/v1/id-check', { origin: 'null' });
    rejectedWithoutStarting('POST', '/v1/id-check', { origin: 'https://example.test' });
    rejectedWithoutStarting('POST', '/v1/id-check', { origin: 'http://127.0.0.1:8081.evil.test' });
    rejectedWithoutStarting('POST', '/v1/id-check', { host: '192.0.2.1:18765' });
    var localhost = harness();
    assert.strictEqual(localhost.start({ origin: 'http://localhost:8081' }).status, 'Running');
    assert.strictEqual(localhost.spawnCalls.length, 1);
});

test('Bodies, transfer encoding, alternate paths and query strings are rejected before starting', function () {
    rejectedWithoutStarting('POST', '/v1/id-check', { 'content-length': '1' });
    rejectedWithoutStarting('POST', '/v1/id-check', { 'transfer-encoding': 'chunked' });
    rejectedWithoutStarting('POST', '/v1/id-check', { 'content-length': '0', 'transfer-encoding': 'chunked' });
    rejectedWithoutStarting('POST', '/v1/id-check?file=/bin/sh');
    rejectedWithoutStarting('POST', '/v1/id-check/');
    rejectedWithoutStarting('GET', '/v1/id-check?run=true');
    rejectedWithoutStarting('PUT', '/v1/id-check');
});

test('One empty POST starts only the fixed executable, arguments and direct-process pipes', function () {
    var subject = harness();
    var running = subject.start({ 'content-length': '0' });
    assert.strictEqual(running.status, 'Running');
    timestamp(running.startedAtUtc);
    assert.strictEqual(subject.spawnCalls.length, 1);
    assert.strictEqual(subject.spawnCalls[0].file, '/usr/bin/id');
    assert.deepStrictEqual(subject.spawnCalls[0].args, []);
    assert.deepStrictEqual(subject.spawnCalls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.notStrictEqual(subject.spawnCalls[0].options.shell, true);
    assert.deepStrictEqual(subject.start(), running);
    assert.deepStrictEqual(subject.state(), running);
    assert.strictEqual(subject.spawnCalls.length, 1);
});

test('Success waits for stream closure, captures output and caches the result', function () {
    var subject = harness();
    var running = subject.start();
    var output = 'uid=5001(owner) gid=100(users)\n';
    subject.child.stdout.emit('data', new Buffer(output, 'utf8'));
    subject.child.emit('exit', 0, null);
    assert.strictEqual(subject.state().status, 'Running', 'exit is not proof that output has drained.');
    subject.child.emit('close', 0, null);
    var completed = subject.state();
    terminal(completed, 'Succeeded');
    assert.strictEqual(completed.startedAtUtc, running.startedAtUtc);
    assert.deepStrictEqual(completed.stdout, { bytes: Buffer.byteLength(output, 'utf8'), text: output });
    assert.deepStrictEqual(completed.stderr, { bytes: 0, text: '' });
    assert.deepStrictEqual(completed.exit, { status: 'Observed', kind: 'Code', value: 0 });
    assert.deepStrictEqual(completed.termination, { status: 'NotRequested' });
    assert.deepStrictEqual(subject.start(), completed);
    assert.strictEqual(subject.spawnCalls.length, 1);
});

['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].forEach(function (code) {
    test('A start error ' + code + ' has an explicit cached outcome', function () {
        var subject = harness();
        subject.start();
        subject.child.emit('error', errorWithCode(code));
        var result = subject.state();
        terminal(result, code === 'ENOENT' || code === 'ENOTDIR' ? 'Unavailable' : 'Denied');
        assert.deepStrictEqual(result.exit, { status: 'NotObserved' });
        assert.deepStrictEqual(result.termination, { status: 'NotRequested' });
        subject.child.emit('close', -1, null);
        assert.deepStrictEqual(subject.state(), result, 'Late close must not rewrite a start failure.');
        assert.deepStrictEqual(subject.start(), result);
        assert.strictEqual(subject.spawnCalls.length, 1);
    });
});

test('Nonzero exit and signal termination are explicit failures', function () {
    var nonzero = harness();
    nonzero.start();
    nonzero.child.stderr.emit('data', new Buffer('identity unavailable\n', 'utf8'));
    nonzero.child.emit('close', 1, null);
    var nonzeroResult = nonzero.state();
    terminal(nonzeroResult, 'Failed');
    assert.deepStrictEqual(nonzeroResult.exit, { status: 'Observed', kind: 'Code', value: 1 });
    assert.strictEqual(nonzeroResult.stderr.text, 'identity unavailable\n');
    assert.deepStrictEqual(nonzeroResult.termination, { status: 'NotRequested' });

    var signalled = harness();
    signalled.start();
    signalled.child.emit('close', null, 'SIGTERM');
    var signalResult = signalled.state();
    terminal(signalResult, 'Failed');
    assert.deepStrictEqual(signalResult.exit, { status: 'Observed', kind: 'Signal', value: 'SIGTERM' });
});

test('Timeout requests SIGKILL and finalizes without waiting for or misreporting termination', function () {
    var subject = harness();
    subject.start();
    subject.fireDeadline();
    var result = subject.state();
    terminal(result, 'TimedOut');
    assert.deepStrictEqual(subject.child.killCalls, ['SIGKILL']);
    assert.deepStrictEqual(result.exit, { status: 'NotObserved' });
    assert.deepStrictEqual(result.termination, { status: 'Requested', signal: 'SIGKILL' });
    subject.child.stdout.emit('data', new Buffer('late output', 'utf8'));
    subject.child.emit('error', errorWithCode('EIO'));
    subject.child.emit('close', null, 'SIGKILL');
    assert.deepStrictEqual(subject.state(), result);
    assert.deepStrictEqual(subject.start(), result);
    assert.strictEqual(subject.spawnCalls.length, 1);
});

['stdout', 'stderr'].forEach(function (name) {
    test(name + ' retains a 4096-byte prefix and finalizes on the next raw byte', function () {
        var subject = harness();
        subject.start();
        subject.child[name].emit('data', new Buffer(repeated('x', 4095), 'utf8'));
        assert.strictEqual(subject.state().status, 'Running');
        subject.child[name].emit('data', new Buffer('yz', 'utf8'));
        var result = subject.state();
        terminal(result, 'OutputLimitExceeded');
        assert.strictEqual(result[name].bytes, 4096);
        assert.strictEqual(result[name].text, repeated('x', 4095) + 'y');
        assert.deepStrictEqual(result.exit, { status: 'NotObserved' });
        assert.deepStrictEqual(result.termination, { status: 'Requested', signal: 'SIGKILL' });
        assert.deepStrictEqual(subject.child.killCalls, ['SIGKILL']);
        subject.child[name].emit('data', new Buffer('ignored', 'utf8'));
        subject.child.emit('close', 0, null);
        assert.deepStrictEqual(subject.state(), result);
    });
});

test('Exactly 4096 bytes on each stream is permitted and the limits remain independent', function () {
    var subject = harness();
    subject.start();
    subject.child.stdout.emit('data', new Buffer(repeated('a', 4096), 'utf8'));
    subject.child.stderr.emit('data', new Buffer(repeated('b', 4096), 'utf8'));
    assert.strictEqual(subject.state().status, 'Running');
    subject.child.emit('close', 0, null);
    var result = subject.state();
    terminal(result, 'Succeeded');
    assert.strictEqual(result.stdout.bytes, 4096);
    assert.strictEqual(result.stderr.bytes, 4096);
    assert.strictEqual(subject.child.killCalls.length, 0);
});

test('The output boundary counts raw UTF-8 bytes rather than JavaScript characters', function () {
    var subject = harness();
    subject.start();
    subject.child.stdout.emit('data', new Buffer(repeated('\u00e9', 2048), 'utf8'));
    assert.strictEqual(subject.state().status, 'Running');
    subject.child.stdout.emit('data', new Buffer('!', 'utf8'));
    var result = subject.state();
    terminal(result, 'OutputLimitExceeded');
    assert.strictEqual(result.stdout.bytes, 4096);
    assert.strictEqual(result.stdout.text, repeated('\u00e9', 2048));
});

test('A rejected or throwing kill is reported as a request failure, not successful termination', function () {
    [ { killResult: false }, { killThrows: true } ].forEach(function (options) {
        var subject = harness(options);
        subject.start();
        subject.fireDeadline();
        var result = subject.state();
        terminal(result, 'TimedOut');
        assert.strictEqual(result.termination.status, 'RequestFailed');
        assert.strictEqual(result.termination.signal, 'SIGKILL');
        assert.deepStrictEqual(result.exit, { status: 'NotObserved' });
        subject.child.emit('close', 0, null);
        assert.deepStrictEqual(subject.state(), result);
    });
});

test('Unavailable subprocess support and synchronous spawn failure remain bounded outcomes', function () {
    var unavailable = harness({ moduleUnavailable: true });
    var unavailableResult = unavailable.start();
    terminal(unavailableResult, 'Unavailable');
    assert.strictEqual(unavailable.spawnCalls.length, 0);
    assert.deepStrictEqual(unavailable.start(), unavailableResult);

    var failed = harness({ spawnThrows: 'EIO' });
    var failedResult = failed.start();
    terminal(failedResult, 'Failed');
    assert.strictEqual(failed.spawnCalls.length, 1);
    assert.deepStrictEqual(failed.start(), failedResult);
    assert.strictEqual(failed.spawnCalls.length, 1);
});

var failures = [];
cases.forEach(function (entry) {
    try {
        entry.check();
        console.log('PASS ' + entry.name);
    } catch (error) {
        failures.push(entry.name);
        console.error('FAIL ' + entry.name + ': ' + error.message);
    }
});
assert.strictEqual(failures.length, 0, failures.length + ' identity-check contract case(s) failed.');
console.log('Completed ' + cases.length + ' synthetic identity-check contract cases.');
