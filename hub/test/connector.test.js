// Runs the program that passes results on to RunScore (public/runscore.ps1)
// against a real hub and a stand-in for RunScore: a TCP server that keeps the
// lines it is sent.
//
// The program is PowerShell, so these tests need PowerShell: "pwsh"
// (PowerShell 7) or "powershell" (the one that comes with Windows). Each one
// found is tested. Where there is none the tests are skipped, unless
// BIBTIMER_POWERSHELL_REQUIRED is set, as it is in CI.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHub } from '../server.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'runscore.ps1');
const key = 'connector-test-key';
const deviceA = 'AAAAAAAA-0000-4000-8000-000000000001';
const deviceB = 'BBBBBBBB-0000-4000-8000-000000000002';
const start = 1_609_459_200; // 2021-01-01T00:00:00Z

// ---- Which PowerShells there are ----

function versionOf(shell) {
  try {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8', timeout: 120_000, windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

const runners = [];
for (const shell of (process.env.BIBTIMER_POWERSHELL ?? 'pwsh,powershell').split(',').map((name) => name.trim()).filter(Boolean)) {
  const version = versionOf(shell);
  if (version) {
    runners.push({
      name: `${shell} ${version}`,
      // The program started from its file, as when it has been downloaded.
      fromFile: (args) => [shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]],
      // The program fetched from the hub and run without ever being a file:
      // the line the results page gives the operator to paste.
      fromHub: (base, args) => [shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `& ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing '${base}/runscore.ps1'))) ${args.join(' ')}`]],
    });
  }
}
// A stand-in for the program itself, for working on these tests where there is no PowerShell.
if (process.env.BIBTIMER_CONNECTOR_STANDIN) {
  runners.push({
    name: 'stand-in',
    fromFile: (args) => [process.execPath, [process.env.BIBTIMER_CONNECTOR_STANDIN, ...args]],
    fromHub: null,
  });
}

// ---- A stand-in for RunScore ----

class FakeRunScore {
  lines = [];
  raw = '';
  connections = 0;
  #sockets = new Set();
  #server = null;

  /** Starts listening; on the same port as before if it has listened already. */
  async listen() {
    this.#server = net.createServer((socket) => {
      this.connections += 1;
      this.#sockets.add(socket);
      socket.setEncoding('utf8');
      let pending = '';
      socket.on('data', (chunk) => {
        this.raw += chunk;
        pending += chunk;
        // A line ends with CR LF, LF or CR, whichever the sender was told to use.
        for (;;) {
          const match = /\r\n|\n|\r(?!$)/.exec(pending) ?? (pending.endsWith('\r') ? { index: pending.length - 1, 0: '\r' } : null);
          if (!match) break;
          this.lines.push(pending.slice(0, match.index));
          pending = pending.slice(match.index + match[0].length);
        }
      });
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.port ?? 0, '127.0.0.1', resolve);
    });
    this.port = this.#server.address().port;
  }

  /** Goes away the way a program does when it is closed. */
  async stop() {
    if (!this.#server) return;
    const closed = new Promise((resolve) => this.#server.close(resolve));
    for (const socket of this.#sockets) socket.destroy();
    await closed;
    this.#server = null;
  }
}

// ---- Helpers ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// PowerShell can take seconds to start; a test that hangs must still end.
const patient = { timeout: 300_000 };

/** Waits until `condition` holds; fails with `explain()` if it never does. */
async function until(condition, explain, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${explain()}`);
    await sleep(100);
  }
}

function crossing(id, bib, seconds, extra = {}) {
  return { id, bib, time: start + seconds, timing: 'line', source: 'camera', clock: 'ntp', clockError: 0.012, confidence: 1, note: '', ...extra };
}

for (const runner of runners) {
  describe(`the RunScore connector, run by ${runner.name}`, () => {
    let hub;
    let base;
    let folder;
    const running = new Set();
    const listeners = new Set();

    before(async () => {
      hub = await startHub({ host: '127.0.0.1', key });
      base = `http://127.0.0.1:${hub.port}`;
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-test-'));
    });

    after(async () => {
      for (const connector of [...running]) await connector.stop();
      for (const listener of listeners) await listener.stop();
      await hub.close();
      fs.rmSync(folder, { recursive: true, force: true });
    });

    /** A stand-in for RunScore that is listening, and is cleared away when the tests are over. */
    async function runScoreListening() {
      const runScore = new FakeRunScore();
      listeners.add(runScore);
      await runScore.listen();
      return runScore;
    }

    async function upload(code, device, crossings, extra = {}) {
      const response = await fetch(`${base}/api/events/${code}/sources/${device}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: 'Finish', raceName: 'Connector Dash', timeZone: 'UTC', startTime: start, full: false, crossings, deleted: [], ...extra }),
      });
      assert.equal(response.status, 200, await response.text());
    }

    /** The settings every run shares: the hub, a short wait, and its own place to keep its record. */
    function settings(code, runScore, extra = [], { useKey = key, state = code } = {}) {
      return [
        '-Hub', base, '-Key', useKey, '-EventCode', code, '-RunScorePort', String(runScore.port),
        '-Settle', '0', '-Wait', '2', '-StateFolder', path.join(folder, state), ...extra,
      ];
    }

    function launch([command, args]) {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
      const exited = new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
      const connector = {
        output: () => output,
        exited,
        isRunning: () => child.exitCode === null && child.signalCode === null,
        async stop() {
          running.delete(connector);
          if (connector.isRunning()) child.kill();
          await exited;
        },
      };
      running.add(connector);
      return connector;
    }

    const explain = (runScore, connector) => () =>
      `RunScore has ${JSON.stringify(runScore.lines)}\n--- the connector said ---\n${connector.output()}`;

    test('results are passed on in order and once, also across a stop and a start', patient, async () => {
      const code = 'pass-on';
      const runScore = await runScoreListening();
      await upload(code, deviceA, [crossing('a2', '12', 1500.25), crossing('a1', '7', 1432.5), crossing('a3', '305', 1501.999)]);

      let connector = launch(runner.fromFile(settings(code, runScore)));
      await until(() => runScore.lines.length >= 3, explain(runScore, connector));
      assert.deepEqual(runScore.lines, ['RSBI,7,00:23:52.50,Finish', 'RSBI,12,00:25:00.25,Finish', 'RSBI,305,00:25:01.99,Finish']);
      assert.ok(runScore.raw.endsWith('RSBI,305,00:25:01.99,Finish\r\n'), JSON.stringify(runScore.raw));

      // A result that comes in while it is running.
      await upload(code, deviceA, [crossing('a4', '41', 1510)]);
      await until(() => runScore.lines.length >= 4, explain(runScore, connector));
      assert.equal(runScore.lines[3], 'RSBI,41,00:25:10.00,Finish');
      // A mark without a number is nothing to pass on, until it has one.
      await upload(code, deviceA, [crossing('a5', '', 1511, { source: 'manual', timing: 'manual' })]);
      await sleep(1500);
      assert.equal(runScore.lines.length, 4);
      assert.match(connector.output(), /Connected to RunScore/);
      assert.match(connector.output(), /-> RSBI,41,00:25:10\.00,Finish/);
      await connector.stop();

      // Results recorded while it was not running are passed on when it is started again; the earlier ones are not.
      await upload(code, deviceA, [crossing('a5', '88', 1511, { source: 'manual', timing: 'manual' }), crossing('a6', '90', 1520.5)]);
      connector = launch(runner.fromFile(settings(code, runScore)));
      await until(() => runScore.lines.length >= 6, explain(runScore, connector));
      await sleep(1500);
      assert.deepEqual(runScore.lines.slice(4), ['RSBI,88,00:25:11.00,Finish', 'RSBI,90,00:25:20.50,Finish']);
      assert.match(connector.output(), /Passed on before: 4\./);
      await connector.stop();

      // Its record of what went to RunScore is a file of the same lines.
      const record = fs.readdirSync(path.join(folder, code)).find((name) => name.endsWith('.sent.txt'));
      assert.deepEqual(fs.readFileSync(path.join(folder, code, record), 'utf8').trim().split(/\r?\n/), runScore.lines);

      // Told to forget, it passes everything on again.
      connector = launch(runner.fromFile(settings(code, runScore, ['-ResendAll'])));
      await until(() => runScore.lines.length >= 12, explain(runScore, connector));
      assert.deepEqual(runScore.lines.slice(6), runScore.lines.slice(0, 6));
      await connector.stop();
    });

    test('it waits for RunScore, and what RunScore missed while it was closed arrives when it is back', patient, async () => {
      const code = 'runscore-away';
      const runScore = await runScoreListening();
      await runScore.stop();
      await upload(code, deviceA, [crossing('a1', '7', 1432.5), crossing('a2', '12', 1500.25)]);

      const connector = launch(runner.fromFile(settings(code, runScore)));
      await until(() => /Waiting for RunScore/.test(connector.output()), explain(runScore, connector));
      assert.equal(runScore.lines.length, 0);

      await runScore.listen();
      await until(() => runScore.lines.length >= 2, explain(runScore, connector));
      assert.deepEqual(runScore.lines, ['RSBI,7,00:23:52.50,Finish', 'RSBI,12,00:25:00.25,Finish']);
      // It counts a result as passed on a moment after writing it, once it
      // has seen that RunScore is still there. (Were RunScore to close in
      // that moment, the result would be passed on again later: twice
      // rather than not at all.)
      await until(() => /-> RSBI,12,00:25:00\.25,Finish/.test(connector.output()), explain(runScore, connector));

      // RunScore is closed in the middle of the race, and results keep coming.
      await runScore.stop();
      await upload(code, deviceA, [crossing('a3', '305', 1501.75)]);
      await until(() => /RunScore (has closed the connection|went away)/.test(connector.output()), explain(runScore, connector));
      await upload(code, deviceA, [crossing('a4', '41', 1510)]);
      await sleep(1000);

      await runScore.listen();
      await until(() => runScore.lines.length >= 4, explain(runScore, connector));
      await sleep(1500);
      assert.deepEqual(runScore.lines.slice(2), ['RSBI,305,00:25:01.75,Finish', 'RSBI,41,00:25:10.00,Finish']);
      await connector.stop();
    });

    test('a hub that starts its list over does not make it pass results on twice; corrections come with a note', patient, async () => {
      const code = 'starting-over';
      const runScore = await runScoreListening();
      await upload(code, deviceA, [crossing('a1', '7', 1432.5), crossing('a2', '12', 1500.25)]);
      const connector = launch(runner.fromFile(settings(code, runScore)));
      await until(() => runScore.lines.length >= 2, explain(runScore, connector));

      // The event is removed from the hub and the iPad sends everything again, with one result more.
      const removed = await fetch(`${base}/api/events/${code}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
      assert.equal(removed.status, 200);
      await upload(code, deviceA, [crossing('a1', '7', 1432.5), crossing('a2', '12', 1500.25), crossing('a3', '305', 1501.75)], { full: true });
      await until(() => runScore.lines.length >= 3, explain(runScore, connector));
      await sleep(1500);
      assert.deepEqual(runScore.lines, ['RSBI,7,00:23:52.50,Finish', 'RSBI,12,00:25:00.25,Finish', 'RSBI,305,00:25:01.75,Finish']);

      // A number is corrected on the iPad after it went to RunScore, and a result is deleted.
      await upload(code, deviceA, [crossing('a2', '21', 1500.25)], { deleted: ['a3'] });
      await until(() => runScore.lines.length >= 4 && /Removed on the iPad/.test(connector.output()), explain(runScore, connector));
      assert.equal(runScore.lines[3], 'RSBI,21,00:25:00.25,Finish');
      assert.match(connector.output(), /NOTE {2}Corrected on the iPad \(Finish\): bib 12 at 00:25:00\.25 should be bib 21\./);
      assert.match(connector.output(), /NOTE {2}Removed on the iPad \(Finish\) after it was passed on: bib 305 at 00:25:01\.75\./);
      await connector.stop();
    });

    test('one iPad only, written the way it was asked for', patient, async () => {
      const code = 'as-asked';
      const runScore = await runScoreListening();
      await upload(code, deviceA, [crossing('a1', '7', 1432.5)], { station: 'Finish A' });
      await upload(code, deviceB, [crossing('b1', '7', 1432.875), crossing('b2', '12', 1500.5)], { station: 'Finish B' });

      const extra = ['-Devices', deviceB, '-Location', 'FINISH', '-Decimals', '3', '-Prefix', 'rsci', '-LineEnding', 'LF'];
      const connector = launch(runner.fromFile(settings(code, runScore, extra)));
      await until(() => runScore.lines.length >= 2, explain(runScore, connector));
      await sleep(1500);
      assert.deepEqual(runScore.lines, ['RSCI,7,00:23:52.875,FINISH', 'RSCI,12,00:25:00.500,FINISH']);
      assert.equal(runScore.raw, 'RSCI,7,00:23:52.875,FINISH\nRSCI,12,00:25:00.500,FINISH\n');
      await connector.stop();

      // The other iPad into a second RunScore port, with times since the start.
      const second = await runScoreListening();
      const other = launch(runner.fromFile(settings(code, second, ['-Devices', deviceA, '-Time', 'elapsed', '-Decimals', '1'])));
      await until(() => second.lines.length >= 1, explain(second, other));
      assert.deepEqual(second.lines, ['RSBI,7,0:23:52.5,Finish A']);
      await other.stop();
      await second.stop();
      await runScore.stop();
    });

    test('the connection to RunScore can be checked with one made-up result', patient, async () => {
      const runScore = await runScoreListening();
      const check = launch(runner.fromFile(['-Test', '-RunScorePort', String(runScore.port)]));
      const exitCode = await check.exited;
      await until(() => runScore.lines.length >= 1, explain(runScore, check), 10_000);
      assert.match(runScore.lines[0], /^RSBI,9999,\d\d:\d\d:\d\d\.\d\d,TEST$/);
      assert.match(check.output(), /Sent to RunScore/);
      assert.equal(exitCode, 0);
      await runScore.stop();

      // With nothing listening, it says so and stops.
      const nobody = launch(runner.fromFile(['-Test', '-RunScorePort', String(runScore.port)]));
      await nobody.exited;
      assert.match(nobody.output(), /Nothing is listening/);
    });

    test('a key the hub does not accept is explained, and it keeps trying', patient, async () => {
      const code = 'wrong-key';
      const runScore = await runScoreListening();
      await upload(code, deviceA, [crossing('a1', '7', 1432.5)]);
      const connector = launch(runner.fromFile(settings(code, runScore, [], { useKey: 'not-the-key-at-all' })));
      await until(() => /did not accept the access key/.test(connector.output()), explain(runScore, connector));
      await sleep(1000);
      assert.equal(connector.isRunning(), true);
      assert.equal(runScore.lines.length, 0);
      await connector.stop();
      await runScore.stop();
    });

    test('it can be started straight from the hub, without being saved as a file first', { ...patient, skip: runner.fromHub ? false : 'not for the stand-in' }, async () => {
      const code = 'from-the-hub';
      const runScore = await runScoreListening();
      await upload(code, deviceA, [crossing('a1', '7', 1432.5), crossing('a2', '12', 1500.25)]);
      const quoted = settings(code, runScore).map((value) => (value.startsWith('-') ? value : `'${value.replaceAll("'", "''")}'`));
      const connector = launch(runner.fromHub(base, quoted));
      await until(() => runScore.lines.length >= 2, explain(runScore, connector));
      assert.deepEqual(runScore.lines, ['RSBI,7,00:23:52.50,Finish', 'RSBI,12,00:25:00.25,Finish']);
      await connector.stop();
      await runScore.stop();
    });
  });
}

if (runners.length === 0) {
  test('the RunScore connector', { skip: process.env.BIBTIMER_POWERSHELL_REQUIRED ? false : 'no PowerShell on this computer' }, () => {
    assert.fail('PowerShell is required for these tests (BIBTIMER_POWERSHELL_REQUIRED is set) but none was found.');
  });
}
