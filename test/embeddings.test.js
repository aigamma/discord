import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DISCORD_BOT_TOKEN ||= 'stub';
process.env.DISCORD_CLIENT_ID ||= 'stub';
process.env.ANTHROPIC_API_KEY ||= 'stub';

const { cosineSimilarity, vecToBlob, blobToVec } = await import('../src/embeddings.js');

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
