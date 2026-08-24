# Деплой шлюза на Railway

Пошаговая инструкция, чтобы поднять `kaspi-pos-automation` на Railway и связать его
с приложением Wevent (Vercel). После этого разблокируется онлайн-оплата Kaspi.

> Почему Railway, а не Vercel: шлюз держит **постоянный фоновый процесс** (опрос
> статуса платежей каждые 3 сек) и **файловое состояние устройства** (`device.json`,
> `keypair.json`) — serverless (Vercel) это не умеет. Плюс отдельный хост даёт
> **стабильный IP**, что важно для этой интеграции (эмуляция устройства Kaspi).

---

## 0. Что понадобится

- Аккаунт Railway (railway.app), вход через GitHub.
- Репозиторий `raasikkk/kaspi-pos-automation` (уже есть).
- Доступ к переменным окружения проекта Wevent на Vercel.

---

## 1. Создать проект + сервис из репозитория

1. Railway → **New Project → Deploy from GitHub repo** → выбрать
   `raasikkk/kaspi-pos-automation`.
2. Railway увидит `Dockerfile` и `railway.json` и соберёт образ сам.
3. Первый билд **упадёт/не поднимется** — это ок, ещё нет БД и переменных. Настроим ниже.

---

## 2. База данных — ОТДЕЛЬНЫЙ Postgres от Railway (НЕ Supabase)

> ⚠️ Важно: **не** подключать шлюз к Supabase проекта Wevent. Шлюз создаёт свои
> таблицы `events`, `orders`, `keys`, `daily_stats` — таблица `events`
> **конфликтует** с `public.events` Wevent. К тому же в таблице `keys` лежат
> зашифрованные секреты Kaspi — их нельзя держать в Supabase, где `public`-схема
> отдаётся наружу через PostgREST.

1. В проекте Railway → **New → Database → Add PostgreSQL**.
2. Railway сам создаст переменную `DATABASE_URL` и прокинет её в сервис
   (через reference). Если не прокинулась — в сервисе шлюза добавь переменную
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.
3. Схему шлюз создаёт сам при старте (`initDb()`), миграций руками не надо.

---

## 3. Постоянный том для состояния устройства (обязательно)

Без тома `device.json` / `keypair.json` пересоздаются при каждом деплое → Kaspi
видит «новое устройство» и рвёт сессию кассира.

1. Сервис шлюза → вкладка **Volumes → New Volume**.
2. Mount path: **`/data`**.
3. Добавить переменную окружения `STATE_DIR = /data` (см. следующий шаг).

---

## 4. Переменные окружения шлюза (Railway → Variables)

| Переменная | Значение | Как получить |
|---|---|---|
| `STATE_DIR` | `/data` | путь тома из шага 3 |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | из шага 2 |
| `TOKEN_SECRET_KEY` | 64 hex-символа | `openssl rand -hex 32` |
| `ADMIN_SECRET_KEY` | длинная случайная строка | `openssl rand -hex 24` — им защищены admin-эндпоинты |
| `WEBHOOKS_JSON` | JSON-массив (ниже) | адрес вебхука Wevent + общий секрет |
| `PORT` | `3000` | (Railway обычно сам задаёт `PORT`; сервер его читает) |

`WEBHOOKS_JSON` (одной строкой) — сюда шлюз шлёт результат оплаты:

```json
[{"url":"https://<домен-wevent-на-vercel>/api/kaspi/webhook","events":["payment.success","payment.failed","payment.expired"],"secret":"<ОБЩИЙ_СЕКРЕТ_ВЕБХУКА>"}]
```

- `<домен-wevent-на-vercel>` — прод-домен Wevent (напр. `https://wevent.kz`).
- `<ОБЩИЙ_СЕКРЕТ_ВЕБХУКА>` — придумай один секрет (`openssl rand -hex 24`); он должен
  **совпасть** с `KASPI_WEBHOOK_SECRET` на стороне Wevent (шаг 6).

> ⚠️ `TOKEN_SECRET_KEY` и `ADMIN_SECRET_KEY` после первого логина кассира менять
> нельзя — `TOKEN_SECRET_KEY` расшифровывает сохранённую сессию Kaspi.

(App-константы `APP_VERSION`, `APP_MODEL` и т.д. можно не трогать — в коде есть
рабочие дефолты. Меняй только если Kaspi начнёт отклонять версию клиента.)

После сохранения переменных сервис пере-задеплоится и должен подняться
(`/health` вернёт `{"status":"ok"}`). Railway даст публичный домен — скопируй его,
это `KASPI_GATEWAY_URL` для Wevent.

---

## 5. Первый вход кассира (SMS) и выпуск API-ключа

Счета не выставятся, пока у мерчанта нет живой сессии Kaspi.

1. Открой веб-интерфейс шлюза: `https://<railway-домен>/` (статика из `public/`).
2. Войди по номеру, привязанному к Kaspi Pay кассира/организатора → введи SMS-код.
   Появится зашифрованная сессия (в таблице `keys`).
3. Через admin-эндпоинт (заголовок `X-Admin-Secret: <ADMIN_SECRET_KEY>`) создай
   API-ключ для организатора с правом выставлять счета (`allow_invoice=true`).
   Точный роут — в `src/routes/admin.js` / `docs/openapi.json` (`/api-docs`).
4. Скопируй выданный `api_key`.

---

## 6. Настройка на стороне Wevent (Vercel → Environment Variables)

| Переменная | Значение |
|---|---|
| `KASPI_GATEWAY_URL` | `https://<railway-домен>` (без слэша в конце) |
| `KASPI_WEBHOOK_SECRET` | тот же `<ОБЩИЙ_СЕКРЕТ_ВЕБХУКА>`, что в `WEBHOOKS_JSON` |

Затем API-ключ организатора из шага 5 записать ему в
`organizer_profiles.kaspi_api_key` (через админку Wevent или SQL). После этого у
событий этого организатора включится онлайн-оплата Kaspi (`kaspiAutoPay`).

---

## 7. Проверка

1. Создать тестовое **платное** событие с оплатой **Kaspi** (после выката платного
   батча Wevent).
2. Забронировать билет → на телефон плательщика прилетит счёт в приложении Kaspi.
3. Оплатить → шлюз в течение ~3 сек увидит оплату → отправит `payment.success` на
   `/api/kaspi/webhook` Wevent → бронь станет `registered`, QR активируется.
4. Логи оплаты — в Railway (сервис шлюза) и в логах Vercel (`[kaspi-webhook]`).

---

## Как это работает (схема)

```
Пользователь → Wevent (Vercel)
                  │  POST /api/orders/invoice  (X-API-Key организатора)
                  ▼
              Шлюз (Railway, всегда живой, /data-том, свой Postgres)
                  │  подписанные запросы «устройства»
                  ▼
               Kaspi Pay API
                  ▲
     поллинг 3с ──┘  увидел оплату
                  │  X-Webhook-Signature: sha256=HMAC(body, secret)
                  ▼
        Wevent /api/kaspi/webhook → бронь registered, QR активен
```
