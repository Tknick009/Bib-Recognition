// Decides which pieces of text found in the picture are bib numbers.

/** What counts as a bib number. */
export function defaultRules() {
  return {
    minDigits: 1,
    maxDigits: 5,
    // An optional range of valid numbers, e.g. 1 to 500.
    minNumber: null,
    maxNumber: null,
    // Text the reader is less sure about than this is ignored.
    minConfidence: 0.5,
    // Text lower than this share of the picture height is ignored.
    minTextHeight: 0.015,
    // Read a single look-alike letter (O, I, S, B, Z ...) as its digit.
    fixLookalikes: true,
    // Numbers that are never bibs at this event (the year on a banner, say).
    ignored: [],
  };
}

// Letters that text recognition commonly reports in place of a digit.
const lookalikes = new Map(Object.entries({
  O: '0', o: '0', D: '0', Q: '0',
  I: '1', l: '1',
  Z: '2', z: '2',
  S: '5', s: '5',
  B: '8',
}));

// Stray marks around a number: a "#" in front, or the edge of the bib read
// as a bar. Dropped rather than taken as part of the number.
const edgeMarks = new Set('#.,:;-_*\'"()[]{}<>/\\|!');

function trimEdges(text) {
  let token = text.trim();
  let start = 0;
  let end = token.length;
  while (start < end && edgeMarks.has(token[start])) start += 1;
  while (end > start && edgeMarks.has(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

function withoutLeadingZeros(number) {
  const stripped = number.replace(/^0+/, '');
  return stripped === '' ? null : stripped;
}

/** The bib number a piece of text stands for, or null if it is not one. */
export function bibFrom(text, rules) {
  const token = trimEdges(String(text));
  if (token === '' || token.length > 12) return null;

  let number = '';
  let realDigits = 0;
  let substitutions = 0;
  for (const character of token) {
    if (character >= '0' && character <= '9') {
      number += character;
      realDigits += 1;
    } else if (rules.fixLookalikes && lookalikes.has(character)) {
      number += lookalikes.get(character);
      substitutions += 1;
    } else {
      return null;
    }
  }
  // One misread character in an otherwise numeric string is believable;
  // more than that is more likely to be a word.
  if (substitutions > 0 && (substitutions > 1 || realDigits < 2)) return null;

  const bib = withoutLeadingZeros(number);
  if (bib === null || bib.length < rules.minDigits || bib.length > rules.maxDigits) return null;
  const value = Number(bib);
  if (rules.minNumber != null && value < rules.minNumber) return null;
  if (rules.maxNumber != null && value > rules.maxNumber) return null;
  return bib;
}

/**
 * The standard spelling of a bib number that was typed or imported: digits
 * only, without a "#" in front or leading zeros. Null if it is not a number.
 */
export function canonicalBib(text) {
  const token = trimEdges(String(text));
  if (token === '' || token.length > 12 || !/^[0-9]+$/.test(token)) return null;
  return withoutLeadingZeros(token);
}

/**
 * Keeps the texts that look like bib numbers.
 *
 * @param {{text: string, confidence: number, box: object}[]} candidates
 * @param {object} rules
 * @param {Set<string>|null} roster when given, only these numbers are accepted
 * @returns {{bib: string, confidence: number, box: object}[]}
 */
export function bibDetections(candidates, rules, roster = null) {
  const ignored = new Set(rules.ignored.map(canonicalBib).filter((bib) => bib !== null));
  const result = [];
  for (const candidate of candidates) {
    if (candidate.confidence < rules.minConfidence || candidate.box.height < rules.minTextHeight) continue;
    const bib = bibFrom(candidate.text, rules);
    if (bib === null || ignored.has(bib)) continue;
    if (roster && !roster.has(bib)) continue;
    result.push({ bib, confidence: candidate.confidence, box: candidate.box });
  }
  return result;
}

/**
 * Reads a start list: one runner per line, bib number first, then the name.
 * Commas, semicolons, tabs or spaces may separate the columns; lines that do
 * not start with a number (such as a header) are skipped.
 */
export function parseRoster(text) {
  const seen = new Set();
  const entries = [];
  // Spreadsheets often start a file with an invisible byte-order mark,
  // which would otherwise stick to the first bib number.
  const body = String(text).replace(/^﻿/, '');
  const clean = (field) => field.trim().replace(/^["']+|["']+$/g, '').trim();
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    let columns;
    const separator = ['\t', ',', ';'].find((mark) => line.includes(mark));
    if (separator) {
      columns = line.split(separator);
    } else {
      const space = line.search(/\s/);
      columns = space < 0 ? [line] : [line.slice(0, space), line.slice(space + 1)];
    }
    columns = columns.map(clean);
    const bib = canonicalBib(columns[0] ?? '');
    if (bib === null || seen.has(bib)) continue;
    seen.add(bib);
    entries.push({ bib, name: columns.slice(1).filter((part) => part !== '').join(' ') });
  }
  return entries;
}
