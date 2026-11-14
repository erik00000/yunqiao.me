import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryCache, requestCache, requestOutput } from '../src/usage.js';

test('missing cache reports stay unknown while an explicitly reported zero stays zero', () => {
  assert.deepEqual(summaryCache({ cacheRead: 0, cacheWrite: 0, cacheRate: 0, cacheReports: 0 }), { read: null, write: null, rate: null });
  assert.deepEqual(summaryCache({ cacheRead: 0, cacheWrite: 0, cacheRate: 0, cacheReports: 3, cacheWriteReports: 2 }), { read: 0, write: 0, rate: 0 });
  assert.equal(requestCache({ cacheRead: 0 }, 'cacheRead'), null);
  assert.equal(requestCache({ cacheRead: 0, cacheReadKnown: true }, 'cacheRead'), 0);
  assert.equal(requestCache({ cacheRead: 0 }, 'cacheRead', true), 0);
  assert.equal(requestCache({}, 'cacheRead', true), null);
});

test('cache rates use the server report denominator and never invent a rate from mixed input', () => {
  assert.deepEqual(summaryCache({ cacheRead: 600, cacheWrite: 120, cacheRate: .75, cacheReports: 2, inputTokens: 1000 }), { read: 600, write: 120, rate: .75 });
  assert.equal(summaryCache({ cacheRead: 500, inputTokens: 1000 }).rate, null);
  assert.equal(summaryCache({ cacheRead: 1, cacheRate: 1.1 }).rate, 1);
  assert.equal(requestCache({ cacheWrite: -1 }, 'cacheWrite', true), null);
});

test('upstream output counts replace live estimates, including real zero output', () => {
  assert.deepEqual(requestOutput({ estimatedOutputTokens: 24 }), { tokens: 24, estimated: true });
  assert.deepEqual(requestOutput({ outputTokens: 0, estimatedOutputTokens: 24 }), { tokens: 0, estimated: false });
  assert.deepEqual(requestOutput({}), { tokens: null, estimated: false });
  assert.deepEqual(requestOutput({ estimatedOutputTokens: NaN }), { tokens: null, estimated: false });
});
