import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KASPI_REAUTH_REQUIRED,
  isKaspiReauthRequired,
  reauthRequiredResponse,
} from '../src/services/sessionRefresh.js';

describe('Kaspi re-auth classification', () => {
  it('recognizes the other-device session error', () => {
    assert.equal(
      isKaspiReauthRequired({
        StatusCode: -101001,
        Message: 'Был выполнен вход с другого устройства. Для входа в текущее приложение введите логин/пароль',
      }),
      true,
    );
  });

  it('recognizes the forced app/auth refresh error', () => {
    assert.equal(
      isKaspiReauthRequired({ StatusCode: -209, Message: 'Обновите приложение, чтобы войти' }),
      true,
    );
  });

  it('does not misclassify ordinary Kaspi failures', () => {
    assert.equal(isKaspiReauthRequired({ StatusCode: -1, Message: 'Недостаточно средств' }), false);
  });

  it('returns a stable machine-readable response without the upstream wording', () => {
    const response = reauthRequiredResponse({ StatusCode: -101001 });
    assert.equal(response.ErrorCode, KASPI_REAUTH_REQUIRED);
    assert.equal(response.RequiresReauth, true);
    assert.equal(response.Message.includes('другого устройства'), false);
  });
});
