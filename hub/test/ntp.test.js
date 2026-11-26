// The hub's check of its own clock against time servers.

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { agreeOn, askServer, buildRequest, HubClock, ntpToUnix, parseReply, sampleFrom } from '../lib/ntp.js';

const close = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const unixEpochOffset = 2_208_988_800;

/** A time server's answer, as bytes. Times in seconds since 1970. */
function reply(nonce, { received, sent, stratum = 2, leap = 0, mode = 4, rootDelay = 0.01, rootDispersion = 0.002 }) {
  const packet = Buffer.alloc(48);
  packet[0] = (leap << 6) | (4 << 3) | mode;
  packet[1] = stratum;
  packet.writeInt32BE(Math.round(rootDelay * 65536), 4);
  packet.writeUInt32BE(Math.round(rootDispersion * 65536), 8);
  nonce.copy(packet, 24);
  const write = (seconds, at) => {
    const ntp = seconds + unixEpochOffset;
    packet.writeUInt32BE(Math.floor(ntp) % 4_294_967_296, at);
    packet.writeUInt32BE(Math.floor((ntp - Math.floor(ntp)) * 4_294_967_296), at + 4);
  };
  write(received, 32);
  write(sent, 40);
  return packet;
}

test('a question to a time server is 48 bytes that carry something for it to echo', () => {
  const nonce = Buffer.from('0102030405060708', 'hex');
  const packet = buildRequest(nonce);
  assert.equal(packet.length, 48);
  assert.equal(packet[0], 0x23);
  assert.deepEqual(packet.subarray(40, 48), nonce);
  assert.ok(packet.subarray(1, 40).every((byte) => byte === 0));
});

test('time server timestamps are read as seconds since 1970, also after they wrap round in 2036', () => {
  assert.equal(ntpToUnix(unixEpochOffset, 0), 0);
  assert.equal(ntpToUnix(unixEpochOffset + 1_800_000_000, 0x80000000), 1_800_000_000.5);
  // One second into the next era: 7 February 2036.
  assert.equal(ntpToUnix(1, 0), 4_294_967_296 - unixEpochOffset + 1);
});

test('an answer is read, and one that cannot be trusted is turned down', () => {
  const nonce = Buffer.from('a1a2a3a4a5a6a7a8', 'hex');
  const good = parseReply(reply(nonce, { received: 1_800_000_000.25, sent: 1_800_000_000.251 }), nonce);
  assert.equal(good.problem, undefined);
  assert.equal(good.stratum, 2);
  close(good.received, 1_800_000_000.25, 1e-6);
  close(good.sent, 1_800_000_000.251, 1e-6);
  close(good.rootDelay, 0.01, 1e-4);
  close(good.rootDispersion, 0.002, 1e-4);

  const times = { received: 1_800_000_000, sent: 1_800_000_000 };
  assert.match(parseReply(Buffer.alloc(20), nonce).problem, /too short/);
  assert.match(parseReply(reply(nonce, { ...times, mode: 3 }), nonce).problem, /not a server/);
  assert.match(parseReply(reply(nonce, { ...times, leap: 3 }), nonce).problem, /not set/);
  assert.match(parseReply(reply(nonce, { ...times, stratum: 0 }), nonce).problem, /refused/);
  assert.match(parseReply(reply(nonce, { ...times, stratum: 16 }), nonce).problem, /not set/);
  assert.match(parseReply(reply(Buffer.alloc(8, 9), times), nonce).problem, /another question/);
  assert.match(parseReply(reply(nonce, { received: 1_800_000_000, sent: -unixEpochOffset }), nonce).problem, /no time/);
});

test('an answer says how far off this clock is and how sure that is', () => {
  // This clock is 2 s behind. 30 ms on the way there, 1 ms at the server, 50 ms back.
  const asked = 1_800_000_000_000;
  const sample = sampleFrom({ received: 1_800_000_002.030, sent: 1_800_000_002.031, rootDelay: 0.01, rootDispersion: 0.002 }, asked, asked + 81);
  close(sample.delay, 80, 0.01);
  close(sample.offset, 1990, 0.01);
  close(sample.error, 40 + 5 + 2 + 1, 0.01);
  assert.ok(Math.abs(sample.offset - 2000) <= sample.error);
  // Nonsense: the answer arrived before the question left, or took for ever.
  assert.equal(sampleFrom({ received: 1_800_000_000, sent: 1_800_000_000.5, rootDelay: 0, rootDispersion: 0 }, asked, asked + 100), null);
  assert.equal(sampleFrom({ received: 1_800_000_000, sent: 1_800_000_000, rootDelay: 0, rootDispersion: 0 }, asked, asked + 5000), null);
});

test('the servers that agree outvote one that does not', () => {
  const agreed = agreeOn([{ offset: 12, error: 20 }, { offset: 9, error: 6 }, { offset: 3500, error: 4 }, { offset: 15, error: 30 }]);
  assert.deepEqual(agreed, { offset: 9, error: 6, servers: 3, asked: 4 });
  assert.deepEqual(agreeOn([{ offset: -40, error: 12 }]), { offset: -40, error: 12, servers: 1, asked: 1 });
  assert.equal(agreeOn([]), null);
});

/** A time server on this computer whose clock is `ahead` ms ahead; `silent` makes it not answer. */
async function fakeTimeServer({ ahead = 0, silent = false, stratum = 2 } = {}) {
  const socket = dgram.createSocket('udp4');
  let questions = 0;
  socket.on('message', (packet, from) => {
    questions += 1;
    if (silent) return;
    const now = (Date.now() + ahead) / 1000;
    socket.send(reply(packet.subarray(40, 48), { received: now, sent: now, stratum }), from.port, from.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { address: `127.0.0.1:${socket.address().port}`, questions: () => questions, close: () => new Promise((resolve) => socket.close(resolve)) };
}

test('a time server is asked over the network, and one that stays silent is given up on', async () => {
  const server = await fakeTimeServer({ ahead: 2500 });
  const sample = await askServer(server.address, { samples: 3, timeout: 500 });
  assert.equal(server.questions(), 3);
  close(sample.offset, 2500, 20);
  assert.ok(sample.error < 60, `error ${sample.error}`);
  await server.close();

  const quiet = await fakeTimeServer({ silent: true });
  const started = Date.now();
  assert.equal(await askServer(quiet.address, { samples: 3, timeout: 200 }), null);
  assert.ok(Date.now() - started < 1500);
  assert.equal(quiet.questions(), 1);
  await quiet.close();

  const refusing = await fakeTimeServer({ stratum: 0 });
  assert.equal(await askServer(refusing.address, { samples: 2, timeout: 200 }), null);
  await refusing.close();
});

test('the hub corrects its clock by what the time servers say, and says how sure it is', async () => {
  const fast = await fakeTimeServer({ ahead: 1800 });
  const alsoFast = await fakeTimeServer({ ahead: 1805 });
  const wrong = await fakeTimeServer({ ahead: -90_000 });
  const lines = [];
  const clock = new HubClock({ servers: [fast.address, wrong.address, alsoFast.address], log: (line) => lines.push(line) });
  assert.equal(clock.checked, false);
  assert.equal(clock.error, null);
  close(clock.time(), Date.now(), 5);

  assert.equal(await clock.check(), true);
  assert.equal(clock.checked, true);
  close(clock.time() - Date.now(), 1800, 30);
  assert.ok(clock.error > 0 && clock.error < 60, `error ${clock.error}`);
  assert.match(lines[0], /1\d\d\d ms behind the time servers \(2 of 3 agree/);
  for (const server of [fast, alsoFast, wrong]) await server.close();

  // No server to ask, or none that answers: the clock is used as it is.
  const alone = new HubClock({ servers: [] });
  assert.equal(await alone.check(), false);
  assert.equal(alone.checked, false);
  const unanswered = new HubClock({ servers: ['x'], ask: async () => null, log: (line) => lines.push(line) });
  assert.equal(await unanswered.check(), false);
  assert.match(lines.at(-1), /no time server answered/);
});
