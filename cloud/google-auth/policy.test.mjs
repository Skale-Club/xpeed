import assert from 'node:assert/strict';
import test from 'node:test';
import { beforeSignInPolicy } from './policy.mjs';

test('only Google and phone receive the authenticated database role', () => {
  for (const providerId of ['google.com', 'phone']) {
    assert.deepEqual(beforeSignInPolicy({ data: { customClaims: { role: 'service_role', kept: true } }, additionalUserInfo: { providerId } }), { customClaims: { role: 'authenticated', kept: true } });
  }
  assert.throws(() => beforeSignInPolicy({ data: {}, additionalUserInfo: { providerId: 'password' } }));
});
test('does not modify tenant identities', () => {
  assert.equal(beforeSignInPolicy({ data: { tenantId: 'unused-tenant' }, additionalUserInfo: { providerId: 'google.com' } }), undefined);
});
