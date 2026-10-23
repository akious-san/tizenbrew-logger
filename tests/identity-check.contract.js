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
    var children = [];
    var groupKillCalls = [];
    var randomCalls = [];
    var clock = { now: Date.parse('2026-10-23T00:00:00.000Z') };

    function makeChild(pid) {
        var next = new EventEmitter();
        next.pid = pid;
        next.stdout = fakeStream();
        next.stderr = fakeStream();
        next.stdin = fakeStream();
        next.stdin.writable = true;
        next.stdin.writes = [];
        next.stdin.writeCallbacks = [];
        next.stdin.write = function (value, encoding, callback) {
            if (options.writeThrows) {
                throw errorWithCode(options.writeThrows);
            }
            if (typeof encoding === 'function') {
                callback = encoding;
            }
            next.stdin.writes.push(Buffer.isBuffer(value) ? value.toString('utf8') : value);
            if (typeof callback === 'function') {
                if (options.deferWriteCallback) {
                    next.stdin.writeCallbacks.push(callback);
                } else {
                    callback(options.writeCallbackError ? errorWithCode(options.writeCallbackError) : null);
                }
            }
            return options.writeBackpressure !== true;
        };
        next.stdin.end = function () { next.stdin.ended = true; };
        next.killCalls = [];
        next.kill = function (signal) {
            next.killCalls.push(signal);
            if (options.killThrows) {
                throw new Error('Synthetic termination request failure');
            }
            return options.killResult !== false;
        };
        return next;
    }

    var child = makeChild(12001);

    function FakeDate(value) {
        return new Date(arguments.length ? value : clock.now);
    }
    FakeDate.now = function () { return clock.now; };
    FakeDate.parse = Date.parse;
    FakeDate.UTC = Date.UTC;
    FakeDate.prototype = Date.prototype;

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
            var spawned = children.length === 0 ? child : makeChild(12001 + children.length);
            children.push(spawned);
            return spawned;
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
            if (name === 'crypto') {
                return {
                    randomBytes: function (size) {
                        randomCalls.push(size);
                        var bytes = new Buffer(size);
                        bytes.fill(7);
                        return bytes;
                    }
                };
            }
            if (name === 'process') {
                return context.process;
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
        Date: FakeDate,
        process: {
            version: 'v4.4.3',
            platform: 'linux',
            arch: 'arm',
            getuid: function () { return 5001; },
            getgid: function () { return 100; },
            kill: function (pid, signal) {
                groupKillCalls.push({ pid: pid, signal: signal });
                if (options.groupKillThrows) {
                    throw errorWithCode(options.groupKillThrows);
                }
                return true;
            }
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
                due: clock.now + delay,
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

    function request(method, route, overrides, bodyChunks) {
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
        incoming.setEncoding = function (encoding) {
            incoming.encoding = encoding;
            return incoming;
        };
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
        if (typeof bodyChunks !== 'undefined') {
            var chunks = Array.isArray(bodyChunks) ? bodyChunks : [bodyChunks];
            chunks.forEach(function (chunk) {
                var raw = Buffer.isBuffer(chunk) ? chunk : new Buffer(chunk, 'utf8');
                incoming.emit('data', incoming.encoding === 'utf8' ? raw.toString('utf8') : raw);
            });
            incoming.emit('end');
        }
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
        clock.now = active[0].due;
        active[0].callback();
    }

    function advance(milliseconds) {
        var target = clock.now + milliseconds;
        var fired = 0;
        while (true) {
            var active = timers.filter(function (timer) {
                return !timer.cleared && !timer.fired && timer.due <= target;
            }).sort(function (first, second) { return first.due - second.due; });
            if (!active.length) {
                break;
            }
            assert(fired < 100, 'Synthetic timer advancement must remain bounded.');
            fired += 1;
            active[0].fired = true;
            clock.now = active[0].due;
            active[0].callback();
        }
        clock.now = target;
    }

    return {
        request: request,
        envelope: envelope,
        state: function () { return envelope('GET').result; },
        start: function (headers) { return envelope('POST', headers).result; },
        fireDeadline: fireDeadline,
        spawnCalls: spawnCalls,
        child: child,
        children: children,
        groupKillCalls: groupKillCalls,
        randomCalls: randomCalls,
        advance: advance,
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

function shellEnvelope(response) {
    assert(response.statusCode === 200 || response.statusCode === 202);
    var envelope = JSON.parse(response.body);
    assert.strictEqual(envelope.moduleId, 'tizenbrew-runtime-identity');
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.strictEqual(envelope.shellId, 'owner-shell');
    assert.strictEqual(typeof envelope.token, 'string');
    assert(/^[a-f0-9]{64}$/.test(envelope.token));
    assert.deepStrictEqual(envelope.settings, {
        file: '/bin/sh',
        args: ['-s'],
        maxInputBytes: 4096,
        maxOutputBytesPerStream: 16384,
        idleTimeoutMs: 300000,
        sessionTimeoutMs: 900000
    });
    var session = envelope.session;
    assert(session && typeof session === 'object');
    assert.strictEqual(typeof session.id, 'number');
    assert(session.id >= 0 && Math.floor(session.id) === session.id);
    assert(['NotStarted', 'Running', 'Stopping', 'Closed', 'Failed'].indexOf(session.status) >= 0);
    assert(['Ready', 'Backpressured', 'Closed'].indexOf(session.inputStatus) >= 0);
    assert(session.nextInputSequence >= 1 && Math.floor(session.nextInputSequence) === session.nextInputSequence);
    assert(session.lastInput && ['None', 'Submitted'].indexOf(session.lastInput.status) >= 0);
    if (session.lastInput.status === 'None') {
        assert.deepStrictEqual(session.lastInput, { status: 'None' });
    } else {
        assert.strictEqual(typeof session.lastInput.sequence, 'number');
        assert(session.lastInput.sequence >= 1 && Math.floor(session.lastInput.sequence) === session.lastInput.sequence);
        assert.strictEqual(typeof session.lastInput.command, 'string');
        assert(Buffer.byteLength(session.lastInput.command, 'utf8') <= 4096);
        assert.strictEqual(Object.keys(session.lastInput).length, 3);
    }
    ['stdout', 'stderr'].forEach(function (name) {
        var stream = session[name];
        assert(stream && typeof stream.text === 'string');
        assert(stream.bytes >= 0 && stream.bytes <= 16384 && Math.floor(stream.bytes) === stream.bytes);
        assert(stream.text.length <= stream.bytes);
        assert(stream.droppedBytes >= 0 && Math.floor(stream.droppedBytes) === stream.droppedBytes);
    });
    assert(session.exit && session.termination);
    assert(envelope.outcome && ['Read', 'Started', 'Written', 'Stopped', 'Replay', 'Rejected'].indexOf(envelope.outcome.status) >= 0);
    if (envelope.outcome.status === 'Rejected') {
        assert.strictEqual(typeof envelope.outcome.reasonCode, 'string');
        assert(/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(envelope.outcome.reasonCode));
    }
    return envelope;
}

function shellRead(subject, headers) {
    return shellEnvelope(subject.request('GET', '/v1/shell', headers));
}

function shellPost(subject, payload, overrides) {
    var body = JSON.stringify(payload);
    var headers = {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body, 'utf8'))
    };
    Object.keys(overrides || {}).forEach(function (name) { headers[name] = overrides[name]; });
    return subject.request('POST', '/v1/shell', headers, body);
}

function shellAction(subject, token, action, sessionId, sequence, command) {
    var payload = { token: token, action: action, sessionId: sessionId };
    if (action === 'input') {
        payload.sequence = sequence;
        payload.command = command;
    }
    return shellEnvelope(shellPost(subject, payload));
}

function beginShell(subject) {
    var before = shellRead(subject);
    var started = shellAction(subject, before.token, 'start', before.session.id);
    assert.strictEqual(started.outcome.status, 'Started');
    assert.strictEqual(started.session.status, 'Running');
    assert.strictEqual(started.session.id, before.session.id + 1);
    assert.strictEqual(started.session.nextInputSequence, 1);
    assert.strictEqual(started.session.inputStatus, 'Ready');
    timestamp(started.session.startedAtUtc);
    return started;
}

function assertShellRejection(response) {
    if (response.statusCode === 200 || response.statusCode === 202) {
        assert.strictEqual(shellEnvelope(response).outcome.status, 'Rejected');
    } else {
        assert(response.statusCode >= 400 && response.statusCode < 500);
        assert(response.body.length <= 1024, 'Transport errors must stay bounded.');
    }
}

test('Shell reads expose a 32-byte hex token without starting a process or inventing timestamps', function () {
    var subject = harness();
    assert.strictEqual(subject.spawnCalls.length, 0);
    var initial = shellRead(subject);
    assert.strictEqual(initial.outcome.status, 'Read');
    assert.strictEqual(initial.session.id, 0);
    assert.strictEqual(initial.session.status, 'NotStarted');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(initial.session, 'startedAtUtc'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(initial.session, 'completedAtUtc'), false);
    assert.deepStrictEqual(initial.session.stdout, { bytes: 0, text: '', droppedBytes: 0 });
    assert.deepStrictEqual(initial.session.stderr, { bytes: 0, text: '', droppedBytes: 0 });
    assert.deepStrictEqual(initial.session.exit, { status: 'NotObserved' });
    assert.deepStrictEqual(initial.session.termination, { status: 'NotRequested' });
    assert.strictEqual(shellRead(subject).token, initial.token);
    assert.strictEqual(subject.spawnCalls.length, 0);
    assert.strictEqual(subject.randomCalls.length, 1);
    assert.strictEqual(subject.randomCalls[0], 32);
});

test('Shell GET and POST require exact Origin and Host before exposing state or starting', function () {
    var subject = harness();
    [ { origin: null }, { origin: 'null' }, { origin: 'https://example.test' },
        { host: '192.0.2.1:18765' } ].forEach(function (headers) {
        var response = subject.request('GET', '/v1/shell', headers);
        assert(response.statusCode >= 400 && response.statusCode < 500);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(JSON.parse(response.body), 'token'), false);
    });
    var initial = shellRead(subject);
    assert.strictEqual(shellRead(subject, { origin: 'http://localhost:8081' }).session.status, 'NotStarted');
    assertShellRejection(shellPost(subject, { token: initial.token, action: 'start', sessionId: 0 }, { origin: null }));
    assertShellRejection(shellPost(subject, { token: initial.token, action: 'start', sessionId: 0 }, { origin: 'https://example.test' }));
    assert.strictEqual(subject.spawnCalls.length, 0);
});

test('Shell actions reject a missing or incorrect capability without consuming a session', function () {
    var subject = harness();
    var initial = shellRead(subject);
    assertShellRejection(shellPost(subject, { action: 'start', sessionId: 0 }));
    assertShellRejection(shellPost(subject, { token: repeated('0', 64), action: 'start', sessionId: 0 }));
    assertShellRejection(shellPost(subject, { token: {}, action: 'start', sessionId: 0 }));
    assert.strictEqual(shellRead(subject).session.id, 0);
    assert.strictEqual(subject.spawnCalls.length, 0);
    assert.strictEqual(shellAction(subject, initial.token, 'start', 0).session.id, 1);
});

test('Shell JSON bodies are bounded and malformed or wrong-type bodies cannot start anything', function () {
    var subject = harness();
    var initial = shellRead(subject);
    var payload = { token: initial.token, action: 'start', sessionId: 0 };
    assertShellRejection(shellPost(subject, payload, { 'content-type': null }));
    assertShellRejection(shellPost(subject, payload, { 'content-type': 'text/plain' }));
    ['{', '', '[]', 'null'].forEach(function (body) {
        var response = subject.request('POST', '/v1/shell', {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body, 'utf8'))
        }, body);
        assert(response.statusCode >= 400 && response.statusCode < 500);
    });
    var oversized = subject.request('POST', '/v1/shell', {
        'content-type': 'application/json', 'transfer-encoding': 'chunked'
    }, [repeated(' ', 16384), repeated(' ', 16384) + JSON.stringify(payload)]);
    assert(oversized.statusCode >= 400 && oversized.statusCode < 500);
    assert.strictEqual(shellRead(subject).session.id, 0);
    assert.strictEqual(subject.spawnCalls.length, 0);
});

test('Shell preflight permits only the JSON content header and never starts execution', function () {
    var subject = harness();
    var accepted = subject.request('OPTIONS', '/v1/shell', {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type'
    });
    assert(accepted.statusCode >= 200 && accepted.statusCode < 300);
    var rejected = subject.request('OPTIONS', '/v1/shell', {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization'
    });
    assert(rejected.statusCode >= 400 && rejected.statusCode < 500);
    assert.strictEqual(subject.spawnCalls.length, 0);
});

test('Shell start owns one detached piped process and duplicate start replays that session', function () {
    var subject = harness();
    var started = beginShell(subject);
    assert.strictEqual(subject.spawnCalls.length, 1);
    assert.strictEqual(subject.spawnCalls[0].file, '/bin/sh');
    assert.deepStrictEqual(subject.spawnCalls[0].args, ['-s']);
    assert.deepStrictEqual(subject.spawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.strictEqual(subject.spawnCalls[0].options.detached, true);
    var replay = shellAction(subject, started.token, 'start', 0);
    assert.strictEqual(replay.outcome.status, 'Replay');
    assert.strictEqual(replay.session.id, 1);
    assert.strictEqual(subject.spawnCalls.length, 1);
    assert.strictEqual(shellAction(subject, started.token, 'start', 1).outcome.status, 'Rejected');
    assert.strictEqual(subject.spawnCalls.length, 1);
});

test('Shell inputs share stdin and the newest identical sequence never writes twice', function () {
    var subject = harness();
    var started = beginShell(subject);
    var first = shellAction(subject, started.token, 'input', 1, 1, 'value=kept');
    assert.strictEqual(first.outcome.status, 'Written');
    assert.strictEqual(first.session.nextInputSequence, 2);
    var command = 'printf "%s\\n" "$value"';
    var second = shellAction(subject, started.token, 'input', 1, 2, command);
    assert.strictEqual(second.outcome.status, 'Written');
    assert.strictEqual(second.session.nextInputSequence, 3);
    assert.deepStrictEqual(subject.child.stdin.writes, ['value=kept\n', command + '\n']);
    assert.strictEqual(subject.spawnCalls.length, 1);
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 2, command).outcome.status, 'Replay');
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 2, 'different').outcome.status, 'Rejected');
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 1, 'value=kept').outcome.status, 'Rejected');
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 4, 'future').outcome.status, 'Rejected');
    assert.strictEqual(subject.child.stdin.writes.length, 2);
    shellRead(subject);
    shellRead(subject);
    assert.strictEqual(subject.child.stdin.writes.length, 2, 'Refresh must never replay a command.');
});

test('Invalid input does not consume a sequence and UTF-8 input limits count raw bytes', function () {
    var subject = harness();
    var started = beginShell(subject);
    ['nul\u0000input', repeated('x', 4097), repeated('\u00e9', 2049), {}].forEach(function (command) {
        assertShellRejection(shellPost(subject, {
            token: started.token, action: 'input', sessionId: 1, sequence: 1, command: command
        }));
        assert.strictEqual(shellRead(subject).session.nextInputSequence, 1);
    });
    assert.strictEqual(subject.child.stdin.writes.length, 0);
    var accepted = shellAction(subject, started.token, 'input', 1, 1, repeated('\u00e9', 2048));
    assert.strictEqual(accepted.outcome.status, 'Written');
    assert.strictEqual(subject.child.stdin.writes.length, 1);
});

test('Backpressure blocks new input until drain and does not consume a rejected sequence', function () {
    var subject = harness({ writeBackpressure: true });
    var started = beginShell(subject);
    var accepted = shellAction(subject, started.token, 'input', 1, 1, 'first');
    assert.strictEqual(accepted.outcome.status, 'Written');
    assert.strictEqual(accepted.session.inputStatus, 'Backpressured');
    var blocked = shellAction(subject, started.token, 'input', 1, 2, 'second');
    assert.strictEqual(blocked.outcome.status, 'Rejected');
    assert.strictEqual(blocked.session.nextInputSequence, 2);
    assert.strictEqual(subject.child.stdin.writes.length, 1);
    subject.child.stdin.emit('drain');
    assert.strictEqual(shellRead(subject).session.inputStatus, 'Ready');
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 2, 'second').outcome.status, 'Written');
    assert.deepStrictEqual(subject.child.stdin.writes, ['first\n', 'second\n']);
});

test('Shell stop signals only its owned process group and waits for observed close', function () {
    var subject = harness();
    var started = beginShell(subject);
    var stopped = shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(stopped.outcome.status, 'Stopped');
    assert.strictEqual(stopped.session.status, 'Stopping');
    assert.deepStrictEqual(subject.groupKillCalls, [{ pid: -subject.child.pid, signal: 'SIGKILL' }]);
    assert.strictEqual(subject.child.killCalls.length, 0);
    assert.strictEqual(stopped.session.termination.status, 'Requested');
    assert.strictEqual(stopped.session.termination.scope, 'ProcessGroup');
    assert.deepStrictEqual(stopped.session.exit, { status: 'NotObserved' });
    shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(subject.groupKillCalls.length, 1);
    subject.child.emit('close', null, 'SIGKILL');
    var closed = shellRead(subject).session;
    assert.strictEqual(closed.status, 'Closed');
    timestamp(closed.completedAtUtc);
    assert.deepStrictEqual(closed.exit, { status: 'Observed', kind: 'Signal', value: 'SIGKILL' });
});

test('A new closed-session start increments identity and stale actions cannot touch its successor', function () {
    var subject = harness();
    var first = beginShell(subject);
    subject.child.emit('close', 0, null);
    var second = shellAction(subject, first.token, 'start', 1);
    assert.strictEqual(second.outcome.status, 'Started');
    assert.strictEqual(second.session.id, 2);
    assert.strictEqual(subject.spawnCalls.length, 2);
    assert.strictEqual(shellAction(subject, first.token, 'start', 1).outcome.status, 'Replay');
    assert.strictEqual(shellAction(subject, first.token, 'start', 0).outcome.status, 'Rejected');
    assert.strictEqual(shellAction(subject, first.token, 'input', 1, 1, 'stale').outcome.status, 'Rejected');
    assert.strictEqual(shellAction(subject, first.token, 'stop', 1).outcome.status, 'Rejected');
    assert.strictEqual(subject.children[1].stdin.writes.length, 0);
    assert.strictEqual(subject.groupKillCalls.length, 0);
});

test('Shell reads do not extend the five-minute idle deadline', function () {
    var subject = harness();
    beginShell(subject);
    subject.advance(299999);
    assert.strictEqual(shellRead(subject).session.status, 'Running');
    subject.advance(1);
    assert.strictEqual(shellRead(subject).session.status, 'Stopping');
    assert.deepStrictEqual(subject.groupKillCalls, [{ pid: -subject.child.pid, signal: 'SIGKILL' }]);
});

test('Accepted input renews inactivity while the fifteen-minute lifetime still expires', function () {
    var subject = harness();
    var started = beginShell(subject);
    [1, 2, 3].forEach(function (sequence) {
        subject.advance(240000);
        assert.strictEqual(shellRead(subject).session.status, 'Running');
        assert.strictEqual(shellAction(subject, started.token, 'input', 1, sequence, 'activity').outcome.status, 'Written');
    });
    subject.advance(179999);
    assert.strictEqual(shellRead(subject).session.status, 'Running');
    subject.advance(1);
    assert.strictEqual(shellRead(subject).session.status, 'Stopping');
    assert.strictEqual(subject.groupKillCalls.length, 1);
});

test('Shell output retains independent 16-KiB raw tails with dropped-byte counts', function () {
    var subject = harness();
    beginShell(subject);
    subject.child.stdout.emit('data', new Buffer(repeated('a', 15000), 'utf8'));
    subject.child.stdout.emit('data', new Buffer(repeated('b', 2000), 'utf8'));
    subject.child.stderr.emit('data', new Buffer(repeated('c', 20000), 'utf8'));
    var session = shellRead(subject).session;
    assert.deepStrictEqual(session.stdout, { bytes: 16384, text: repeated('a', 14384) + repeated('b', 2000), droppedBytes: 616 });
    assert.deepStrictEqual(session.stderr, { bytes: 16384, text: repeated('c', 16384), droppedBytes: 3616 });
    assert.strictEqual(session.status, 'Running', 'Tail eviction is not a process failure.');
    assert.strictEqual(subject.groupKillCalls.length, 0);
    subject.child.emit('close', 0, null);
    var closed = shellRead(subject).session;
    subject.child.stdout.emit('data', new Buffer('late', 'utf8'));
    assert.deepStrictEqual(shellRead(subject).session, closed);
});

test('An observed shell exit forbids later PID signals and bounds pipe draining to three seconds', function () {
    var subject = harness();
    var started = beginShell(subject);
    subject.child.emit('exit', 0, null);
    var draining = shellRead(subject).session;
    assert.strictEqual(draining.status, 'Stopping');
    assert.strictEqual(draining.inputStatus, 'Closed');
    assert.strictEqual(shellAction(subject, started.token, 'input', 1, 1, 'after exit').outcome.status, 'Rejected');
    assert.strictEqual(subject.child.stdin.writes.length, 0);
    shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(subject.groupKillCalls.length, 0);
    assert.strictEqual(subject.child.killCalls.length, 0);
    subject.child.stdout.emit('data', new Buffer('drained output', 'utf8'));
    subject.advance(3000);
    var closed = shellRead(subject).session;
    assert.strictEqual(closed.status, 'Closed');
    assert.strictEqual(closed.stdout.text, 'drained output');
    assert.deepStrictEqual(closed.exit, { status: 'Observed', kind: 'Code', value: 0 });
    assert.strictEqual(subject.child.stdout.destroyed, true);
    assert.strictEqual(subject.child.stderr.destroyed, true);
    subject.advance(900000);
    assert.strictEqual(subject.groupKillCalls.length, 0);
    assert.strictEqual(subject.child.killCalls.length, 0);
});

test('Missing shell startup fails explicitly and duplicate failed start never silently retries', function () {
    var subject = harness({ spawnThrows: 'ENOENT' });
    var initial = shellRead(subject);
    var failed = shellAction(subject, initial.token, 'start', 0);
    assert.strictEqual(failed.session.status, 'Failed');
    assert.strictEqual(failed.session.id, 1);
    assert.deepStrictEqual(failed.session.exit, { status: 'NotObserved' });
    assert.strictEqual(shellAction(subject, initial.token, 'start', 0).outcome.status, 'Replay');
    assert.strictEqual(subject.spawnCalls.length, 1);
    assert.strictEqual(subject.groupKillCalls.length, 0);
});

test('A missing or zero child PID can never select the parent process group for a signal', function () {
    [undefined, 0].forEach(function (pid) {
        var subject = harness();
        subject.child.pid = pid;
        var initial = shellRead(subject);
        var attempted = shellAction(subject, initial.token, 'start', 0);
        if (attempted.session.status === 'Running') {
            shellAction(subject, initial.token, 'stop', attempted.session.id);
        }
        subject.advance(900000);
        assert.strictEqual(subject.groupKillCalls.length, 0, 'An invalid PID must never become process.kill(0) or process.kill(NaN).');
    });
});

test('Output and stdin stream errors stop the owned shell without replaying input', function () {
    ['stdout', 'stderr', 'stdin'].forEach(function (name) {
        var subject = harness();
        var started = beginShell(subject);
        shellAction(subject, started.token, 'input', 1, 1, 'submitted');
        subject.child[name].emit('error', errorWithCode('EPIPE'));
        assert.strictEqual(shellRead(subject).session.status, 'Stopping');
        assert.deepStrictEqual(subject.groupKillCalls, [{ pid: -subject.child.pid, signal: 'SIGKILL' }]);
        shellRead(subject);
        assert.deepStrictEqual(subject.child.stdin.writes, ['submitted\n']);
        assert.strictEqual(subject.spawnCalls.length, 1);
    });
});

test('A delayed write failure consumes its sequence and never submits that command twice', function () {
    var subject = harness({ deferWriteCallback: true });
    var started = beginShell(subject);
    var written = shellAction(subject, started.token, 'input', 1, 1, 'uncertain delivery');
    assert.strictEqual(written.outcome.status, 'Written');
    assert.strictEqual(written.session.nextInputSequence, 2);
    assert.strictEqual(subject.child.stdin.writeCallbacks.length, 1);
    subject.child.stdin.writeCallbacks[0](errorWithCode('EPIPE'));
    assert.strictEqual(shellRead(subject).session.status, 'Stopping');
    shellAction(subject, started.token, 'input', 1, 1, 'uncertain delivery');
    assert.deepStrictEqual(subject.child.stdin.writes, ['uncertain delivery\n']);
    assert.strictEqual(subject.groupKillCalls.length, 1);
});

test('A failed process-group signal falls back only to the owned child handle', function () {
    var subject = harness({ groupKillThrows: 'EPERM' });
    var started = beginShell(subject);
    var stopped = shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(stopped.session.status, 'Stopping');
    assert.deepStrictEqual(subject.groupKillCalls, [{ pid: -subject.child.pid, signal: 'SIGKILL' }]);
    assert.deepStrictEqual(subject.child.killCalls, ['SIGKILL']);
    assert.deepStrictEqual(stopped.session.termination, { status: 'Requested', signal: 'SIGKILL', scope: 'Child' });
    assert.deepStrictEqual(stopped.session.exit, { status: 'NotObserved' });
    assert.strictEqual(shellAction(subject, started.token, 'stop', 1).outcome.status, 'Replay');
    assert.strictEqual(subject.groupKillCalls.length, 1);
    assert.strictEqual(subject.child.killCalls.length, 1);
});

test('Failed group and child signals stay explicit and cannot start a replacement or signal after exit', function () {
    [ { groupKillThrows: 'EPERM', killResult: false },
        { groupKillThrows: 'EPERM', killThrows: true } ].forEach(function (options) {
        var subject = harness(options);
        var started = beginShell(subject);
        var stopped = shellAction(subject, started.token, 'stop', 1);
        assert.strictEqual(stopped.session.status, 'Stopping');
        assert.deepStrictEqual(stopped.session.termination, { status: 'RequestFailed', signal: 'SIGKILL', scope: 'Child' });
        assert.deepStrictEqual(stopped.session.exit, { status: 'NotObserved' });
        assert.strictEqual(shellAction(subject, started.token, 'start', 1).outcome.status, 'Rejected');
        assert.strictEqual(subject.spawnCalls.length, 1);
        subject.child.emit('exit', 0, null);
        assert.strictEqual(shellAction(subject, started.token, 'stop', 1).outcome.status, 'Replay');
        assert.strictEqual(subject.groupKillCalls.length, 1);
        assert.strictEqual(subject.child.killCalls.length, 1);
        subject.advance(3000);
        assert.strictEqual(shellRead(subject).session.status, 'Closed');
    });
});

test('Only an explicit second Stop retries a failed termination request', function () {
    var options = { groupKillThrows: 'EPERM', killResult: false, deferWriteCallback: true };
    var subject = harness(options);
    var started = beginShell(subject);
    shellAction(subject, started.token, 'input', 1, 1, 'single submission');
    var first = shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(first.session.termination.status, 'RequestFailed');
    subject.child.stdin.writeCallbacks[0](errorWithCode('EPIPE'));
    subject.child.stdin.emit('error', errorWithCode('EPIPE'));
    subject.child.stdout.emit('error', errorWithCode('EIO'));
    assert.strictEqual(subject.groupKillCalls.length, 1, 'Duplicate failure events must not retry a process-group signal.');
    assert.strictEqual(subject.child.killCalls.length, 1, 'Duplicate failure events must not retry a child signal.');
    assert.strictEqual(shellRead(subject).session.termination.status, 'RequestFailed');
    options.killResult = true;
    var retry = shellAction(subject, started.token, 'stop', 1);
    assert.strictEqual(retry.outcome.status, 'Stopped');
    assert.deepStrictEqual(retry.session.termination, { status: 'Requested', signal: 'SIGKILL', scope: 'Child' });
    assert.strictEqual(subject.groupKillCalls.length, 2);
    assert.strictEqual(subject.child.killCalls.length, 2);
    assert.deepStrictEqual(subject.child.stdin.writes, ['single submission\n']);
    assert.strictEqual(shellAction(subject, started.token, 'stop', 1).outcome.status, 'Replay');
    assert.strictEqual(subject.groupKillCalls.length, 2);
    assert.strictEqual(subject.child.killCalls.length, 2);
});

test('Recovery state retains only the most recent submitted command and resets for a new session', function () {
    var subject = harness();
    var started = beginShell(subject);
    assert.deepStrictEqual(started.session.lastInput, { status: 'None' });
    var firstCommand = 'first-recovery-marker';
    var secondCommand = 'second-recovery-marker';
    var first = shellAction(subject, started.token, 'input', 1, 1, firstCommand);
    assert.deepStrictEqual(first.session.lastInput, { status: 'Submitted', sequence: 1, command: firstCommand });
    var second = shellAction(subject, started.token, 'input', 1, 2, secondCommand);
    assert.deepStrictEqual(second.session.lastInput, { status: 'Submitted', sequence: 2, command: secondCommand });
    var refreshed = shellRead(subject);
    assert.deepStrictEqual(refreshed.session.lastInput, second.session.lastInput);
    assert.strictEqual(JSON.stringify(refreshed).indexOf(firstCommand), -1);
    assert.strictEqual(subject.child.stdin.writes.length, 2);
    subject.child.emit('close', 0, null);
    var next = shellAction(subject, started.token, 'start', 1);
    assert.deepStrictEqual(next.session.lastInput, { status: 'None' });
    assert.strictEqual(subject.children[1].stdin.writes.length, 0);
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
