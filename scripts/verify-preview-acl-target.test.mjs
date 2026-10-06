import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPreviewAclTarget, runPreviewAclRegression } from './verify-preview-acl-regression.mjs';

const valid = () => ({
  ownerUrl: 'postgresql://neondb_owner:synthetic-secret@ep-hidden-bird-b673zocn.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=require&channel_binding=require',
  verifierPath: 'D:/Projetos/vaptmesaflow/infra/neon/verify-worker-preview-role.sql',
});
test('accepts only the direct preview owner target and exact verifier basename', () => {
  assert.doesNotThrow(() => assertPreviewAclTarget(valid()));
  for (const mutate of [
    i => { i.ownerUrl = i.ownerUrl.replace('ep-hidden-bird-b673zocn', 'ep-holy-wildflower-b6vtv1dd'); },
    i => { i.ownerUrl = i.ownerUrl.replace('/vapt?', '/another?'); },
    i => { i.ownerUrl = i.ownerUrl.replace('neondb_owner', 'vapt_api_preview'); },
    i => { i.ownerUrl = i.ownerUrl.replace('postgresql:', 'https:'); },
    i => { i.ownerUrl += '&host=production.example'; },
    i => { i.verifierPath = 'other-verify-worker-preview-role.sql'; },
    i => { i.verifierPath = 'verify-worker-production-role.sql'; },
  ]) {
    const input = valid(); mutate(input);
    assert.throws(() => assertPreviewAclTarget(input), /^Error: Unexpected preview regression target$/);
  }
});
test('rejects production before creating any pool or opening a connection', async () => {
  let opened = false;
  const input = valid();
  input.ownerUrl = input.ownerUrl.replace('ep-hidden-bird-b673zocn', 'ep-holy-wildflower-b6vtv1dd');
  await assert.rejects(runPreviewAclRegression(input, { createPool() { opened = true; throw new Error('connected'); } }), /Unexpected preview regression target/);
  assert.equal(opened, false);
});
