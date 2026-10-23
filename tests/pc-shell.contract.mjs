import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    validateEndpoint, validateShell, classifyDelivery, pendingIntents,
    serviceEpoch, createController, readPendingLog, requestLoopback
} from '../tools/pc-shell.mjs';

const TOKEN = '07'.repeat(32);
const OTHER_TOKEN = '08'.repeat(32);
const AT = '2026-10-23T12:00:00.000Z';

function shell({ token = TOKEN, id = 1, status = 'Running', sequence = 1,
    command, stdout = '', dropped = 0, inputStatus = 'Ready', outcome = 'Read' } = {}) {
    const session = {
        id, status, nextInputSequence: sequence, inputStatus,
        lastInput: command === undefined ? { status: 'None' } :
            { status: 'Submitted', sequence: sequence - 1, command },
        stdout: { bytes: Buffer.byteLength(stdout), text: stdout, droppedBytes: dropped },
        stderr: { bytes: 0, text: '', droppedBytes: 0 },
        exit: { status: 'NotObserved' }, termination: { status: 'NotRequested' }
    };
    if (status !== 'NotStarted') session.startedAtUtc = AT;
    if (status === 'Closed' || status === 'Failed') session.completedAtUtc = AT;
    return {
        moduleId: 'tizenbrew-runtime-identity', schemaVersion: 1, shellId: 'owner-shell', token,
        settings: { file: '/bin/sh', args: ['-s'], maxInputBytes: 4096,
            maxOutputBytesPerStream: 16384, idleTimeoutMs: 300000, sessionTimeoutMs: 900000 },
        session, outcome: { status: outcome }
    };
}

function fixture(responses, history = []) {
    const calls = [];
    const logs = [];
    let nextId = 0;
    const client = createController({
        endpoint: 'http://127.0.0.1:19001', history,
        now: () => AT, nextId: () => 'action-' + (++nextId),
        log: async record => { logs.push(structuredClone(record)); },
        request: async request => {
            calls.push(structuredClone(request));
            assert(responses.length, 'Unexpected transport request');
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return structuredClone(response);
        }
    });
    return { client, calls, logs };
}

test('endpoint accepts loopback ports only and rejects alternate hosts or URL side channels', () => {
    assert.equal(validateEndpoint('http://127.0.0.1:19001').port, '19001');
    for (const value of ['https://127.0.0.1:18765', 'http://localhost:18765',
        'http://192.0.2.1:18765', 'http://127.0.0.1:18765/v1/shell',
        'http://user:pass@127.0.0.1:18765', 'http://127.0.0.1:18765/?x=1']) {
        assert.throws(() => validateEndpoint(value));
    }
    assert.throws(() => requestLoopback({ method: 'GET',
        url: 'http://user:pass@127.0.0.1:18765/v1/shell', headers: {} }));
});

test('wire validation refuses unrelated endpoints and malformed bounded evidence', () => {
    assert.equal(validateShell(shell()).session.status, 'Running');
    const wrong = shell(); wrong.moduleId = 'unrelated';
    assert.throws(() => validateShell(wrong));
    const oversized = shell(); oversized.session.stdout.bytes = 16385;
    assert.throws(() => validateShell(oversized));
    const missing = shell(); delete missing.session.lastInput;
    assert.throws(() => validateShell(missing));
});

test('a status read preserves service Host and Origin despite another forwarded PC port', async () => {
    const f = fixture([shell()]);
    await f.client.status();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].url, 'http://127.0.0.1:19001/v1/shell');
    assert.equal(f.calls[0].headers.Host, '127.0.0.1:18765');
    assert.equal(f.calls[0].headers.Origin, 'http://127.0.0.1:8081');
    assert.equal(JSON.stringify(f.logs).includes(TOKEN), false);
});

test('start attaches to an existing shell without posting a replacement or claiming ownership', async () => {
    const f = fixture([shell()]);
    const result = await f.client.start();
    assert.equal(result.receipt, 'Attached');
    assert.equal(result.ownership, 'Attached');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('send uses exact observed sequence, logs intent before receipt, and redacts all token occurrences', async () => {
    const command = 'echo ' + TOKEN;
    const f = fixture([shell(), shell({ sequence: 2, command, outcome: 'Written' })]);
    const result = await f.client.send(command);
    assert.equal(result.delivery, 'Post');
    assert.equal(result.receipt, 'Written');
    const post = f.calls.find(call => call.method === 'POST');
    assert.deepEqual(JSON.parse(post.body), { token: TOKEN, action: 'input', sessionId: 1, sequence: 1, command });
    assert.equal(post.headers['Content-Type'], 'application/json');
    assert(f.logs.findIndex(row => row.type === 'ActionIntent') < f.logs.findIndex(row => row.type === 'ActionReceipt'));
    assert.equal(JSON.stringify(f.logs).includes(TOKEN), false);
});

test('ambiguous input performs GET recovery only and accepts an exact matching identity', async () => {
    const command = 'printf hello';
    const f = fixture([shell(), new Error('Synthetic timeout'), shell({ sequence: 2, command })]);
    const result = await f.client.send(command);
    assert.equal(result.delivery, 'AcceptedRecovery');
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET']);
    assert.equal(pendingIntents(f.logs).length, 0);
});

test('unresolved input blocks a later mutation and survives JSONL history reconstruction', async () => {
    const f = fixture([shell(), new Error('Synthetic timeout'), shell()]);
    assert.equal((await f.client.send('unresolved')).delivery, 'Unresolved');
    assert.equal(pendingIntents(f.logs).length, 1);
    const next = fixture([shell()], f.logs);
    await assert.rejects(next.client.send('new command'), /PendingDelivery/);
    assert.deepEqual(next.calls.map(call => call.method), ['GET']);
});

test('a newer different command or a changed service epoch is a conflict, never accepted recovery', () => {
    const intent = { action: 'input', serviceEpoch: serviceEpoch(TOKEN), sessionId: 1, sequence: 1, command: 'ours' };
    assert.equal(classifyDelivery(intent, shell({ sequence: 3, command: 'theirs' })).status, 'Conflict');
    assert.equal(classifyDelivery(intent, shell({ token: OTHER_TOKEN, sequence: 2, command: 'ours' })).status, 'Conflict');
    assert.equal(classifyDelivery(intent, shell()).status, 'Unresolved');
});

test('changed full snapshots preserve repeated text and explicitly report a dropped output gap', async () => {
    const f = fixture([shell({ stdout: 'same' }), shell({ stdout: 'same', dropped: 9 })]);
    await f.client.status();
    await f.client.status();
    assert.equal(f.logs.filter(row => row.type === 'Snapshot').length, 2);
    const gap = f.logs.find(row => row.type === 'OutputGap');
    assert.equal(gap.stream, 'stdout');
    assert.equal(gap.missingBytes, 5);
    assert.equal(f.logs.some(row => row.type === 'OutputDelta'), false);
});

test('a decoded partial UTF-8 tail is logged as a snapshot without fabricated raw reconstruction', async () => {
    const value = shell();
    value.session.stdout = { bytes: 1, text: '\ufffd', droppedBytes: 2 };
    const f = fixture([value]);
    await f.client.status();
    const snapshot = f.logs.find(row => row.type === 'Snapshot').snapshot;
    assert.equal(snapshot.session.stdout.bytes, 1);
    assert.equal(snapshot.session.stdout.text, '\ufffd');
    assert.equal(snapshot.session.stdout.droppedBytes, 2);
});

test('invalid UTF-8 input size, NUL, and backpressure never post commands', async () => {
    for (const command of ['x'.repeat(4097), '\u00e9'.repeat(2049), 'nul\0value']) {
        const f = fixture([shell()]);
        await assert.rejects(f.client.send(command));
        assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    }
    const f = fixture([shell({ inputStatus: 'Backpressured' })]);
    await assert.rejects(f.client.send('blocked'), /InputNotReady/);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('status reads remain available while an unresolved mutation awaits human acknowledgement', async () => {
    const initial = fixture([shell(), new Error('Synthetic timeout'), shell()]);
    await initial.client.send('unknown');
    const next = fixture([shell()], initial.logs);
    const result = await next.client.status();
    assert.equal(result.recoveries[0].status, 'Unresolved');
    assert.equal(next.calls.length, 1);
});

test('explicit uncertainty acknowledgement sends only the newly requested command', async () => {
    const initial = fixture([shell(), new Error('Synthetic timeout'), shell()]);
    await initial.client.send('old uncertain input');
    const next = fixture([shell(), shell({ sequence: 2, command: 'new explicit input', outcome: 'Written' })], initial.logs);
    await next.client.send('new explicit input', { acknowledgeUncertain: true });
    const posts = next.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).command, 'new explicit input');
    assert(next.logs.some(row => row.type === 'ActionAcknowledged'));
});

test('a received Started receipt records created session identity without implicit stop', async () => {
    const f = fixture([shell({ id: 0, status: 'NotStarted', inputStatus: 'Closed' }), shell({ outcome: 'Started' })]);
    const result = await f.client.start();
    assert.equal(result.ownership, 'Created');
    assert.equal(result.ownerSession.sessionId, 1);
    assert.equal(result.ownerSession.serviceEpoch, serviceEpoch(TOKEN));
    assert.equal(f.logs.find(row => row.type === 'ActionReceipt').clientOwnership, 'Created');
    assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
});

test('JSONL reader treats missing logs as empty, preserves pending intent, and refuses corrupt history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pc-shell-fixture-'));
    const path = join(directory, 'events.jsonl');
    try {
        assert.deepEqual(await readPendingLog(path), []);
        const intent = { type: 'ActionIntent', actionId: 'fixture-intent', serviceEpoch: serviceEpoch(TOKEN),
            action: 'input', sessionId: 1, sequence: 1, command: 'pwd' };
        await writeFile(path, JSON.stringify(intent) + '\n');
        assert.deepEqual(await readPendingLog(path), [intent]);
        await appendFile(path, JSON.stringify({ type: 'ActionReceipt', actionId: intent.actionId, receipt: 'Written' }) + '\n');
        assert.deepEqual(await readPendingLog(path), []);
        await writeFile(path, '{"type":');
        await assert.rejects(readPendingLog(path), /LogContainsInvalidRecord/);
    } finally {
        await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await rmdir(directory);
    }
});
