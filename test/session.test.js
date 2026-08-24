import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptySession, sessionFields, applyOrgContext } from '../src/session.js';

describe('createEmptySession', () => {
  it('should return an object with all fields set to null', () => {
    const session = createEmptySession();
    assert.equal(typeof session, 'object');
    for (const key of sessionFields()) {
      assert.equal(session[key], null, `${key} should be null`);
    }
  });

  it('should return a new object each time', () => {
    const a = createEmptySession();
    const b = createEmptySession();
    assert.notEqual(a, b);
  });
});

describe('sessionFields', () => {
  it('should return an array of strings', () => {
    const fields = sessionFields();
    assert.ok(Array.isArray(fields));
    assert.ok(fields.length > 0);
    for (const f of fields) {
      assert.equal(typeof f, 'string');
    }
  });

  it('should include critical fields', () => {
    const fields = sessionFields();
    assert.ok(fields.includes('processId'));
    assert.ok(fields.includes('tokenSN'));
    assert.ok(fields.includes('profileId'));
    assert.ok(fields.includes('phoneNumber'));
  });
});

describe('applyOrgContext', () => {
  it('should populate session from Current data', () => {
    const session = createEmptySession();
    const data = {
      UserId: 'U123',
      PhoneNumber: '+77001234567',
      Current: {
        ProfileId: 42,
        OrganizationName: 'Test Org',
        OrganizationId: 'ORG1',
        EmpId: 'E1',
        IsCashier: true,
      },
    };
    applyOrgContext(session, data);
    assert.equal(session.userId, 'U123');
    assert.equal(session.phoneNumber, '+77001234567');
    assert.equal(session.profileId, 42);
    assert.equal(session.orgName, 'Test Org');
    assert.equal(session.isCashier, true);
  });

  it('should not overwrite existing values with falsy data', () => {
    const session = createEmptySession();
    session.profileId = 99;
    applyOrgContext(session, { Current: {} });
    assert.equal(session.profileId, 99);
  });
});
