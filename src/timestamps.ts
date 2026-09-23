// Fixed-width UTC milliseconds sort chronologically in the existing TEXT
// indexes. Expanded/negative years would break that invariant.
export function utcMilliseconds(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new RangeError("invalid timestamp");
  const iso = date.toISOString();
  if (iso.length !== 24) throw new RangeError("timestamp must normalize to a four-digit UTC year");
  return iso;
}

export function sourceTimestamp(value: unknown): string {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  // JS $ also matches before a final newline. Require the entire value.
  if (!match || match[0] !== value) throw new Error("source timestamp requires a valid zone-explicit ISO calendar instant");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[8]!;
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw new Error("source timestamp has invalid calendar, clock or offset fields");
  }
  // Validate the calendar before Date.parse can roll it forward. Truncate the
  // fractional component, including pre-epoch values, without rounding it.
  const millis = (match[7] ?? "").slice(0, 3).padEnd(3, "0");
  return utcMilliseconds(Date.parse(`${match[0].slice(0, 19)}.${millis}${zone}`));
}
