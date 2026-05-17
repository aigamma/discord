import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';
// VOYAGE_API_KEY must be set BEFORE config.js loads so embed() will
// reach the fetch call and exercise the retry logic instead of bailing
// at the "not configured" guard.
process.env.VOYAGE_API_KEY ||= 'pa-stub';

const { cosineSimilarity, vecToBlob, blobToVec, embed } = await import('../src/embeddings.js');

function vectorResponse(dims, count) {
  const data = [];
  for (let i = 0; i < count; i++) {
    data.push({ embedding: new Array(dims).fill(0.1) });
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('cosine: identical vectors return 1', () => {
  const v = new Float32Array([1, 2, 3, 4]);
  assert.equal(cosineSimilarity(v, v), 1);
});

test('cosine: orthogonal vectors return 0', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  assert.equal(cosineSimilarity(a, b), 0);
});

test('cosine: opposite vectors return -1', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([-1, -2, -3]);
  assert.equal(cosineSimilarity(a, b), -1);
});

test('cosine: scale-invariant', () => {
  const a = new Float32Array([1, 1, 1]);
  const b = new Float32Array([100, 100, 100]);
  // Should be 1.0; allow small float error
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6);
});

test('cosine: mismatched dimensions return -1 sentinel', () => {
  const a = new Float32Array([1, 2]);
  const b = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(a, b), -1);
});

test('cosine: NaN in one vector poisons the result (caller filters)', () => {
  const a = new Float32Array([1, NaN, 3]);
  const b = new Float32Array([1, 2, 3]);
  // NaN propagation through dot product → NaN result. The caller MUST
  // filter NaN explicitly with Number.isFinite — a `sim < minSim` skip
  // alone does NOT catch NaN because `NaN < x` is always false, so
  // the NaN entry would slide past the floor check.
  assert.ok(Number.isNaN(cosineSimilarity(a, b)));
});

test('cosine: zero-vector against any returns 0 (denom guard)', () => {
  const zero = new Float32Array([0, 0, 0]);
  const v = new Float32Array([1, 2, 3]);
  assert.equal(cosineSimilarity(zero, v), 0);
  assert.equal(cosineSimilarity(v, zero), 0);
});

test('blob roundtrip: vec → blob → vec preserves values', () => {
  const original = new Float32Array([0.1234, -0.5678, 1.0, -1.0, 0]);
  const blob = vecToBlob(original);
  const recovered = blobToVec(blob);
  assert.equal(recovered.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(recovered[i], original[i]);
  }
});

test('blob roundtrip: zero vector still works', () => {
  const original = new Float32Array(1024);
  const recovered = blobToVec(vecToBlob(original));
  assert.equal(recovered.length, 1024);
  assert.equal(recovered[0], 0);
});

test('embed: empty input array returns empty without calling fetch', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('should not be called'); };
  try {
    const r = await embed([]);
    assert.deepEqual(r, []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('embed: 503 then 200 retries once and succeeds', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('busy', { status: 503 });
    return vectorResponse(1024, 1);
  };
  try {
    const r = await embed(['hello']);
    assert.equal(calls, 2);
    assert.equal(r.length, 1);
    assert.equal(r[0].length, 1024);
  } finally {
    globalThis.fetch = original;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('embed: 429 then 200 retries once and succeeds', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    return vectorResponse(1024, 1);
  };
  try {
    await embed(['x']);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('embed: 401 (auth) is NOT retried — fails fast', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response('unauthorized', { status: 401 }); };
  try {
    await assert.rejects(() => embed(['x']), /Voyage 401/);
    assert.equal(calls, 1, '4xx auth must not retry');
  } finally {
    globalThis.fetch = original;
  }
});

test('embed: 400 (bad request) is NOT retried', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response('bad input', { status: 400 }); };
  try {
    await assert.rejects(() => embed(['x']), /Voyage 400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('embed: ECONNRESET then 200 retries once', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('socket hang up');
      e.code = 'ECONNRESET';
      throw e;
    }
    return vectorResponse(1024, 1);
  };
  try {
    const r = await embed(['x']);
    assert.equal(calls, 2);
    assert.equal(r.length, 1);
  } finally {
    globalThis.fetch = original;
    globalThis.setTimeout = realSetTimeout;
  }
});

test('embed: two consecutive 503s — second is NOT retried, error surfaces', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }); };
  try {
    await assert.rejects(() => embed(['x']), /Voyage 503/);
    assert.equal(calls, 2, 'cap at one retry');
  } finally {
    globalThis.fetch = original;
    globalThis.setTimeout = realSetTimeout;
  }
});
