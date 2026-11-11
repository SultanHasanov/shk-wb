import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../ui';
import { AdminUserPage } from '../AdminUserPage';
import type { AdminMessageTargets, AdminUserDetail } from '../../../api/admin';
import { DEVICE_ID, USER_ID, makeDetail } from './fixtures';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let detail: AdminUserDetail;
let targets: AdminMessageTargets;
let linkPreview: unknown;
let linkReply: { data: unknown; status: number } | null = null;

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  calls = [];
  detail = makeDetail();
  targets = {
    cabinet: { available: true },
    email: { available: false, address: 'anna.s@example.ru', confirmed: false, configured: true, reason: 'not_confirmed' },
    telegram: { available: false, username: 'anna_pvz', reason: 'blocked', blockedAt: '2026-11-07T10:00:00Z' },
    pc: {
      available: true,
      reason: null,
      devices: [{ id: DEVICE_ID, name: 'Касса-1', online: true, lastSeenAt: '2026-11-10T11:00:00Z', role: 'owner', openMessages: 0 }],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('action=detailSection')) return json({ items: [], ledger: [], balanceKopecks: 0 });
      if (url.includes('action=detail')) return json(detail);
      if (url.includes('action=messageTargets')) return json(targets);
      if (url.includes('action=linkTelegramPreview')) return json(linkPreview);
      if (url.includes('action=linkTelegram') && linkReply) return json(linkReply.data, linkReply.status);
      if (url.includes('action=linkTelegram')) {
        return json({ ok: true, outcome: 'merge', telegramUserId: 716976910, sourceUserId: 'b0b', sourceDeleted: true, moved: { walletKopecks: 0, subscriptions: 0, devices: 0 }, delivered: true });
      }
      if (url.includes('resource=audit')) return json({ items: [], nextCursor: null, total: 0 });
      if (url.includes('action=message')) {
        return json(
          {
            actionId: 20481,
            messageRef: 'msg_20481',
            sentAt: '2026-11-10T11:32:00Z',
            subject: 'Обновите Помощник',
            results: [{ channel: 'cabinet', status: 'sent', notificationId: 'n1' }],
            summary: { ok: 1, total: 1 },
          },
          201,
        );
      }
      if (method !== 'GET') return json({ ok: true }, 200);
      return json({});
    }),
  );
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderCard(search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/panel/users/${USER_ID}${search}`]}>
        <ToastProvider>
          <Routes>
            <Route
              path="/panel/users/:userId"
              element={
                <>
                  <AdminUserPage />
                  <LocationProbe />
                </>
              }
            />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const posted = (action: string) => calls.filter(call => call.method !== 'GET' && call.url.includes(`action=${action}`));

describe('карточка пользователя', () => {
  it('?tab= выбирает вкладку, неизвестное — «Обзор»', async () => {
    renderCard('?tab=danger');
    expect(await screen.findByRole('tab', { name: 'Опасная зона' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /Удалить аккаунт/ })).toBeInTheDocument();
  });

  it('неизвестная вкладка — «Обзор»; переключение пишет ?tab= в адрес', async () => {
    const user = userEvent.setup();
    renderCard('?tab=nope');
    expect(await screen.findByRole('tab', { name: 'Обзор' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Деньги' }));
    expect(screen.getByRole('tab', { name: 'Деньги' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('location')).toHaveTextContent(`/panel/users/${USER_ID}?tab=money`);
  });

  it('запоминает последнего открытого пользователя для списка', async () => {
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    expect(sessionStorage.getItem('admin.lastUserId')).toBe(USER_ID);
  });

  it('«Ограничить» без причины не отправляется', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: 'Ограничить' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Ограничить доступ' });
    const submit = within(dialog).getByRole('button', { name: 'Ограничить' });
    expect(submit).toBeDisabled();

    await user.click(within(dialog).getByLabelText(/Покупки/));
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText(/Укажите причину/)).toBeInTheDocument();
    await user.click(submit);
    expect(posted('restrict')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Причина (для журнала) *'), 'спор по возврату');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(posted('restrict')).toHaveLength(1));
    expect(posted('restrict')[0].body).toMatchObject({
      userId: USER_ID,
      scopes: ['purchases'],
      reason: 'спор по возврату',
      notify: false,
    });
    const body = posted('restrict')[0].body as { idempotencyKey: string; until: string };
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(body.until).toMatch(/T18:00:00\+03:00$/);
  });

  it('у защищённого аккаунта без галочки «всё равно» кнопка выключена', async () => {
    detail = makeDetail({ protected: true, unlimited: { active: true, source: 'env', until: null } });
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: 'Ограничить' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Ограничить доступ' });
    await user.click(within(dialog).getByLabelText('Полностью', { exact: false }));
    await user.type(within(dialog).getByLabelText('Причина (для журнала) *'), 'проверка');
    const submit = within(dialog).getByRole('button', { name: 'Ограничить' });
    expect(submit).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Всё равно ограничить этот аккаунт'));
    expect(submit).toBeEnabled();
  });

  it('недоступные каналы выключены и подписаны причиной', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: 'Написать' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Написать пользователю' });
    const email = await within(dialog).findByLabelText(/^Почта/);
    expect(email).toBeDisabled();
    expect(email).not.toBeChecked();
    expect(within(dialog).getByLabelText(/^Telegram/)).toBeDisabled();
    expect(within(dialog).getByText('почта не подтверждена')).toBeInTheDocument();
    expect(within(dialog).getByText('бот заблокирован')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Кабинет на сайте/)).toBeEnabled();
    expect(within(dialog).getByLabelText(/^Кабинет на сайте/)).toBeChecked();
  });

  it('сообщение: тема и текст обязательны, итог по каналам', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: 'Написать' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Написать пользователю' });
    await within(dialog).findByLabelText(/^Кабинет на сайте/);
    const send = within(dialog).getByRole('button', { name: /Отправить · 1 канал/ });
    expect(send).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Тема'), 'Обновите Помощник');
    await user.type(within(dialog).getByLabelText('Текст'), 'Вышла версия 1.12');
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(posted('message')).toHaveLength(1));
    expect(posted('message')[0].body).toMatchObject({ channels: ['cabinet'], subject: 'Обновите Помощник', body: 'Вышла версия 1.12' });
    const result = await screen.findByRole('dialog', { name: 'Итог отправки' });
    expect(within(result).getByText('Отправлено по 1 из 1 канала', { exact: false })).toBeInTheDocument();
    expect(within(result).getByText(/msg_20481/)).toBeInTheDocument();
  });

  it('повторное открытие «Написать»: канал, ставший недоступным, не остаётся отмеченным', async () => {
    const user = userEvent.setup();
    targets.telegram = { available: true, username: 'anna_pvz', reason: null, blockedAt: null };
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: 'Написать' })[0]);
    let dialog = await screen.findByRole('dialog', { name: 'Написать пользователю' });
    expect(await within(dialog).findByLabelText(/^Telegram/)).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Написать пользователю' })).not.toBeInTheDocument());

    // Пока окно было закрыто, пользователь заблокировал бота; в кеше — прошлый снимок.
    targets = { ...targets, telegram: { available: false, username: 'anna_pvz', reason: 'blocked', blockedAt: '2026-11-10T11:00:00Z' } };
    await user.click(screen.getAllByRole('button', { name: 'Написать' })[0]);
    dialog = await screen.findByRole('dialog', { name: 'Написать пользователю' });
    await within(dialog).findByText('бот заблокирован');
    const telegram = within(dialog).getByLabelText(/^Telegram/);
    expect(telegram).toBeDisabled();
    expect(telegram).not.toBeChecked();
    await user.type(within(dialog).getByLabelText('Тема'), 'Тема');
    await user.type(within(dialog).getByLabelText('Текст'), 'Текст');
    await user.click(within(dialog).getByRole('button', { name: /Отправить · 1 канал/ }));
    await waitFor(() => expect(posted('message')).toHaveLength(1));
    expect(posted('message')[0].body).toMatchObject({ channels: ['cabinet'] });
  });

  it('на телефоне место под нижнюю панель — после вкладок, а не над ними', async () => {
    renderCard('?tab=danger');
    const tablist = await screen.findByRole('tablist', { name: 'Разделы карточки' });
    const page = screen.getByRole('toolbar', { name: 'Действия с пользователем' }).parentElement!;
    // Между панелью действий и вкладками нет пустой прокладки.
    const blanks = Array.from(page.children).filter(
      child => child.childElementCount === 0 && !child.textContent?.trim() && !child.contains(tablist),
    );
    expect(blanks).toEqual([]);
    const css = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'user', 'user.module.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(phone).toMatch(/\.page\s*\{[^}]*padding-bottom:\s*calc\(72px \+ var\(--safe-b\)\)/);
  });

  it('удаление требует точной почты и причины', async () => {
    const user = userEvent.setup();
    renderCard('?tab=danger');
    await user.click(await screen.findByRole('button', { name: /Удалить аккаунт/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Удалить аккаунт навсегда?' });
    const confirm = within(dialog).getByRole('button', { name: 'Удалить навсегда' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Причина для журнала *'), 'просьба владельца');
    const input = within(dialog).getByLabelText(/для подтверждения/);
    await user.type(input, 'anna.s@example');
    expect(confirm).toBeDisabled();
    await user.type(input, '.ru');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE' && call.url.includes('action=account'))).toBe(true));
    const deleted = calls.find(call => call.method === 'DELETE')!;
    expect(deleted.body).toEqual({ userId: USER_ID, confirm: 'anna.s@example.ru', reason: 'просьба владельца' });
  });

  it('прежние действия на месте: «+ Генерации» через окно вместо prompt', async () => {
    const user = userEvent.setup();
    renderCard('?tab=access');
    await screen.findByRole('tab', { name: 'Доступы и лимиты' });
    await user.click(screen.getAllByRole('button', { name: /Генерации/ })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Добавить генерации' });
    const input = within(dialog).getByRole('spinbutton');
    await user.clear(input);
    await user.type(input, '250');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    await waitFor(() => expect(posted('topupSticker')).toHaveLength(1));
    expect(posted('topupSticker')[0].body).toEqual({ userId: USER_ID, codeId: 7, add: 250 });
  });

  it('отвязка ПК — только через подтверждение с причиной', async () => {
    const user = userEvent.setup();
    renderCard('?tab=devices');
    await screen.findByRole('tab', { name: 'ПК и пункты' });
    await user.click(screen.getAllByRole('button', { name: 'Отвязать' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Отвязать ПК «Касса-1»?' });
    expect(within(dialog).getByText(/забудет ключ устройства/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Отвязать ПК' })).toBeDisabled();
    expect(posted('revokeAppDevice')).toHaveLength(0);
  });

  it('окно лимитов: без причины не сохранить, с причиной — только изменённое', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(screen.getAllByRole('button', { name: /Лимиты/ })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Лимиты и доступы' });
    const save = within(dialog).getByRole('button', { name: 'Сохранить' });
    expect(save).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Увеличить: пункты' }));
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Причина для журнала *'), 'второй пункт');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(posted('setOverrides')).toHaveLength(1));
    const body = posted('setOverrides')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ userId: USER_ID, reason: 'второй пункт', slots: { devices: 2, points: 1, mirror: 0 } });
    expect(body.codes).toBeUndefined();
    expect(body.unlimited).toBeUndefined();
  });
});

describe('«Связать с Telegram» (только поддержка)', () => {
  const account = (userId: string, email: string | null, technical: boolean) => ({
    userId, email, technical, emailConfirmed: true, createdAt: '2026-01-01T00:00:00Z',
    summary: { walletKopecks: technical ? 51750 : 0, paidOrders: 1, activeSubscriptions: 0, devices: 0, cellPrintDevices: 0, points: 0 },
  });

  beforeEach(() => {
    linkReply = null;
    detail = makeDetail({
      loginMethods: { email: { address: 'anna.s@example.ru', confirmed: true, technical: false }, telegram: null, oauth: [] },
    });
    linkPreview = {
      outcome: 'merge', blockers: [], warnings: ['К аккаунту сайта перейдёт: баланс 517,5 ₽'], needsMoveConfirm: false,
      target: account(USER_ID, 'anna.s@example.ru', false), source: account('b0b', null, true),
      telegram: { telegramUserId: 716976910, username: 'anna_pvz', firstName: 'Анна', lastName: null, botStarted: true, botBlocked: false },
      request: { userId: USER_ID, telegramUserId: 716976910 },
    };
  });

  it('без Telegram: найти по ID → предпросмотр → без причины не отправить → с причиной уходит expected', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('tab', { name: 'Обзор' });
    await user.click(await screen.findByRole('button', { name: 'Привязать Telegram' }));
    const dialog = await screen.findByRole('dialog', { name: 'Привязать Telegram' });
    await user.type(within(dialog).getByLabelText('Telegram ID или @ник'), '716976910');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    expect(await within(dialog).findByText(/Объединим: баланс, покупки/)).toBeInTheDocument();
    expect(within(dialog).getByText(/баланс 517,5 ₽/)).toBeInTheDocument();
    const lookup = calls.find(call => call.url.includes('action=linkTelegramPreview'))!;
    expect(lookup.url).toContain(`userId=${USER_ID}`);
    expect(lookup.url).toContain('query=716976910');

    const submit = within(dialog).getByRole('button', { name: 'Объединить аккаунты' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Причина для журнала *'), 'написала в поддержку');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(posted('linkTelegram')).toHaveLength(1));
    expect(posted('linkTelegram')[0].body).toMatchObject({
      userId: USER_ID, telegramUserId: 716976910, expected: 'merge', reason: 'написала в поддержку',
    });
    expect((posted('linkTelegram')[0].body as Record<string, unknown>).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });

  it('ключ повтора: тот же предпросмотр — тот же ключ, новая проверка — новый', async () => {
    linkReply = { data: { error: 'Один и тот же пункт WB подключён в обоих аккаунтах', code: 'MERGE_POINT_CONFLICT' }, status: 409 };
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Привязать Telegram' }));
    const dialog = await screen.findByRole('dialog', { name: 'Привязать Telegram' });
    await user.type(within(dialog).getByLabelText('Telegram ID или @ник'), '716976910');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    await user.type(await within(dialog).findByLabelText('Причина для журнала *'), 'поддержка');
    const submit = within(dialog).getByRole('button', { name: 'Объединить аккаунты' });
    await user.click(submit);
    await waitFor(() => expect(posted('linkTelegram')).toHaveLength(1));
    expect(await within(dialog).findByText(/пункт WB подключён в обоих/)).toBeInTheDocument();
    await user.click(submit);
    await waitFor(() => expect(posted('linkTelegram')).toHaveLength(2));
    const keyOf = (i: number) => (posted('linkTelegram')[i].body as Record<string, unknown>).idempotencyKey;
    expect(keyOf(1)).toBe(keyOf(0));

    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    await user.type(await within(dialog).findByLabelText('Причина для журнала *'), 'поддержка');
    await user.click(within(dialog).getByRole('button', { name: 'Объединить аккаунты' }));
    await waitFor(() => expect(posted('linkTelegram')).toHaveLength(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('отказ из предпросмотра — кнопка выключена, причина не спрашивается', async () => {
    linkPreview = { ...(linkPreview as Record<string, unknown>), blockers: [{ code: 'MERGE_CLOUD_DATA', message: 'У аккаунта бота есть облачные данные' }] };
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Привязать Telegram' }));
    const dialog = await screen.findByRole('dialog', { name: 'Привязать Telegram' });
    await user.type(within(dialog).getByLabelText('Telegram ID или @ник'), '716976910');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить' }));
    expect(await within(dialog).findByText('У аккаунта бота есть облачные данные')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Объединить аккаунты' })).toBeDisabled();
    expect(within(dialog).queryByLabelText('Причина для журнала *')).toBeNull();
  });

  it('аккаунт бота: кнопка «Объединить с аккаунтом сайта», у аккаунта с Telegram — «Привязать» не показываем', async () => {
    detail = makeDetail({
      telegramOnly: true,
      loginMethods: {
        email: { address: null, confirmed: true, technical: true },
        telegram: { username: 'anna_pvz', telegramUserId: 716976910, linkedAt: '2026-03-20T10:00:00Z', bot: { started: true, blockedAt: null } },
        oauth: [],
      },
    });
    renderCard();
    expect(await screen.findByRole('button', { name: 'Объединить с аккаунтом сайта' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Привязать Telegram' })).toBeNull();
    expect(screen.getByText(/ID 716976910/)).toBeInTheDocument();
  });
});

describe('исходники карточки', () => {
  // vitest запускается из корня репозитория
  const root = join(process.cwd(), 'src', 'pages', 'admin', 'user');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('нет window.prompt и window.confirm', () => {
    const sources = [...files(root), join(root, '..', 'AdminUserPage.tsx')];
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/window\.(prompt|confirm)\s*\(/);
    }
  });
});
