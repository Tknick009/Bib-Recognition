// Text formatting for times and CSV. Mirrors what the iPad app writes in its
// own exports, so a file from the hub looks the same as one from an iPad.
//
// Used by the hub (in Node) and by the capture page (in the browser), so it
// must not use anything that only one of them has.

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True if the runtime knows this IANA time zone name. */
export function isTimeZone(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
  try {
    formatterFor(name);
    return true;
  } catch {
    return false;
  }
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** Whole milliseconds since 1970 for a time given in seconds. */
export function milliseconds(seconds) {
  return Math.round(seconds * 1000);
}

function localParts(seconds, timeZone) {
  const ms = milliseconds(seconds);
  const wholeSeconds = Math.floor(ms / 1000);
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(wholeSeconds * 1000))) {
    parts[part.type] = part.value;
  }
  parts.millisecond = ms - wholeSeconds * 1000;
  return parts;
}

/**
 * The part after the seconds, cut (never rounded up) to 0 to 3 digits:
 * `.123`, `.12`, `.1` or nothing.
 */
function fraction(millisecond, decimals) {
  const digits = Math.min(3, Math.max(0, Math.trunc(decimals)));
  if (digits === 0) return '';
  return `.${pad(Math.floor(millisecond / 10 ** (3 - digits)), digits)}`;
}

/** `18:04:05.123` in the given time zone; `decimals` (0 to 3) shortens the fraction. */
export function timeOfDay(seconds, timeZone, decimals = 3) {
  const parts = localParts(seconds, timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}${fraction(parts.millisecond, decimals)}`;
}

/** `2026-11-25` in the given time zone. */
export function localDate(seconds, timeZone) {
  const parts = localParts(seconds, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `2026-11-25T18:04:05.123Z` */
export function isoUTC(seconds) {
  return new Date(milliseconds(seconds)).toISOString();
}

/**
 * `1:23:45.678` between two times given in seconds; negative with a minus.
 * `decimals` (0 to 3) shortens the fraction.
 */
export function elapsed(startSeconds, endSeconds, decimals = 3) {
  const total = milliseconds(endSeconds) - milliseconds(startSeconds);
  const magnitude = Math.abs(total);
  const hours = Math.floor(magnitude / 3_600_000);
  const minutes = Math.floor(magnitude / 60_000) % 60;
  const seconds = Math.floor(magnitude / 1000) % 60;
  return `${total < 0 ? '-' : ''}${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}${fraction(magnitude % 1000, decimals)}`;
}

/** Quotes a CSV field when it contains a comma, a quote or a line break. */
export function escapeCSV(field) {
  const text = String(field ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Stops free text being run as a formula when the file is opened in a spreadsheet. */
export function safeText(text) {
  const value = String(text ?? '');
  return /^[=+\-@\t]/.test(value) ? `'${value}` : value;
}

export const simpleHeader = ['bib', 'time_of_day', 'elapsed', 'station'];
export const detailedHeader = [
  'position', 'bib', 'time_of_day', 'elapsed', 'utc', 'timing', 'source',
  'confidence', 'clock', 'clock_error_ms', 'station', 'note',
];

/**
 * Results as CSV text, in finishing order.
 *
 * @param {object[]} rows crossings, already sorted
 * @param {object} options `format` ('simple' or 'detailed'), `timeZone`, `startTime` (seconds or null)
 */
export function toCSV(rows, { format = 'simple', timeZone = 'UTC', startTime = null } = {}) {
  const lines = [format === 'detailed' ? detailedHeader : simpleHeader];
  rows.forEach((row, index) => {
    const time = timeOfDay(row.time, timeZone);
    const sinceStart = startTime == null ? '' : elapsed(startTime, row.time);
    if (format === 'detailed') {
      lines.push([
        index + 1,
        row.bib,
        time,
        sinceStart,
        isoUTC(row.time),
        row.timing,
        row.source,
        row.confidence == null ? '' : row.confidence.toFixed(2),
        row.clock,
        row.clockError == null ? '' : Math.round(row.clockError * 1000),
        safeText(row.station),
        safeText(row.note),
      ]);
    } else {
      lines.push([row.bib, time, sinceStart, safeText(row.station)]);
    }
  });
  return lines.map((line) => line.map(escapeCSV).join(',')).join('\r\n') + '\r\n';
}

// ---- RunScore ----
//
// RunScore's "Open Interface" takes one result per line of text:
//
//   RSBI,<bib>,<time>,<location>
//
// for example `RSBI,0542,13:20:02.12,FINISH`. RSBI marks the number as a bib
// number (RSCI would mark it as a chip code). The lines are written to a TCP
// port RunScore listens on, or kept in a file.

/** Text that can be one field of such a line: no commas, nothing that would end the line. */
export function runScoreField(text, maxLength = 40) {
  return String(text ?? '')
    .replace(/[,\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * One result as RunScore reads it.
 *
 * @param {object} result
 * @param {string} result.prefix `RSBI` unless RunScore has been set up for something else
 * @param {string} result.bib
 * @param {string} result.time already formatted, e.g. `13:20:02.12`
 * @param {string} result.location the timing point, e.g. `FINISH`
 */
export function runScoreLine({ prefix = 'RSBI', bib, time, location }) {
  return [prefix, runScoreField(bib, 16), time, runScoreField(location)].join(',');
}

/** A short form of a name that can go into a file name. */
export function fileSlug(name, fallback = 'ipad') {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return slug === '' ? fallback : slug;
}
