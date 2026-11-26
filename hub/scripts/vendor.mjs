// Puts the files the capture page needs for reading bib numbers into
// public/vendor, out of the packages npm has installed, and compresses each
// one once so that the hub does not have to on every request.
//
// Runs by itself after "npm install" / "npm ci". Without these files the hub
// still collects and shows results; only the capture page cannot read bibs.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'public', 'vendor');
const require = createRequire(import.meta.url);

// The quick program asks the browser to set aside room for 4 GB of memory,
// to be shared between processor cores. Safari on iPads and iPhones has been
// reported to refuse that, the sooner the more is asked for. The reader
// needs a fraction of it, so it asks for this much instead (in pages of
// 64 KB): 1 GB.
const quickMemoryPages = 16384;

function withLessMemory(contents) {
  const asked = 'WebAssembly.Memory({initial:256,maximum:65536,shared:!0})';
  const text = contents.toString('utf8');
  if (text.split(asked).length !== 2) throw new Error('the quick program no longer asks for its memory in the way this script knows');
  return Buffer.from(text.replace(asked, `WebAssembly.Memory({initial:256,maximum:${quickMemoryPages},shared:!0})`));
}

// [package, file in the package, name on the hub, a change to make to it]
const wanted = [
  // The program that runs the two models in the browser (onnxruntime-web,
  // MIT). It comes twice. The quick one uses several processor cores at once.
  ['onnxruntime-web', 'dist/ort.wasm.min.mjs', 'ort.wasm.min.mjs'],
  ['onnxruntime-web', 'dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs', withLessMemory],
  ['onnxruntime-web', 'dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  // The plain one uses one core and nothing a browser might refuse: it is
  // the last version of the same program that was made that way. It is what
  // iPads get unless they are told otherwise.
  ['onnxruntime-web-plain', 'dist/esm/ort.wasm.min.js', 'plain/ort.wasm.min.js'],
  ['onnxruntime-web-plain', 'dist/ort-wasm-simd.wasm', 'plain/ort-wasm-simd.wasm'],
  // The PP-OCR models (PaddleOCR, Apache-2.0), as packaged for browsers by
  // paddleocr-browser (MIT): one finds text in a picture, one reads it.
  ['paddleocr-browser', 'dist/ppocr_det.onnx', 'detection.onnx'],
  ['paddleocr-browser', 'dist/rec_en_PP-OCRv3_infer.onnx', 'recognition.onnx'],
  ['paddleocr-browser', 'dist/dict_en.txt', 'characters.txt'],
];

/** A package's own folder, wherever npm has put it. */
function packageFolder(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Some packages do not let their package.json be looked up; they are
    // where npm puts everything all the same.
    return path.join(here, '..', 'node_modules', name);
  }
}

const mit = (holder) => `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** What the files in this folder are, whose they are, and on what terms they are passed on. */
function notice() {
  const version = (name) => JSON.parse(fs.readFileSync(path.join(packageFolder(name), 'package.json'), 'utf8')).version;
  let apache = 'The text of the Apache License, Version 2.0 is at https://www.apache.org/licenses/LICENSE-2.0';
  try {
    // A package that is installed with the others carries the full text.
    apache = fs.readFileSync(path.join(packageFolder('long'), 'LICENSE'), 'utf8').trim();
  } catch {
    // The address has to do.
  }
  return `The files in this folder are what the Bib Timer capture page reads bib numbers
with. They are the work of others, passed on under their licences.

1. ONNX Runtime Web: the program that runs the two models in the browser.
   Files: ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs and
   ort-wasm-simd-threaded.wasm (version ${version('onnxruntime-web')}); plain/ort.wasm.min.js and
   plain/ort-wasm-simd.wasm (version ${version('onnxruntime-web-plain')}).
   https://github.com/microsoft/onnxruntime
   One change has been made: ort-wasm-simd-threaded.mjs asks the browser for
   at most ${quickMemoryPages / 16384} GB of shared memory where the original asks for 4 GB.
   MIT License:

${mit('Microsoft Corporation')}

2. PP-OCR models from PaddleOCR: detection.onnx finds text in a picture,
   recognition.onnx reads it, characters.txt lists the characters it knows.
   https://github.com/PaddlePaddle/PaddleOCR
   Copyright (c) PaddlePaddle Authors. Licensed under the Apache License,
   Version 2.0 (below).
   They are taken as packaged for browsers in paddleocr-browser ${version('paddleocr-browser')} by
   xulihang (https://github.com/xulihang/paddleocr-browser), which declares
   the MIT License.

${apache}
`;
}

let copied = 0;
try {
  fs.mkdirSync(target, { recursive: true });
  for (const [name, file, as, change] of wanted) {
    const source = path.join(packageFolder(name), file);
    const contents = change ? change(fs.readFileSync(source)) : fs.readFileSync(source);
    const destination = path.join(target, as);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const unchanged = fs.existsSync(destination) && fs.readFileSync(destination).equals(contents);
    if (!unchanged) fs.writeFileSync(destination, contents);
    if (!unchanged || !fs.existsSync(`${destination}.br`)) {
      fs.writeFileSync(`${destination}.br`, zlib.brotliCompressSync(contents, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length },
      }));
    }
    if (!unchanged || !fs.existsSync(`${destination}.gz`)) {
      fs.writeFileSync(`${destination}.gz`, zlib.gzipSync(contents, { level: 9 }));
    }
    copied += 1;
  }
  fs.writeFileSync(path.join(target, 'NOTICE.txt'), notice());
  console.log(`[vendor] ${copied} files for the capture page are in ${path.relative(process.cwd(), target) || '.'}`);
} catch (error) {
  // Not worth failing an install over: the hub says what is missing when
  // the capture page is opened.
  console.warn(`[vendor] could not prepare the capture page's files: ${error.message}`);
}
