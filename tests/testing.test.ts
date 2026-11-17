import test from 'node:test';
import assert from 'node:assert/strict';
import { isBrowserTestConvenience, isBrowserTestUnlock, isWechatTestUnlock } from '../src/services/testing.ts';

test('browser unlock-all requires both an explicit flag and an exact local preview hostname', () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    assert.equal(isBrowserTestUnlock(hostname, '?play=levels&unlock=all'), true);
    for (const search of ['', '?unlock=true', '?unlock=ALL', '?play=levels']) assert.equal(isBrowserTestUnlock(hostname, search), false);
  }
  for (const hostname of ['example.com', 'localhost.example.com', '127.0.0.1.example.com', '0.0.0.0', undefined]) assert.equal(isBrowserTestUnlock(hostname, '?unlock=all'), false);
});

test('WeChat development and trial builds unlock testing, release or unknown environments never do', () => {
  for (const envVersion of ['develop', 'trial', 'release', '', undefined, 'development']) {
    assert.equal(isWechatTestUnlock({ getAccountInfoSync: () => ({ miniProgram: { envVersion } }) }), envVersion === 'develop' || envVersion === 'trial');
  }
  assert.equal(isWechatTestUnlock({}), false);
  assert.equal(isWechatTestUnlock({ getAccountInfoSync() { throw new Error('unavailable'); } }), false);
});

test('local test convenience defaults on but supports real-flow testing and never enables remote sites', () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    for (const search of ['', '?play=levels&unlock=all', '?test=on', '?debug=1']) assert.equal(isBrowserTestConvenience(hostname, search), true);
    assert.equal(isBrowserTestConvenience(hostname, '?test=off'), false);
    assert.equal(isBrowserTestConvenience(hostname, '?unlock=all&test=off&debug=1'), false);
  }
  for (const hostname of ['example.com', 'localhost.example.com', '127.0.0.1.example.com', '0.0.0.0', undefined]) {
    for (const search of ['', '?test=on', '?unlock=all&test=on']) assert.equal(isBrowserTestConvenience(hostname, search), false);
  }
});
