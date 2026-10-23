import assert from 'node:assert/strict';
import { createBrokerState, isPrivateIPv4 } from '../tools/pc-link.mjs';

let passed = 0;
function test(name, body) {
  body(); passed += 1; console.log('PASS ' + name);
}
function fixture(overrides = {}) {
  let time = 100000;
  const state = createBrokerState({ pcAddress: '192.168.1.245', tvAddress: '192.168.1.208',
    pairCode: '01234567', pairWindowMs: 1000, sessionMs: 2000, ...overrides },
    { now: () => time, makeToken: () => 'a'.repeat(64) });
  return { state, advance: ms => { time += ms; } };
}
test('Only private IPv4 targets are accepted', () => {
  for (const ip of ['192.168.1.208', '10.0.0.1', '172.16.0.1', '172.31.255.254']) assert.equal(isPrivateIPv4(ip), true);
  for (const ip of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.32.0.1', '192.168.1.999', 'localhost']) assert.equal(isPrivateIPv4(ip), false);
  assert.throws(() => fixture({ tvAddress: '8.8.8.8' }));
  assert.throws(() => fixture({ pairCode: '1234' }));
});
test('Pairing creates no shell job and does not publish its token in status', () => {
  const { state } = fixture();
  assert.equal(state.enqueue('GET', null).status, 'Rejected');
  assert.equal(state.pair('01234567').status, 'Paired');
  assert.deepEqual(state.nextJob(), { job: null });
  assert.equal(JSON.stringify(state.readStatus()).includes('a'.repeat(64)), false);
  assert.equal(state.isAuthorized('192.168.1.208', 'Bearer ' + 'a'.repeat(64)), true);
  assert.equal(state.isAuthorized('192.168.1.209', 'Bearer ' + 'a'.repeat(64)), false);
  assert.equal(state.isAuthorized('192.168.1.208', 'Bearer ' + 'b'.repeat(64)), false);
});
test('Bad pairing attempts lock the window and expired codes cannot pair', () => {
  const { state } = fixture();
  for (let i = 0; i < 5; i++) assert.equal(state.pair('99999999').status, 'Rejected');
  assert.equal(state.pair('01234567').reasonCode, 'PairingLocked');
  const other = fixture(); other.advance(1001);
  assert.equal(other.state.pair('01234567').reasonCode, 'PairingExpired');
});
test('Jobs are issued once and one outstanding issue serializes the transport', () => {
  const { state } = fixture(); state.pair('01234567');
  const first = state.enqueue('GET', null);
  const second = state.enqueue('POST', { action: 'input', command: 'id' });
  assert.equal(state.nextJob().job.id, first.jobId);
  assert.deepEqual(state.nextJob(), { job: null });
  state.expireJob(first.jobId);
  assert.equal(state.nextJob().job.id, second.jobId);
  assert.equal(state.acceptResult(first.jobId, 200, {}).status, 'Expired');
  assert.deepEqual(state.nextJob(), { job: null });
});
test('Results acknowledge the matching issue and reject conflicting duplicates', () => {
  const { state } = fixture(); state.pair('01234567');
  const queued = state.enqueue('GET', null);
  assert.equal(state.acceptResult(queued.jobId, 200, {}).status, 'Rejected');
  state.nextJob();
  assert.equal(state.acceptResult(queued.jobId, 200, { value: 1 }).status, 'Accepted');
  assert.equal(state.acceptResult(queued.jobId, 200, { value: 1 }).status, 'Duplicate');
  assert.equal(state.acceptResult(queued.jobId, 200, { value: 2 }).reasonCode, 'ConflictingResult');
  assert.equal(state.acceptResult(9999, 200, {}).status, 'Rejected');
});
test('Queue and wire bounds reject extra work without consuming an issue', () => {
  const { state } = fixture(); state.pair('01234567');
  assert.equal(state.enqueue('DELETE', null).status, 'Rejected');
  assert.equal(state.enqueue('GET', {}).status, 'Rejected');
  assert.equal(state.enqueue('POST', []).status, 'Rejected');
  assert.equal(state.enqueue('POST', { text: 'x'.repeat(32768) }).status, 'Rejected');
  for (let i = 0; i < 8; i++) assert.equal(state.enqueue('GET', null).status, 'Queued');
  assert.equal(state.enqueue('GET', null).reasonCode, 'QueueFull');
});
test('Session expiry revokes transport without renewing through polls', () => {
  const f = fixture(); f.state.pair('01234567');
  f.state.enqueue('GET', null); f.state.nextJob();
  f.advance(2001);
  assert.equal(f.state.isAuthorized('192.168.1.208', 'Bearer ' + 'a'.repeat(64)), false);
  assert.equal(f.state.readStatus().status, 'Expired');
  assert.deepEqual(f.state.nextJob(), { job: null });
  assert.equal(f.state.pair('01234567').status, 'Rejected');
});
console.log(passed + ' PC broker contract tests passed.');
