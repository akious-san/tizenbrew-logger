#!/usr/bin/env node
/* PC-only controller. Importing this module performs no network or file operations. */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const MODULE_ID = 'tizenbrew-runtime-identity';
const LIMIT = 262144;
const SETTINGS = Object.freeze({ file: '/bin/sh', args: ['-s'], maxInputBytes: 4096,
    maxOutputBytesPerStream: 16384, idleTimeoutMs: 300000, sessionTimeoutMs: 900000 });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function requireValue(condition, code) { if (!condition) throw new Error(code); }

export function validateEndpoint(value = 'http://127.0.0.1:18765') {
    requireValue(typeof value === 'string' && /^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/.test(value), 'InvalidLoopbackEndpoint');
    const url = new URL(value);
    requireValue(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash && Number(url.port || 80) >= 1, 'InvalidLoopbackEndpoint');
    return url;
}

function validateInput(command) {
    requireValue(typeof command === 'string' && /\S/.test(command) && !command.includes('\0') &&
        Buffer.byteLength(command, 'utf8') <= SETTINGS.maxInputBytes, 'InvalidCommand');
}

export function validateShell(value) {
    requireValue(object(value) && value.moduleId === MODULE_ID && value.schemaVersion === 1 && value.shellId === 'owner-shell' &&
        typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token), 'InvalidShellEnvelope');
    const settings = value.settings;
    requireValue(object(settings) && Object.keys(SETTINGS).every(key => key === 'args' ?
        Array.isArray(settings.args) && settings.args.length === 1 && settings.args[0] === '-s' : settings[key] === SETTINGS[key]), 'UnexpectedShellSettings');
    const session = value.session;
    requireValue(object(session) && integer(session.id) && integer(session.nextInputSequence) && session.nextInputSequence >= 1 &&
        ['NotStarted', 'Running', 'Stopping', 'Closed', 'Failed'].includes(session.status) &&
        ['Ready', 'Backpressured', 'Closed'].includes(session.inputStatus), 'InvalidShellSession');
    const last = session.lastInput;
    requireValue(object(last) && ['None', 'Submitted'].includes(last.status), 'InvalidRecoveryIdentity');
    if (last.status === 'Submitted') {
        validateInput(last.command);
        requireValue(integer(last.sequence) && last.sequence >= 1 && session.nextInputSequence === last.sequence + 1, 'InvalidRecoveryIdentity');
    } else {
        requireValue(!own(last, 'sequence') && !own(last, 'command') && session.nextInputSequence === 1, 'InvalidRecoveryIdentity');
    }
    for (const name of ['stdout', 'stderr']) {
        const stream = session[name];
        requireValue(object(stream) && integer(stream.bytes) && stream.bytes <= 16384 && integer(stream.droppedBytes) &&
            integer(stream.bytes + stream.droppedBytes) && typeof stream.text === 'string' && stream.text.length <= stream.bytes, 'InvalidStreamEvidence');
    }
    const exit = session.exit;
    requireValue(object(exit) && (exit.status === 'NotObserved' ? !own(exit, 'kind') && !own(exit, 'value') :
        exit.status === 'Observed' && (exit.kind === 'Code' ? Number.isSafeInteger(exit.value) && Math.abs(exit.value) <= 2147483648 :
            exit.kind === 'Signal' && typeof exit.value === 'string' && /^[A-Z0-9]{1,32}$/.test(exit.value))), 'InvalidExitEvidence');
    const termination = session.termination;
    requireValue(object(termination) && (termination.status === 'NotRequested' ? !own(termination, 'signal') && !own(termination, 'scope') :
        ['Requested', 'RequestFailed'].includes(termination.status) && termination.signal === 'SIGKILL' &&
        ['ProcessGroup', 'Child'].includes(termination.scope)), 'InvalidTerminationEvidence');
    if (session.status === 'NotStarted') {
        requireValue(session.id === 0 && !own(session, 'startedAtUtc') && !own(session, 'completedAtUtc') && session.inputStatus === 'Closed', 'InvalidInitialSession');
    } else {
        requireValue(session.id >= 1 && timestamp(session.startedAtUtc), 'InvalidSessionTimestamp');
        if (['Closed', 'Failed'].includes(session.status)) requireValue(timestamp(session.completedAtUtc), 'InvalidSessionTimestamp');
        else requireValue(!own(session, 'completedAtUtc'), 'InvalidSessionTimestamp');
    }
    if (session.status !== 'Running') requireValue(session.inputStatus === 'Closed', 'InvalidInputState');
    if (own(session, 'reasonCode')) requireValue(reason(session.reasonCode), 'InvalidReasonCode');
    requireValue(object(value.outcome) && ['Read', 'Started', 'Written', 'Stopped', 'Replay', 'Rejected'].includes(value.outcome.status) &&
        (value.outcome.status !== 'Rejected' || reason(value.outcome.reasonCode)), 'InvalidActionOutcome');
    return value;
}

export function serviceEpoch(token) {
    requireValue(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'InvalidServiceEpoch');
    return createHash('sha256').update(token).digest('hex');
}

export function classifyDelivery(intent, value) {
    const snapshot = validateShell(value);
    const session = snapshot.session;
    if (intent.serviceEpoch !== serviceEpoch(snapshot.token)) return { status: 'Conflict', reasonCode: 'ServiceEpochChanged' };
    if (intent.action === 'start') {
        if (session.id === intent.sessionId + 1) return { status: 'AcceptedRecovery', reasonCode: 'StartAttemptObserved' };
        return session.id === intent.sessionId ? { status: 'Unresolved', reasonCode: 'StartNotObserved' } : { status: 'Conflict', reasonCode: 'SessionChanged' };
    }
    if (session.id !== intent.sessionId) return { status: 'Conflict', reasonCode: 'SessionChanged' };
    if (intent.action === 'stop') return ['Stopping', 'Closed', 'Failed'].includes(session.status) ?
        { status: 'AcceptedRecovery', reasonCode: 'StopStateObserved' } : { status: 'Unresolved', reasonCode: 'StopNotObserved' };
    const last = session.lastInput;
    if (last.status === 'Submitted' && last.sequence === intent.sequence && last.command === intent.command)
        return { status: 'AcceptedRecovery', reasonCode: 'ExactInputObserved' };
    if (session.nextInputSequence > intent.sequence) return { status: 'Conflict', reasonCode: 'DifferentInputObserved' };
    return { status: 'Unresolved', reasonCode: 'InputNotObserved' };
}

function foldHistory(map, row) {
    if (!object(row)) return;
    if (row.type === 'ActionIntent') {
        requireValue(typeof row.actionId === 'string' && row.actionId.length <= 128 && /^[a-f0-9]{64}$/.test(row.serviceEpoch) &&
            ['start', 'input', 'stop'].includes(row.action) && integer(row.sessionId), 'InvalidIntentLog');
        if (row.action === 'input') {
            requireValue(integer(row.sequence) && row.sequence >= 1, 'InvalidIntentLog');
            validateInput(row.command);
        }
        map.set(row.actionId, row);
    } else if (row.type === 'ActionReceipt' || row.type === 'ActionAcknowledged' ||
        (row.type === 'ActionRecovery' && row.status === 'AcceptedRecovery')) map.delete(row.actionId);
}

export function pendingIntents(history) {
    const map = new Map();
    for (const row of history) foldHistory(map, row);
    return [...map.values()];
}

function publicSnapshot(snapshot) {
    return { moduleId: snapshot.moduleId, schemaVersion: snapshot.schemaVersion, shellId: snapshot.shellId,
        settings: snapshot.settings, session: snapshot.session, outcome: snapshot.outcome };
}

export function createController({ endpoint = 'http://127.0.0.1:18765', request, log, history = [],
    now = () => new Date().toISOString(), nextId = randomUUID }) {
    const url = new URL('/v1/shell', validateEndpoint(endpoint)).href;
    requireValue(typeof request === 'function' && typeof log === 'function', 'MissingControllerDependency');
    const unresolved = new Map(pendingIntents(history).map(row => [row.actionId, row]));
    const secrets = new Set();
    let observed = { status: 'None' };
    let ownership = { status: 'Unobserved' };
    let operation = 'Idle';
    let lastSnapshotKey;
    let cursors = { status: 'None' };

    function redacted(value) {
        if (typeof value === 'string') {
            for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
            return value;
        }
        if (Array.isArray(value)) return value.map(redacted);
        if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'token').map(([key, item]) => [key, redacted(item)]));
        return value;
    }
    const record = async row => log(redacted({ atPcUtc: now(), ...row }));
    const headers = { Host: '127.0.0.1:18765', Origin: 'http://127.0.0.1:8081' };

    async function observe(snapshot) {
        validateShell(snapshot);
        secrets.add(snapshot.token);
        const epoch = serviceEpoch(snapshot.token);
        if (observed.status === 'Observed' && observed.epoch !== epoch)
            await record({ type: 'ServiceEpochChanged', previousEpoch: observed.epoch, serviceEpoch: epoch });
        if (ownership.status !== 'Created' || ownership.epoch !== epoch || ownership.sessionId !== snapshot.session.id)
            ownership = { status: 'Attached', epoch, sessionId: snapshot.session.id };
        const same = cursors.status === 'Observed' && cursors.epoch === epoch && cursors.sessionId === snapshot.session.id;
        const ends = {};
        for (const stream of ['stdout', 'stderr']) {
            const item = snapshot.session[stream];
            const previousEnd = same ? cursors.ends[stream] : 0;
            const end = item.bytes + item.droppedBytes;
            requireValue(!same || end >= previousEnd, 'OutputCounterRegressed');
            if (item.droppedBytes > previousEnd) await record({ type: 'OutputGap', serviceEpoch: epoch, sessionId: snapshot.session.id,
                stream, fromByte: previousEnd, toByte: item.droppedBytes, missingBytes: item.droppedBytes - previousEnd });
            ends[stream] = end;
        }
        cursors = { status: 'Observed', epoch, sessionId: snapshot.session.id, ends };
        observed = { status: 'Observed', epoch, snapshot };
        const evidence = { serviceEpoch: epoch, moduleId: snapshot.moduleId, schemaVersion: snapshot.schemaVersion,
            shellId: snapshot.shellId, settings: snapshot.settings, session: snapshot.session };
        const key = JSON.stringify(evidence);
        if (key !== lastSnapshotKey) {
            await record({ type: 'Snapshot', snapshot: evidence, representation: 'DecodedTextSnapshot' });
            lastSnapshotKey = key;
        }
        const recoveries = [];
        for (const [actionId, intent] of unresolved) {
            const resolution = classifyDelivery(intent, snapshot);
            recoveries.push({ actionId, action: intent.action, ...resolution });
            await record({ type: 'ActionRecovery', actionId, ...resolution });
            if (resolution.status === 'AcceptedRecovery') unresolved.delete(actionId);
        }
        return { snapshot, recoveries };
    }
    async function read() { return observe(await request({ method: 'GET', url, headers: { ...headers } })); }
    function present(value, extra = {}) {
        return redacted({ snapshot: publicSnapshot(value.snapshot), recoveries: value.recoveries || [], ownership: ownership.status,
            ownerSession: { status: ownership.status, serviceEpoch: ownership.epoch, sessionId: ownership.sessionId }, ...extra });
    }
    async function exclusively(action) {
        requireValue(operation === 'Idle', 'ControllerBusy');
        operation = 'Active';
        try { return await action(); } finally { operation = 'Idle'; }
    }
    async function act(action, command, options = {}) {
        return exclusively(async () => {
            const current = await read();
            if (options.acknowledgeUncertain === true) {
                for (const actionId of unresolved.keys()) await record({ type: 'ActionAcknowledged', actionId,
                    reasonCode: 'HumanAcknowledgedUncertainDelivery' });
                unresolved.clear();
            }
            requireValue(unresolved.size === 0, 'PendingDelivery: use status to reconcile; --acknowledge-uncertain accepts the remaining uncertainty without replaying it');
            const snapshot = current.snapshot;
            const session = snapshot.session;
            if (action === 'start' && session.status === 'Running') return present(current, { receipt: 'Attached', delivery: 'Read' });
            if (action === 'start') requireValue(['NotStarted', 'Closed', 'Failed'].includes(session.status), 'ShellStillStopping');
            if (action === 'input') {
                validateInput(command);
                requireValue(session.status === 'Running' && session.inputStatus === 'Ready', 'InputNotReady');
            }
            if (action === 'stop' && ['NotStarted', 'Closed', 'Failed'].includes(session.status))
                return present(current, { receipt: 'AlreadyClosed', delivery: 'Read' });
            const intent = { type: 'ActionIntent', actionId: nextId(), serviceEpoch: observed.epoch, action, sessionId: session.id };
            const payload = { token: snapshot.token, action, sessionId: session.id };
            if (action === 'input') {
                intent.sequence = payload.sequence = session.nextInputSequence;
                intent.command = payload.command = command;
            }
            // The durable intent is written before a possibly mutating request.
            await record(intent);
            unresolved.set(intent.actionId, intent);
            try {
                const result = validateShell(await request({ method: 'POST', url,
                    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
                requireValue(serviceEpoch(result.token) === intent.serviceEpoch, 'ServiceEpochChanged');
                const receipt = result.outcome.status;
                const expected = action === 'start' ? ['Started', 'Replay'] : action === 'input' ? ['Written', 'Replay'] : ['Stopped', 'Replay'];
                requireValue(receipt === 'Rejected' || (expected.includes(receipt) && classifyDelivery(intent, result).status === 'AcceptedRecovery'), 'UnexpectedActionReceipt');
                await record({ type: 'ActionReceipt', actionId: intent.actionId, receipt, delivery: 'Post', serviceEpoch: intent.serviceEpoch,
                    sessionId: result.session.id, clientOwnership: action === 'start' && receipt === 'Started' ? 'Created' : ownership.status });
                unresolved.delete(intent.actionId);
                const value = await observe(result);
                if (action === 'start' && receipt === 'Started') ownership = { status: 'Created', epoch: intent.serviceEpoch, sessionId: result.session.id };
                return present(value, { receipt, delivery: 'Post' });
            } catch (error) {
                await record({ type: 'ActionUncertain', actionId: intent.actionId, reasonCode: 'PostOutcomeUnavailable' });
                try {
                    const value = await read();
                    const resolution = classifyDelivery(intent, value.snapshot);
                    return present(value, { receipt: resolution.status === 'AcceptedRecovery' ? 'RecoveredSubmission' : 'Unknown',
                        delivery: resolution.status, reasonCode: resolution.reasonCode });
                } catch (recoveryError) {
                    await record({ type: 'RecoveryUnavailable', actionId: intent.actionId });
                    return present(current, { receipt: 'Unknown', delivery: 'Unresolved', reasonCode: 'RecoveryUnavailable' });
                }
            }
        });
    }
    return {
        status: () => exclusively(async () => present(await read())),
        start: options => act('start', undefined, options),
        send: (command, options) => act('input', command, options),
        stop: options => act('stop', undefined, options)
    };
}

export function requestLoopback({ method, url, headers, body }) {
    const endpoint = new URL(url);
    validateEndpoint(endpoint.origin);
    requireValue(endpoint.pathname === '/v1/shell' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'InvalidRequestPath');
    return new Promise((resolveRequest, rejectRequest) => {
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (error) rejectRequest(error); else resolveRequest(value);
        };
        const request = http.request(endpoint, { method, headers: { ...headers,
            ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body, 'utf8') }) } }, response => {
            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > LIMIT) { finish(new Error('ResponseTooLarge')); request.destroy(); return; }
                chunks.push(chunk);
            });
            response.on('error', () => finish(new Error('ResponseUnavailable')));
            response.on('end', () => {
                if (settled) return;
                if (response.statusCode !== 200 && !(method === 'POST' && response.statusCode === 202)) {
                    finish(new Error('HttpResponseRejected')); return;
                }
                try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { finish(new Error('InvalidJsonResponse')); }
            });
        });
        const deadline = setTimeout(() => { finish(new Error('RequestTimedOut')); request.destroy(); }, 10000);
        request.on('error', () => finish(new Error('TransportUnavailable')));
        request.end(body);
    });
}

export async function readPendingLog(path) {
    const map = new Map();
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            requireValue(Buffer.byteLength(line) <= 1048576, 'LogRecordTooLarge');
            let row;
            try { row = JSON.parse(line); } catch { throw new Error('LogContainsInvalidRecord'); }
            foldHistory(map, row);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    } finally { lines.close(); stream.destroy(); }
    return [...map.values()];
}

async function main() {
    const parsed = parseArgs({ allowPositionals: true, options: {
        url: { type: 'string' }, port: { type: 'string' }, log: { type: 'string' },
        'acknowledge-uncertain': { type: 'boolean', default: false }
    } });
    const [action, command] = parsed.positionals;
    requireValue(['status', 'start', 'send', 'stop', 'watch'].includes(action) &&
        parsed.positionals.length === (action === 'send' ? 2 : 1),
    'Usage: node tools/pc-shell.mjs status|start|send "command"|stop|watch [--port 18765] [--log path] [--acknowledge-uncertain]');
    requireValue(!(parsed.values.url && parsed.values.port), 'ChooseUrlOrPort');
    const endpoint = parsed.values.url || (parsed.values.port ? 'http://127.0.0.1:' + parsed.values.port : 'http://127.0.0.1:18765');
    validateEndpoint(endpoint);
    const logPath = resolve(parsed.values.log || 'pc-shell-logs/session.jsonl');
    await mkdir(dirname(logPath), { recursive: true });
    const history = await readPendingLog(logPath);
    const writeLog = row => appendFile(logPath, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
    const client = createController({ endpoint, request: requestLoopback, history,
        log: writeLog });
    const options = { acknowledgeUncertain: parsed.values['acknowledge-uncertain'] };
    console.error('Decoded UTF-8 snapshots; not a byte-exact transcript. Log: ' + logPath);
    if (action === 'watch') {
        const abort = new AbortController();
        const onInterrupt = () => abort.abort();
        process.on('SIGINT', onInterrupt);
        let previous;
        try {
            while (!abort.signal.aborted) {
                try {
                    const result = await client.status();
                    const text = JSON.stringify(result, null, 2);
                    if (text !== previous) { console.log(text); previous = text; }
                } catch {
                    if (abort.signal.aborted) break;
                    await writeLog({ type: 'WatchReadUnavailable', atPcUtc: new Date().toISOString(), reasonCode: 'ReadUnavailable' });
                    if (previous !== 'Unavailable') console.error('Read unavailable; watch will retry GET only.');
                    previous = 'Unavailable';
                }
                try { await delay(1000, undefined, { signal: abort.signal }); } catch (error) { if (!abort.signal.aborted) throw error; }
            }
        } finally { process.off('SIGINT', onInterrupt); }
        return;
    }
    const result = action === 'send' ? await client.send(command, options) : action === 'status' ? await client.status() : await client[action](options);
    console.log(JSON.stringify(result, null, 2));
    if (result.receipt === 'Written' || result.receipt === 'RecoveredSubmission')
        console.error('Input receipt confirms submission only; command completion is not measured.');
    if (['Conflict', 'Unresolved'].includes(result.delivery) || result.receipt === 'Rejected') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
