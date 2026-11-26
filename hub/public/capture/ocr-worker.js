// Reads text in pictures, away from the page so that the page stays quick
// to the touch. The page sends pictures; this sends back what is written in
// them and where.
//
// The program that does the reading comes in two forms (see reader.js): the
// quick one, which uses several processor cores at once, and the plain one,
// which uses one and asks nothing unusual of the browser.

import { createEngine } from './engine.js';

const programs = {
  quick: {
    module: '/vendor/ort.wasm.min.mjs', folder: '/vendor/', binary: '/vendor/ort-wasm-simd-threaded.wasm', size: 14.8e6,
    // The part of the program that each of its helpers on other cores starts from.
    helper: '/vendor/ort-wasm-simd-threaded.mjs',
  },
  plain: { module: '/vendor/plain/ort.wasm.min.js', folder: '/vendor/plain/', binary: '/vendor/plain/ort-wasm-simd.wasm', size: 10.6e6, helper: null },
};

/** An address under which this text can be loaded as a program without asking the network. */
function asProgram(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
}

/**
 * Loads a part of the program. If it cannot be had the usual way (there is
 * no connection, and the browser does not answer this from the copy kept on
 * the iPad), it is taken out of that copy by hand.
 */
async function load(url) {
  try {
    return await import(url);
  } catch (error) {
    let kept;
    try {
      kept = await fetchWithProgress(url, () => {});
    } catch {
      throw error;
    }
    return import(asProgram(kept));
  }
}

let engine = null;

/**
 * Fetches one of the reader's files and reports how much of it has arrived.
 * Without a connection, the copy kept on the iPad is used.
 */
async function fetchWithProgress(url, onProgress) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    response = await self.caches?.match(url, { ignoreVary: true });
    if (!response) throw new Error(`${url} could not be fetched (${error.message})`);
  }
  if (!response.ok) throw new Error(`${url} could not be fetched (${response.status})`);
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    onProgress(all.length);
    return all;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(value.length);
  }
  const all = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

async function start({ program, threads }) {
  const chosen = programs[program] ?? programs.plain;
  // Roughly what has to arrive, unpacked, for a sensible "x % loaded".
  const expected = chosen.size + 4.7e6 + 9.0e6;
  let arrived = 0;
  let told = 0;
  const progress = (bytes) => {
    arrived += bytes;
    const share = Math.min(0.99, arrived / expected);
    // Not for every little piece: a hundred messages are plenty.
    if (share - told >= 0.01 || share === 0.99) {
      told = share;
      self.postMessage({ type: 'loading', share });
    }
  };
  const [ort, helper, binary, detection, recognition, characters] = await Promise.all([
    load(chosen.module),
    chosen.helper ? fetchWithProgress(chosen.helper, () => {}) : null,
    fetchWithProgress(chosen.binary, progress),
    fetchWithProgress('/vendor/detection.onnx', progress),
    fetchWithProgress('/vendor/recognition.onnx', progress),
    fetchWithProgress('/vendor/characters.txt', () => {}),
  ]);
  const dictionary = new TextDecoder().decode(characters).split(/\r?\n/).filter((line) => line !== '');
  self.postMessage({ type: 'loading', share: 0.99, preparing: true });

  // The helpers on other cores are started from a copy held here, not from
  // the network: a browser fetches a helper's program afresh each time, past
  // the copy kept on the iPad, and without a connection that fails.
  ort.env.wasm.wasmPaths = helper ? { mjs: asProgram(helper) } : chosen.folder;
  ort.env.wasm.wasmBinary = binary.buffer;
  ort.env.wasm.proxy = false;
  ort.env.wasm.numThreads = chosen === programs.quick ? threads : 1;
  engine = await createEngine({ ort, detection, recognition, dictionary });
  // The first look is slow while the browser warms the program up; get it
  // over with before a runner arrives.
  const blank = new Uint8ClampedArray(320 * 192 * 4).fill(128);
  await engine.scan(blank, 320, 192, { maxSide: 320 });
  self.postMessage({ type: 'ready', threads: ort.env.wasm.numThreads });
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      await start(message);
    } else if (message.type === 'scan') {
      if (!engine) throw new Error('the reader is not ready');
      const pixels = new Uint8ClampedArray(message.pixels);
      const result = await engine.scan(pixels, message.width, message.height, message.options);
      self.postMessage({ type: 'result', id: message.id, texts: result.texts, found: result.found, timing: result.timing });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: message.id ?? null, during: message.type, message: String(error?.message ?? error) });
  }
};
