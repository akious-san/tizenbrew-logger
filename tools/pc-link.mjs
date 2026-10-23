import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ID = 'tizenbrew-runtime-identity';
const ORIGIN = 'http://127.0.0.1:8081';
const LOCAL_PORT = 18765;
const LINK_PORT = 18766;
const JOB_DEADLINE_MS = 6000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function isPrivateIPv4(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// One owner for pairing, job delivery and expiry; HTTP never decides these transitions.
export function createBrokerState(settings, { now = Date.now, makeToken = () => randomBytes(32).toString('hex') } = {}) {
  const config = Object.freeze({ pairWindowMs: 300000, sessionMs: 900000, ...settings });
  if (!isPrivateIPv4(config.pcAddress) || !isPrivateIPv4(config.tvAddress) ||
      config.pcAddress === config.tvAddress || typeof config.pairCode !== 'string' || !/^\d{8}$/.test(config.pairCode) ||
      !Number.isInteger(config.pairWindowMs) || config.pairWindowMs < 1000 || config.pairWindowMs > 300000 ||
      !Number.isInteger(config.sessionMs) || config.sessionMs < 1000 || config.sessionMs > 900000) {
    throw new TypeError('Invalid private-LAN pairing settings');
  }
  const pairDeadline = now() + config.pairWindowMs;
  let phase = 'AwaitingPair', badAttempts = 0, token, sessionDeadline, sequence = 0;
  const jobs = new Map();
  const rejected = reasonCode => ({ status: 'Rejected', reasonCode });
  function refresh() {
    if ((phase === 'AwaitingPair' && now() >= pairDeadline) ||
        (phase === 'Paired' && now() >= sessionDeadline)) {
      phase = 'Expired'; token = undefined;
      for (const job of jobs.values()) {
        if (job.status === 'Queued' || job.status === 'Issued') job.status = 'Expired';
      }
    }
  }
  function prune() {
    if (jobs.size <= 64) return;
    for (const [id, job] of jobs) {
      if (job.status === 'Accepted' || job.status === 'Expired') jobs.delete(id);
      if (jobs.size <= 64) break;
    }
  }
  return Object.freeze({
    pair(code) {
      refresh();
      if (phase === 'Expired' || now() >= pairDeadline) return rejected('PairingExpired');
      if (badAttempts >= 5) return rejected('PairingLocked');
      if (!sameSecret(code, config.pairCode)) {
        badAttempts += 1;
        if (badAttempts === 5 && phase === 'AwaitingPair') phase = 'Locked';
        return rejected('PairCodeInvalid');
      }
      if (phase !== 'Paired') {
        const generated = makeToken();
        if (typeof generated !== 'string' || !/^[a-f0-9]{64}$/.test(generated)) throw new Error('SecureTokenUnavailable');
        token = generated; sessionDeadline = now() + config.sessionMs; phase = 'Paired';
      }
      return { status: 'Paired', token, expiresAtUtc: new Date(sessionDeadline).toISOString() };
    },
    isAuthorized(address, authorization) {
      refresh();
      return phase === 'Paired' && address === config.tvAddress && sameSecret(authorization, 'Bearer ' + token);
    },
    enqueue(method, body) {
      refresh();
      if (phase !== 'Paired') return rejected('TVNotPaired');
      if (!((method === 'GET' && body === null) || (method === 'POST' && object(body)))) return rejected('InvalidJob');
      let bodyBytes;
      try { bodyBytes = Buffer.byteLength(JSON.stringify(body)); } catch { return rejected('InvalidJob'); }
      if (bodyBytes > 32768) return rejected('BodyTooLarge');
      if (Buffer.byteLength(JSON.stringify({ id: sequence + 1, method, path: '/v1/shell', body })) > 32768) return rejected('BodyTooLarge');
      const active = [...jobs.values()].filter(job => job.status === 'Queued' || job.status === 'Issued');
      if (active.length >= 8) return rejected('QueueFull');
      const id = ++sequence;
      jobs.set(id, { id, status: 'Queued', method, path: '/v1/shell', body });
      prune();
      return { status: 'Queued', jobId: id };
    },
    nextJob() {
      refresh();
      if (phase !== 'Paired' || [...jobs.values()].some(job => job.status === 'Issued')) return { job: null };
      const next = [...jobs.values()].find(job => job.status === 'Queued');
      if (!next) return { job: null };
      next.status = 'Issued';
      return { job: { id: next.id, method: next.method, path: next.path, body: next.body } };
    },
    expireJob(id) {
      const job = jobs.get(id);
      if (!job || (job.status !== 'Queued' && job.status !== 'Issued')) return { status: 'NoChange' };
      job.status = 'Expired'; job.body = null;
      return { status: 'Expired', jobId: id };
    },
    acceptResult(id, statusCode, body) {
      refresh();
      const job = jobs.get(id);
      if (!job) return rejected('UnknownJob');
      if (job.status === 'Expired') return { status: 'Expired', jobId: id };
      if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 599 || !object(body)) return rejected('InvalidResult');
      let serialized;
      try { serialized = JSON.stringify(body); } catch { return rejected('InvalidResult'); }
      if (Buffer.byteLength(serialized) > 262144) return rejected('ResultTooLarge');
      const fingerprint = createHash('sha256').update(String(statusCode)).update(serialized).digest('hex');
      if (job.status === 'Accepted') return job.fingerprint === fingerprint ?
        { status: 'Duplicate', jobId: id } : rejected('ConflictingResult');
      if (job.status !== 'Issued') return rejected('JobNotIssued');
      job.status = 'Accepted'; job.body = null; job.fingerprint = fingerprint;
      return { status: 'Accepted', jobId: id, statusCode, body };
    },
    readStatus() {
      refresh();
      return { status: phase, pcAddress: config.pcAddress, tvAddress: config.tvAddress,
        pairExpiresAtUtc: new Date(pairDeadline).toISOString(),
        ...(sessionDeadline ? { expiresAtUtc: new Date(sessionDeadline).toISOString() } : {}) };
    }
  });
}

function reply(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', Connection: 'close' });
  response.end(serialized);
}

function readJson(request, limit) {
  return new Promise((resolveBody, reject) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
      request.resume(); reject(new Error('JsonRequired')); return;
    }
    const chunks = []; let bytes = 0, failed = false;
    request.on('data', chunk => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > limit) { failed = true; chunks.length = 0; reject(new Error('BodyTooLarge')); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (failed) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('InvalidJson')); }
    });
    request.once('aborted', () => reject(new Error('BodyAborted')));
    request.once('error', () => reject(new Error('BodyReadFailed')));
  });
}

export async function startBroker({ pcAddress, tvAddress, logDirectory = 'pc-shell-logs' }) {
  const pairCode = String(randomInt(100000000)).padStart(8, '0');
  const state = createBrokerState({ pcAddress, tvAddress, pairCode });
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(resolve(logDirectory), 'broker-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  const log = (event, details = {}) => appendFileSync(logPath,
    JSON.stringify({ pcAtUtc: new Date().toISOString(), event, ...details }) + '\n', { mode: 0o600 });
  const pending = new Map();
  let lastTVContact;
  function expire(id, reasonCode) {
    state.expireJob(id);
    const waiting = pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer); pending.delete(id);
    log('JobUnresolved', { jobId: id, reasonCode });
    reply(waiting.response, 504, { error: reasonCode });
  }
  const local = http.createServer(async (request, response) => {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== '127.0.0.1:' + LOCAL_PORT ||
        request.headers.origin !== ORIGIN) { reply(response, 403, { error: 'LocalClientRequired' }); return; }
    if (request.method === 'GET' && request.url === '/v1/pc-link') {
      reply(response, 200, { ...state.readStatus(), lastTVContactAtUtc: lastTVContact, logPath }); return;
    }
    if (request.url !== '/v1/shell' || !['GET', 'POST'].includes(request.method)) {
      reply(response, 404, { error: 'ShellEndpointOnly' }); return;
    }
    try {
      const body = request.method === 'POST' ? await readJson(request, 32768) : null;
      const queued = state.enqueue(request.method, body);
      if (queued.status !== 'Queued') { reply(response, 503, { error: queued.reasonCode }); return; }
      const id = queued.jobId;
      log('JobQueued', { jobId: id, method: request.method });
      const timer = setTimeout(() => expire(id, 'TVResponseUnconfirmed'), JOB_DEADLINE_MS);
      pending.set(id, { response, timer });
      response.once('close', () => { if (!response.writableEnded) expire(id, 'PCClientDisconnected'); });
    } catch (error) { reply(response, 400, { error: error.message }); }
  });
  const lan = http.createServer(async (request, response) => {
    if (request.socket.remoteAddress !== tvAddress || request.headers.origin !== undefined ||
        request.headers.host !== pcAddress + ':' + LINK_PORT) {
      reply(response, 403, { error: 'ConfiguredTVRequired' }); return;
    }
    try {
      if (request.method === 'POST' && request.url === '/v1/pair') {
        const body = await readJson(request, 2048);
        if (!object(body) || body.moduleId !== MODULE_ID || body.schemaVersion !== 1 ||
            Object.keys(body).sort().join(',') !== 'code,moduleId,schemaVersion') {
          reply(response, 400, { error: 'InvalidPairing' }); return;
        }
        const paired = state.pair(body.code);
        if (paired.status !== 'Paired') {
          log('PairingRejected', { reasonCode: paired.reasonCode });
          reply(response, 403, { error: paired.reasonCode }); return;
        }
        lastTVContact = new Date().toISOString(); log('TVPaired');
        reply(response, 200, { moduleId: 'tizenbrew-pc-link', schemaVersion: 1,
          token: paired.token, expiresAtUtc: paired.expiresAtUtc }); return;
      }
      if (!state.isAuthorized(request.socket.remoteAddress, request.headers.authorization)) {
        reply(response, 403, { error: 'PairingRequired' }); return;
      }
      lastTVContact = new Date().toISOString();
      if (request.method === 'GET' && request.url === '/v1/jobs') {
        const next = state.nextJob();
        if (next.job) log('JobIssued', { jobId: next.job.id, method: next.job.method });
        reply(response, 200, next); return;
      }
      if (request.method === 'POST' && request.url === '/v1/results') {
        const body = await readJson(request, 524288);
        if (!object(body) || Object.keys(body).sort().join(',') !== 'body,id,statusCode' ||
            !Number.isSafeInteger(body.id) || body.id < 1) { reply(response, 400, { error: 'InvalidResult' }); return; }
        const accepted = state.acceptResult(body.id, body.statusCode, body.body);
        if (accepted.status === 'Rejected') { reply(response, 400, { error: accepted.reasonCode }); return; }
        const waiting = pending.get(body.id);
        if (accepted.status === 'Accepted' && waiting) {
          clearTimeout(waiting.timer); pending.delete(body.id);
          reply(waiting.response, accepted.statusCode, accepted.body);
          log('JobAnswered', { jobId: body.id, statusCode: accepted.statusCode });
        }
        reply(response, 200, { status: accepted.status }); return;
      }
      reply(response, 404, { error: 'EndpointNotFound' });
    } catch (error) { reply(response, 400, { error: error.message }); }
  });
  for (const server of [local, lan]) {
    server.maxConnections = 16; server.maxHeadersCount = 24;
    server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
    server.setTimeout(8000, socket => socket.destroy());
  }
  const listen = (server, port, host) => new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); done(); });
  });
  try { await listen(local, LOCAL_PORT, '127.0.0.1'); await listen(lan, LINK_PORT, pcAddress); }
  catch (error) { local.close(); lan.close(); throw error; }
  log('BrokerListening', { pcAddress, tvAddress, localPort: LOCAL_PORT, linkPort: LINK_PORT });
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    for (const id of [...pending.keys()]) expire(id, 'BrokerStopped');
    local.close(); lan.close(); log('BrokerStopped');
  }
  return { local, lan, pairCode, logPath, status: () => state.readStatus(), close };
}

async function main() {
  const args = process.argv.slice(2), values = {};
  if (args.length === 0 || args.includes('--help')) {
    console.log('Usage: node tools/pc-link.mjs --pc-ip <private IPv4> --tv-ip <private IPv4> [--log-dir <directory>]');
    return;
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--pc-ip', '--tv-ip', '--log-dir'].includes(args[i]) || !args[i + 1] || values[args[i]]) {
      throw new Error('Invalid or duplicate option');
    }
    values[args[i]] = args[i + 1];
  }
  const broker = await startBroker({ pcAddress: values['--pc-ip'], tvAddress: values['--tv-ip'],
    logDirectory: values['--log-dir'] || 'pc-shell-logs' });
  console.log(JSON.stringify({ status: 'AwaitingTVPairing', pcAddress: values['--pc-ip'],
    tvAddress: values['--tv-ip'], pairCode: broker.pairCode,
    pairExpiresAtUtc: broker.status().pairExpiresAtUtc, logPath: broker.logPath }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => broker.close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('PC link: ' + error.message); process.exitCode = 1; });
}
