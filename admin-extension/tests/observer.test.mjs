import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeRead, diagnosticEvent } from '../observer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('observer package has temporary tab permission and no automatic collection surface', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  for (const key of ['host_permissions', 'background', 'content_scripts', 'externally_connectable']) {
    assert.equal(Object.hasOwn(manifest, key), false, key);
  }
  const popup = readFileSync(join(root, 'popup.mjs'), 'utf8');
  assert.match(popup, /checkButton\.addEventListener\('click'/);
  assert.match(popup, /world: 'MAIN', func: readJimengPage/);
  assert.doesNotMatch(popup, /https?:\/\/(?!jimeng\.jianying\.com)/);
});

test('persisted diagnostics never include account, wallet, member or transaction data', () => {
  const raw = {status: 'ok', partial: true, diagnosticCodes: ['team_discovery_partial', 'PRIVATE_SECRET'], observations: [
    {status: 'ok', userId: '123456', accountType: 'personal', displayName: '员工昵称', balance: 990,
      records: [{historyId:'sensitive-1',title:'私有内容'},{historyId:'sensitive-2'}]},
    {status: 'error', diagnosticCodes: ['credit_api_unavailable'], message: 'private failure text'},
  ]};
  const summary = summarizeRead(raw);
  assert.equal(summary.spaceCount, 1);
  assert.equal(summary.recordCount, 2);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.status, 'partial');
  const saved = diagnosticEvent(summary, 123, new Date('2026-09-23T00:00:00.000Z'));
  assert.deepEqual(saved.codes, ['team_discovery_partial', 'credit_api_unavailable']);
  assert.deepEqual(Object.keys(saved).sort(), ['at','codes','elapsedMs','errorCount','recordCount','spaceCount','status','teamCount'].sort());
  assert.doesNotMatch(JSON.stringify(saved), /123456|员工昵称|990|sensitive|私有内容|private|PRIVATE_SECRET/);
});

test('reader is an exact, independently packageable copy of the employee read adapter', () => {
  const admin = readFileSync(join(root, 'page-reader.mjs'));
  const employee = readFileSync(join(root, '../extension/page-reader.mjs'));
  assert.deepEqual(admin, employee);
});
