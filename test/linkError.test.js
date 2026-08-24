import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeLinkError } from '../src/routes/auth.js';

const errorWith = (code) => Object.assign(new Error('raw Kaspi wording'), { code });

describe('Kaspi linking error messages', () => {
  // Обе ситуации — наша, а не организатора: одна device-identity на все кассы.
  // Сообщение не должно гонять его перевводить PIN или менять настройки Kaspi.
  it('sends a taken-over token to support instead of blaming the PIN', () => {
    const { status, payload } = describeLinkError(
      errorWith('KASPI_DEVICE_SESSION_CONFLICT'),
      'p-1',
    );
    assert.equal(status, 400);
    assert.match(payload.error, /поддержку Wevent/);
    assert.doesNotMatch(payload.error, /PIN|код быстрого доступа/);
  });

  it('sends a rights-less token to support instead of blaming the number', () => {
    const { payload } = describeLinkError(
      errorWith('KASPI_CASHIER_REGISTRATION_REQUIRED'),
      'p-2',
    );
    assert.match(payload.error, /поддержку Wevent/);
    assert.doesNotMatch(payload.error, /Кассиры|добавьте номер/);
  });

  it('blames the PIN only when Kaspi rejected the submitted code', () => {
    const { payload } = describeLinkError(errorWith('KASPI_PIN_REJECTED'), 'p-3');
    assert.match(payload.error, /код быстрого доступа/);
  });

  it('keeps the session for a retryable PIN, drops it once the token was spent', () => {
    assert.equal(describeLinkError(errorWith('KASPI_PIN_REJECTED'), 'p-4').payload.restart, false);
    assert.equal(
      describeLinkError(errorWith('KASPI_DEVICE_SESSION_CONFLICT'), 'p-5').payload.restart,
      true,
    );
  });

  it('passes unclassified failures through as a server error', () => {
    const { status, payload } = describeLinkError(new Error('socket hang up'), 'p-6');
    assert.equal(status, 500);
    assert.equal(payload.error, 'socket hang up');
    assert.equal(payload.restart, false);
  });
});
