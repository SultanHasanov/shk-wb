# Настройка авторизации

## Supabase

1. Выполните миграции `supabase/migrations/20260830_telegram_auth.sql` и `supabase/migrations/20260831_cabinet_integration.sql` по порядку.
2. В **Authentication → Providers → Email** включите Email/Password и отключите обязательное подтверждение email.
3. В **Authentication → URL Configuration** задайте:
   - Site URL: `https://shk-wb.vercel.app`
   - Redirect URLs: `https://shk-wb.vercel.app/**`, `https://*-*.vercel.app/**` и `http://127.0.0.1:5173/**`
4. Подключите production SMTP для `auth.sul-dev.ru` и настройте русский шаблон Reset Password.

## Переменные окружения

Локально в `.env.local` и в Vercel добавьте:

```env
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
TELEGRAM_BOT_TOKEN=123456:bot-token
VITE_TELEGRAM_BOT_USERNAME=bot_username
REFERRAL_COOKIE_SECRET=отдельная-случайная-строка-не-короче-32-байт
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=ШК ВБ <no-reply@auth.sul-dev.ru>
CRON_SECRET=отдельная-случайная-строка-не-короче-32-байт
```

`SUPABASE_SECRET_KEY` и `TELEGRAM_BOT_TOKEN` нельзя добавлять с префиксом `VITE_`.

## Vercel Preview

1. Добавьте серверные и `VITE_` переменные также в окружение **Preview**, не только Production.
2. Не задавайте `PUBLIC_APP_URL` для Preview: сервер использует системный `VERCEL_URL`, поэтому возврат ЮKassa и реферальные ссылки останутся на текущем preview-деплое. В Production можно задать канонический домен через `PUBLIC_APP_URL`.
3. Preview-домен должен присутствовать в разрешённых Redirect URLs Supabase. Wildcard выше покрывает автоматически создаваемые адреса Vercel.
4. Telegram Login принимает только один домен, заданный через BotFather `/setdomain`. Для проверки Telegram временно укажите конкретный preview-домен, затем верните production-домен.
5. Vercel Cron запускается только на production deployment. В Preview задачу можно проверить вручную запросом `GET /api/cron/notifications` с заголовком `Authorization: Bearer <CRON_SECRET>`.
6. Для тестовой оплаты используйте тестовый магазин ЮKassa и `YOOKASSA_TEST_MODE=true`; `return_url` сформируется из текущего preview origin.

## Telegram

1. Создайте бота через `@BotFather` командой `/newbot`.
2. Выполните `/setdomain`, выберите бота и укажите `shk-wb.vercel.app` (без `https://` и завершающего `/`).
3. Добавьте username и токен бота в переменные окружения.
4. Для локальной проверки используйте HTTPS preview/tunnel и временно назначьте его домен через `/setdomain`.

### Telegram-бот генерации ШК

После миграции `supabase/migrations/20260913_telegram_sticker_generator.sql` добавьте в Production и Preview:

```env
TELEGRAM_WEBHOOK_SECRET=случайная-строка-для-проверки-webhook
```

Зарегистрируйте webhook (подставьте реальные значения, не сохраняйте токен в репозитории):

```text
POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
Content-Type: application/json

{
  "url": "https://shk-wb.vercel.app/api/telegram/webhook",
  "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
  "allowed_updates": ["message", "callback_query"],
  "drop_pending_updates": true
}
```

Проверка обработчика: `GET https://shk-wb.vercel.app/api/telegram/webhook` должна вернуть `{"ok":true,"service":"telegram-wb-bot"}`. Затем откройте личный чат с ботом и отправьте `/start`. Бот находит кабинет по привязанному Telegram, использует оплаченные пакеты и присылает предпросмотр и PDF. При отсутствии пакета кнопка Mini App открывает веб-генератор.

## Почтовый домен и Resend

Сайт работает на `https://shk-wb.vercel.app`, а служебные письма отправляются с отдельного поддомена:

```text
no-reply@auth.sul-dev.ru
```

1. В Resend добавьте домен `auth.sul-dev.ru`.
2. Все DNS-записи, показанные Resend, добавьте в DNS-зону `sul-dev.ru` у регистратора домена.
3. Дождитесь статуса **Verified** и создайте API key для Supabase.
4. В **Supabase → Authentication → Emails → SMTP Settings** укажите:

```text
Sender email: no-reply@auth.sul-dev.ru
Sender name: ШК ВБ
Host: smtp.resend.com
Port: 465
Username: resend
Password: re_... (API key из Resend)
```

Адрес сайта и домен отправителя могут отличаться. Позже почтовый домен можно заменить без переноса пользователей Supabase.
