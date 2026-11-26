// Checks the hub's clock against NTP time servers.
//
// The iPads take their time from the hub (a page in a browser cannot ask a
// time server itself), so the hub has to know how far its own clock is off.
// It asks several servers and takes the answer most of them agree on.

import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';

export const defaultTimeServers = ['time.cloudflare.com', 'time.google.com', 'time.apple.com', 'pool.ntp.org'];

// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
const unixEpochOffset = 2_208_988_800;

/** Seconds since 1970 for an NTP timestamp (whole seconds since 1900 and a binary fraction). */
export function ntpToUnix(seconds, fraction) {
  // The seconds field wraps round in February 2036. A value that would fall
  // before 1970 cannot be a current time, so it belongs to the next era.
  const whole = seconds < unixEpochOffset ? seconds + 4_294_967_296 : seconds;
  return whole - unixEpochOffset + fraction / 4_294_967_296;
}

/**
 * A request to a time server. The eight bytes of `nonce` go where the
 * server will echo them back, which ties its answer to this question.
 */
export function buildRequest(nonce) {
  const packet = Buffer.alloc(48);
  packet[0] = 0x23; // no leap warning, version 4, client
  nonce.copy(packet, 40, 0, 8);
  return packet;
}

/**
 * Reads a server's answer. Returns what it says, or `{ problem }` if it is
 * not an answer to trust.
 */
export function parseReply(packet, nonce) {
  if (!Buffer.isBuffer(packet) || packet.length < 48) return { problem: 'the answer was too short' };
  if ((packet[0] & 0x07) !== 4) return { problem: 'it was not a server\'s answer' };
  if (packet[0] >> 6 === 3) return { problem: 'the server\'s own clock is not set' };
  const stratum = packet[1];
  if (stratum === 0) return { problem: `the server refused (${packet.toString('latin1', 12, 16).replace(/[^\x20-\x7e]/g, '')})` };
  if (stratum > 15) return { problem: 'the server\'s own clock is not set' };
  if (!packet.subarray(24, 32).equals(nonce.subarray(0, 8))) return { problem: 'the answer belongs to another question' };
  const transmitSeconds = packet.readUInt32BE(40);
  const transmitFraction = packet.readUInt32BE(44);
  if (transmitSeconds === 0 && transmitFraction === 0) return { problem: 'the answer carried no time' };
  return {
    stratum,
    // How far the server itself is from the source of its time, in seconds.
    rootDelay: packet.readInt32BE(4) / 65536,
    rootDispersion: packet.readUInt32BE(8) / 65536,
    received: ntpToUnix(packet.readUInt32BE(32), packet.readUInt32BE(36)),
    sent: ntpToUnix(transmitSeconds, transmitFraction),
  };
}

/**
 * What one answer says about this computer's clock.
 *
 * @param {object} reply from `parseReply`
 * @param {number} asked when the question left, by this computer's clock, in milliseconds
 * @param {number} answered when the answer arrived, in milliseconds
 * @returns {{offset: number, delay: number, error: number}|null} milliseconds: what to add to this
 *   computer's clock, the time spent on the way, and how far off the result can be
 */
export function sampleFrom(reply, asked, answered) {
  const t1 = asked / 1000;
  const t4 = answered / 1000;
  const delay = (t4 - t1) - (reply.sent - reply.received);
  // This computer's clock is read in whole milliseconds, so the time on the
  // way can come out a hair below zero; a real negative means nonsense.
  if (!(delay > -0.002) || delay > 3) return null;
  const offset = ((reply.received - t1) + (reply.sent - t4)) / 2;
  const error = Math.max(delay, 0) / 2 + Math.abs(reply.rootDelay) / 2 + reply.rootDispersion + 0.001;
  return { offset: offset * 1000, delay: Math.max(delay, 0) * 1000, error: error * 1000 };
}

/**
 * The answer most servers agree on: the most exact one among those that do
 * not contradict the middle one.
 *
 * @param {{offset: number, error: number}[]} samples the best sample of each server
 */
export function agreeOn(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.offset - b.offset);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  const agreeing = sorted.filter((sample) => Math.abs(sample.offset - middle.offset) <= sample.error + middle.error + 10);
  const best = agreeing.reduce((chosen, sample) => (sample.error < chosen.error ? sample : chosen), agreeing[0]);
  return { offset: best.offset, error: best.error, servers: agreeing.length, asked: samples.length };
}

/**
 * Asks one time server a few times and returns its best answer, or null.
 *
 * @param {string} server a host name, or "host:port"
 */
export function askServer(server, { samples = 3, timeout = 1500, now = Date.now } = {}) {
  const separator = server.lastIndexOf(':');
  const host = separator > 0 ? server.slice(0, separator) : server;
  const port = separator > 0 ? Number(server.slice(separator + 1)) : 123;

  return new Promise((resolve) => {
    let best = null;
    let remaining = samples;
    let nonce = null;
    let asked = 0;
    let timer = null;
    const socket = dgram.createSocket('udp4');
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Closed already.
      }
      resolve(best);
    };
    const ask = () => {
      if (remaining === 0) return finish();
      remaining -= 1;
      nonce = randomBytes(8);
      asked = now();
      socket.send(buildRequest(nonce), port, host, (error) => {
        if (error) finish();
      });
      clearTimeout(timer);
      timer = setTimeout(finish, timeout);
    };
    socket.on('message', (packet) => {
      const answered = now();
      const reply = parseReply(packet, nonce);
      if (reply.problem) return; // a stray or late packet: keep waiting for the right one
      const sample = sampleFrom(reply, asked, answered);
      if (sample && (best === null || sample.delay < best.delay)) best = sample;
      ask();
    });
    socket.on('error', finish);
    ask();
  });
}

/** Keeps track of how far the hub's clock is from true time. */
export class HubClock {
  #servers;
  #now;
  #log;
  #ask;
  #fix = null;
  #timer = null;
  #checking = null;

  /**
   * @param {object} options
   * @param {string[]} options.servers time servers to ask; none means the clock is never checked
   * @param {() => number} options.now this computer's clock, in milliseconds
   * @param {(server: string) => Promise<object|null>} options.ask asks one server (replaced in tests)
   */
  constructor({ servers = [], now = Date.now, log = () => {}, ask = (server) => askServer(server, { now }) } = {}) {
    this.#servers = servers;
    this.#now = now;
    this.#log = log;
    this.#ask = ask;
  }

  /** Checks now, and from then on every ten minutes (sooner after a failure). */
  start() {
    if (this.#servers.length === 0 || this.#timer) return;
    const again = async () => {
      const found = await this.check();
      this.#timer = setTimeout(again, found ? 600_000 : 60_000);
      this.#timer.unref();
    };
    this.#timer = setTimeout(again, 0);
    this.#timer.unref();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Asks the time servers once. Returns whether an answer was found. */
  async check() {
    if (this.#checking) return this.#checking;
    this.#checking = (async () => {
      const answers = (await Promise.all(this.#servers.map((server) => this.#ask(server).catch(() => null)))).filter((sample) => sample !== null);
      const agreed = agreeOn(answers);
      if (!agreed) {
        if (!this.#fix) this.#log('no time server answered; the clock of this computer is used as it is');
        return false;
      }
      const first = this.#fix === null;
      this.#fix = { offset: agreed.offset, error: agreed.error, at: this.#now(), servers: agreed.servers };
      if (first) {
        this.#log(`this computer's clock is ${Math.abs(agreed.offset).toFixed(0)} ms ${agreed.offset >= 0 ? 'behind' : 'ahead of'} the time servers ` +
          `(${agreed.servers} of ${agreed.asked} agree, to within ${agreed.error.toFixed(0)} ms); the hub allows for that`);
      }
      return true;
    })();
    try {
      return await this.#checking;
    } finally {
      this.#checking = null;
    }
  }

  /** True once the clock has been checked against time servers. */
  get checked() {
    return this.#fix !== null;
  }

  /** The time, in milliseconds since 1970, corrected by what the time servers said. */
  time() {
    return this.#now() + (this.#fix ? this.#fix.offset : 0);
  }

  /** How far off `time()` can be, in milliseconds; null if the clock has never been checked. */
  get error() {
    if (!this.#fix) return null;
    // A computer's clock drifts; an old check counts for less.
    return this.#fix.error + Math.abs(this.#now() - this.#fix.at) * 20e-6;
  }
}
