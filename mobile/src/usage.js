const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Missing upstream fields must not be rendered as a measured cache miss. */
export function summaryCache(totals) {
  const readKnown = totals?.cacheReports > 0 || totals?.cacheRead > 0;
  const writeKnown = totals?.cacheWriteReports > 0 || totals?.cacheWrite > 0;
  return {
    read: readKnown && nonnegative(totals.cacheRead) ? totals.cacheRead : null,
    write: writeKnown && nonnegative(totals.cacheWrite) ? totals.cacheWrite : null,
    rate: readKnown && nonnegative(totals.cacheRate) ? Math.min(1, totals.cacheRate) : null,
  };
}

export function requestCache(record, field, live = false) {
  const value = record?.[field];
  if (!nonnegative(value)) return null;
  return live || record?.[`${field}Known`] === true || value > 0 ? value : null;
}

export function requestOutput(record) {
  if (nonnegative(record?.outputTokens)) return { tokens: record.outputTokens, estimated: false };
  if (nonnegative(record?.estimatedOutputTokens)) return { tokens: record.estimatedOutputTokens, estimated: true };
  return { tokens: null, estimated: false };
}
