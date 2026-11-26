// Runs the program that reads text in pictures, in a worker of its own, and
// looks after it: starts it, notices when it has stopped answering, and
// starts it again in its plain form if the quick form does not work on this
// iPad.
//
// The quick form uses several processor cores at once, for which it needs
// memory that is shared between them. Safari on iPads has been reported to
// refuse that memory on some versions of iPadOS. The plain form is an older
// version of the same program that uses one core and ordinary memory.

export const plainReader = Object.freeze({ program: 'plain', threads: 1 });

// How long the reader may stay silent before it is taken to be stuck.
const silenceWhileLoading = 60_000;
const silenceWhilePreparing = 45_000;
const longestScan = 20_000;

export class Reader {
  #worker = null;
  #onChange;
  #watchdog = null;
  #pending = null;
  #nextID = 1;
  #wanted = plainReader;
  #restarts = [];

  /** 'idle' | 'loading' | 'ready' | 'failed' */
  state = 'idle';
  /** How much of the reader has arrived, 0 to 1, while loading. */
  share = 0;
  /** True once everything has arrived and the program is being started. */
  preparing = false;
  /** Which form of the program is in use: 'quick' or 'plain'. */
  program = 'plain';
  /** How many processor cores the reader uses. */
  threads = 0;
  /** True if the quick form was asked for and did not work here. */
  fellBack = false;
  /** Why it failed, if it did. */
  problem = '';

  constructor({ onChange = () => {} } = {}) {
    this.#onChange = onChange;
  }

  /**
   * Starts the reader, or starts it again.
   *
   * @param {{program: 'quick'|'plain', threads: number}} wanted
   */
  start(wanted) {
    this.#begin(wanted.program === 'quick' ? { program: 'quick', threads: Math.max(1, Math.trunc(wanted.threads) || 1) } : plainReader, false);
  }

  #begin(wanted, fellBack) {
    this.stop();
    this.#wanted = wanted;
    this.program = wanted.program;
    this.fellBack = fellBack;
    this.state = 'loading';
    this.share = 0;
    this.preparing = false;
    this.problem = '';
    let worker;
    try {
      worker = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      this.#fail(`The reader could not be started (${error.message}).`);
      return;
    }
    this.#worker = worker;
    worker.onmessage = (event) => {
      if (worker === this.#worker) this.#heard(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (worker === this.#worker) this.#gaveUp(event.message || 'its program could not be loaded');
    };
    worker.postMessage({ type: 'start', program: wanted.program, threads: wanted.threads });
    this.#watch(silenceWhileLoading);
    this.#onChange();
  }

  stop() {
    clearTimeout(this.#watchdog);
    this.#watchdog = null;
    if (this.#worker) {
      this.#worker.onmessage = null;
      this.#worker.onerror = null;
      this.#worker.terminate();
      this.#worker = null;
    }
    if (this.#pending) {
      const pending = this.#pending;
      this.#pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('the reader was stopped'));
    }
    this.state = 'idle';
  }

  #watch(silence) {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => this.#gaveUp('it did not start in time'), silence);
  }

  #fail(problem) {
    this.stop();
    this.state = 'failed';
    this.problem = problem;
    this.#onChange();
  }

  /** The reader could not start as it was asked to, or has stopped answering: try again, in the plain form if need be. */
  #gaveUp(reason) {
    if (this.state === 'ready') {
      // Went wrong after it had been working: start it again as it was,
      // unless that has been tried several times in the last few minutes.
      const now = Date.now();
      this.#restarts = this.#restarts.filter((at) => now - at < 180_000);
      this.#restarts.push(now);
      if (this.#restarts.length <= 3) {
        this.#begin(this.#wanted, this.fellBack);
        return;
      }
      if (this.#wanted.program === 'plain') {
        this.#fail(`The bib reader keeps stopping on this device: ${reason}.`);
        return;
      }
      this.#restarts = [];
    }
    if (this.#wanted.program === 'quick') {
      this.#begin(plainReader, true);
      return;
    }
    this.#fail(`The bib reader could not be started on this device: ${reason}.`);
  }

  #heard(message) {
    if (message.type === 'loading') {
      this.share = message.share;
      this.preparing = message.preparing === true;
      this.#watch(this.preparing ? silenceWhilePreparing : silenceWhileLoading);
      this.#onChange();
    } else if (message.type === 'ready') {
      clearTimeout(this.#watchdog);
      this.#watchdog = null;
      this.state = 'ready';
      this.threads = message.threads;
      this.share = 1;
      this.#onChange();
    } else if (message.type === 'result') {
      const pending = this.#pending;
      if (!pending || pending.id !== message.id) return;
      this.#pending = null;
      clearTimeout(pending.timer);
      pending.resolve(message);
    } else if (message.type === 'error') {
      if (message.during === 'start') {
        this.#gaveUp(message.message);
        return;
      }
      const pending = this.#pending;
      if (!pending || pending.id !== message.id) return;
      this.#pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error(message.message));
    }
  }

  /**
   * Reads the text in a picture. One picture at a time.
   *
   * @param {Uint8ClampedArray} pixels the picture as RGBA; handed over to the reader, not usable afterwards
   * @returns {Promise<{texts: object[], found: number, timing: object}>}
   */
  scan(pixels, width, height, options) {
    if (this.state !== 'ready' || this.#pending) return Promise.reject(new Error('the reader is busy or not ready'));
    return new Promise((resolve, reject) => {
      const id = this.#nextID;
      this.#nextID += 1;
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = null;
        reject(new Error('the reader did not answer'));
        this.#gaveUp('it stopped answering');
      }, longestScan);
      this.#pending = { id, resolve, reject, timer };
      this.#worker.postMessage({ type: 'scan', id, pixels: pixels.buffer, width, height, options }, [pixels.buffer]);
    });
  }
}
