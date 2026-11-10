import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { type AdminProgramKey, useAdminAppCodeViaBot, useAdminAppCrackFallback, useAdminAppFreeMode, useAdminAppStats, useAdminResource, useAdminResourceMutation, useSetAdminAppCrackFallback, useSetAdminAppFreeMode } from '../../api/admin';
import { useAppPlans } from '../../api/app';
import { shortDate } from '../../lib/admin-users';
import { Alert, Badge, Button, Card, Field, Input, Skeleton, Stat, Switch, Table, useToast } from '../../ui';
import { ChipFilter, ConfirmDialog, DataState, EmptyBlock, ResponsiveTable } from './kit';
import type { ResponsiveColumn } from './kit';
import { useRemoveWithReason, useSetCodeViaBotWithReason } from './usePageActions';
import s from '../../layout/AdminShell.module.css';
import p from './admin-pages.module.css';

type Promo = { id: number; code: string; limit: number; used: number; active: boolean; note: string | null };

/** Опасные флаги программы: переключаются только через окно с причиной. */
type FlagChange = { flag: 'freeMode' | 'codeViaBot'; enabled: boolean };

const FLAG_TEXT: Record<FlagChange['flag'], Record<'on' | 'off', { title: string; text: string; confirm: string }>> = {
  freeMode: {
    on: {
      title: 'Сделать Помощник бесплатным для всех?',
      text: 'Каждый вошедший аккаунт получит тариф Про: подборы не списываются, лимит компьютеров не действует. Купленные подписки на это время замрут.',
      confirm: 'Включить бесплатный режим',
    },
    off: {
      title: 'Вернуть платные тарифы?',
      text: 'Бесплатный режим выключится через минуту. Купленные подписки продлятся на длину бесплатного периода.',
      confirm: 'Выключить бесплатный режим',
    },
  },
  codeViaBot: {
    on: {
      title: 'Код клиента — только через бот?',
      text: 'Программа 1.11+ будет просить владельца подтвердить выдачу в Telegram. Старые версии получат 403, аккаунты без Telegram код не получат.',
      confirm: 'Включить подтверждение в боте',
    },
    off: {
      title: 'Вернуть прямую выдачу кода клиента?',
      text: 'Программа снова будет показывать код клиента сразу, без подтверждения в боте.',
      confirm: 'Выключить подтверждение',
    },
  },
};

/** Ключ программы вводится вручную: так было и в старой админке, формат хранит бизнес. */
export function AdminProgramPage() {
  const toast = useToast();
  const plans = useAppPlans();
  const keys = useAdminResource<AdminProgramKey>('key');
  const keyMutation = useAdminResourceMutation<{ key: string; limit: number; note: string; used: number; active: boolean; createdAt: string }>('key');
  const promos = useAdminResource<Promo>('programPromo');
  const promoMutation = useAdminResourceMutation<{ code: string; limit: number; note: string; active: boolean }>('programPromo');
  const freeMode = useAdminAppFreeMode();
  const setFreeMode = useSetAdminAppFreeMode();
  const crack = useAdminAppCrackFallback();
  const setCrack = useSetAdminAppCrackFallback();
  const codeViaBot = useAdminAppCodeViaBot();
  const setCodeViaBot = useSetCodeViaBotWithReason();
  const removeKey = useRemoveWithReason('key');
  const removePromo = useRemoveWithReason('programPromo');
  const [flagChange, setFlagChange] = useState<FlagChange | null>(null);
  const [deleteKey, setDeleteKey] = useState<AdminProgramKey | null>(null);
  const [deletePromo, setDeletePromo] = useState<Promo | null>(null);
  const flagText = flagChange ? FLAG_TEXT[flagChange.flag][flagChange.enabled ? 'on' : 'off'] : null;

  const keyColumns: ResponsiveColumn<AdminProgramKey>[] = [
    { key: 'key', header: 'Ключ', primary: true, cell: key => <span className={p.mono}>{key.key}</span> },
    { key: 'used', header: 'Использовано', cell: key => `${key.used} из ${key.limit}` },
    { key: 'created', header: 'Создан', cell: key => shortDate(key.createdAt) },
    {
      key: 'status',
      header: 'Статус',
      cell: key => <Badge tone={key.active ? 'success' : 'error'}>{key.active ? 'Активен' : 'Отозван'}</Badge>,
    },
    { key: 'note', header: 'Пометка', cell: key => key.note || '—' },
  ];

  const promoColumns: ResponsiveColumn<Promo>[] = [
    { key: 'code', header: 'Код', primary: true, cell: promo => <span className={p.mono}>{promo.code}</span> },
    { key: 'used', header: 'Использовано', cell: promo => `${promo.used} из ${promo.limit}` },
    {
      key: 'status',
      header: 'Статус',
      cell: promo => <Badge tone={promo.active ? 'success' : 'error'}>{promo.active ? 'Активен' : 'Отключён'}</Badge>,
    },
    { key: 'note', header: 'Пометка', cell: promo => promo.note || '—' },
  ];

  return (
    <div className="page stack-lg">
      <AppStatsCard />
      <Card>
        <h3>Код клиента — только с подтверждением владельца в Telegram</h3>
        {codeViaBot.isPending ? (
          <Skeleton height={48} />
        ) : codeViaBot.isError ? (
          <Alert tone="error">Не удалось загрузить настройку: {codeViaBot.error.message}</Alert>
        ) : (
          <Switch
            checked={codeViaBot.data.enabled}
            disabled={setCodeViaBot.isPending}
            onChange={e => setFlagChange({ flag: 'codeViaBot', enabled: e.target.checked })}
            description="Пока включено, «QR код клиента» в программе (версия 1.11+) отправляет запрос владельцу в Telegram-бот: тот нажимает «Выдать» или «Отклонить», и QR появляется на компьютере. Старые версии программы получают 403 с просьбой обновиться. Аккаунт без привязанного Telegram коды получить не может — программа предложит владельцу подключить бот. Выключение возвращает прямую выдачу без обновления программы — аварийный выключатель, если бот недоступен."
          >
            Код клиента только через Telegram-бот
          </Switch>
        )}
      </Card>
      <Card>
        <h3>Бесплатный режим программы</h3>
        {freeMode.isPending ? (
          <Skeleton height={48} />
        ) : freeMode.isError ? (
          <Alert tone="error">Не удалось загрузить настройку: {freeMode.error.message}</Alert>
        ) : (
          <Switch
            checked={freeMode.data.enabled}
            disabled={setFreeMode.isPending}
            onChange={e => setFlagChange({ flag: 'freeMode', enabled: e.target.checked })}
            description="Пока включено, каждый вошедший в программу аккаунтом сайта получает тариф Про: все разделы открыты, подборы кода не списываются, лимит компьютеров не действует. Включается в программе в течение минуты, без обновления. Купленные подписки в это время не расходуются: при выключении они продлеваются на длину бесплатного периода. Стикеры по-прежнему расходуют генерации (квота Про или пакеты)."
          >
            Все функции «Помощника ПВЗ» бесплатно
          </Switch>
        )}
        {freeMode.data?.since && (
          <p className={s.mutedNote}>Включён с {new Date(freeMode.data.since).toLocaleString('ru-RU')}.</p>
        )}
        {freeMode.data?.enabled && <FreeUntil current={freeMode.data.until} />}
      </Card>
      <Card>
        <h3>Резервный подбор кода («Быстрый QR»)</h3>
        {crack.isPending ? (
          <Skeleton height={48} />
        ) : crack.isError ? (
          <Alert tone="error">Не удалось загрузить настройку: {crack.error.message}</Alert>
        ) : (
          <Switch
            checked={crack.data.enabled}
            disabled={setCrack.isPending}
            onChange={e =>
              setCrack.mutate(e.target.checked, {
                onSuccess: d => toast(d.enabled ? 'Кнопка «Быстрый QR» показана в программе' : 'Кнопка «Быстрый QR» скрыта', 'success'),
                onError: error => toast(error.message, 'error'),
              })
            }
            description="Обычный «QR код клиента» считается по SID мгновенно. Этот резерв нужен, если код не совпал: программа отправляет на сервер хеши клиента из базы WB, сервер подбирает код и возвращает его. Пока выключено — кнопки «Быстрый QR» в программе нет. Подбор по-прежнему списывает один подбор (как обычный код)."
          >
            Показывать кнопку резервного подбора «Быстрый QR»
          </Switch>
        )}
      </Card>
      <Card>
        <h3>Подписки «Помощник ПВЗ»</h3>
        <p className={s.mutedNote}>
          Тарифы и цены — из конфигурации программы (server/_app-plans.js). Выдать подписку вручную помимо оплаты,
          отвязать компьютер и посмотреть расход лимитов можно на странице пользователя: «Пользователи» → открыть человека → блок «Помощник ПВЗ».
        </p>
        {plans.isPending ? (
          <Skeleton height={140} />
        ) : plans.data ? (
          <Table>
            <thead>
              <tr>
                <th>Тариф</th>
                <th>Подборы/мес</th>
                <th>Стикеры/мес</th>
                <th>ПК</th>
                {plans.data.terms.map(t => (
                  <th key={t.months}>{t.months} мес{t.discountPercent ? ` (−${t.discountPercent}%)` : ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plans.data.plans.map(plan => (
                <tr key={plan.id}>
                  <td><b>{plan.title}</b></td>
                  <td>{plan.codes}</td>
                  <td>{plan.stickers || '—'}</td>
                  <td>{plan.devices}</td>
                  {plans.data!.terms.map(t => (
                    <td key={t.months}>{plan.prices[String(t.months)]} ₽</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Alert tone="error">Не удалось загрузить тарифы.</Alert>
        )}
      </Card>

      <Card>
        <h3>Создать лицензионный ключ</h3>
        <form
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            keyMutation.create.mutate({
              key: String(form.get('key') || '').trim().toUpperCase(),
              limit: Number(form.get('limit') || 0),
              note: String(form.get('note') || ''),
              used: 0, active: true, createdAt: new Date().toISOString(),
            }, {
              onSuccess: () => toast('Ключ создан', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Ключ"><Input name="key" defaultValue="WBPK-" required /></Field>
          <Field label="Лимит итераций"><Input name="limit" type="number" min={1} defaultValue={1000} required /></Field>
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" className={p.tap} loading={keyMutation.create.isPending}>Создать</Button>
        </form>
        {keyMutation.create.isError && <Alert tone="error">{keyMutation.create.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Ключи</h3>
        <DataState
          query={keys}
          isEmpty={rows => rows.length === 0}
          empty={<EmptyBlock title="Ключей пока нет" text="Создайте первый ключ выше." />}
        >
          {rows => (
            <ResponsiveTable
              rows={rows}
              columns={keyColumns}
              rowKey={key => key.id}
              rowActions={key => (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={p.tap}
                    onClick={() =>
                      keyMutation.update.mutate({ id: key.id, active: !key.active } as never, {
                        onError: (error: Error) => toast(error.message, 'error'),
                      })
                    }
                  >
                    {key.active ? 'Отозвать' : 'Вернуть'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={p.iconButton}
                    aria-label={`Удалить ключ ${key.key}`}
                    onClick={() => setDeleteKey(key)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </>
              )}
            />
          )}
        </DataState>
      </section>

      <Card>
        <h3>Промокоды на скачивание программы</h3>
        <form
          className={`${s.toolbar} ${p.formRow}`}
          onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            promoMutation.create.mutate({
              code: String(form.get('code') || '').trim().toUpperCase(),
              limit: Number(form.get('limit') || 1),
              note: String(form.get('note') || ''),
              active: true,
            }, {
              onSuccess: () => toast('Промокод создан', 'success'),
              onError: (error: Error) => toast(error.message, 'error'),
            });
          }}
        >
          <Field label="Код" help="3–32 латинские буквы, цифры, _ или -"><Input name="code" required /></Field>
          <Field label="Лимит"><Input name="limit" type="number" min={1} defaultValue={1} required /></Field>
          <Field label="Пометка"><Input name="note" /></Field>
          <Button type="submit" variant="secondary" className={p.tap} loading={promoMutation.create.isPending}>Создать</Button>
        </form>

        <div className="section">
          <DataState
            query={promos}
            isEmpty={rows => rows.length === 0}
            empty={<p className={s.mutedNote}>Промокодов пока нет.</p>}
          >
            {rows => (
              <ResponsiveTable
                rows={rows}
                columns={promoColumns}
                rowKey={promo => promo.id}
                rowActions={promo => (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={p.tap}
                      onClick={() =>
                        promoMutation.update.mutate({ id: promo.id, active: !promo.active } as never, {
                          onError: (error: Error) => toast(error.message, 'error'),
                        })
                      }
                    >
                      {promo.active ? 'Отключить' : 'Включить'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={p.iconButton}
                      aria-label={`Удалить промокод ${promo.code}`}
                      onClick={() => setDeletePromo(promo)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </>
                )}
              />
            )}
          </DataState>
        </div>
      </Card>

      <ConfirmDialog
        open={flagChange !== null}
        onOpenChange={open => !open && setFlagChange(null)}
        title={flagText?.title ?? ''}
        description={flagText?.text}
        confirmLabel={flagText?.confirm ?? ''}
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!flagChange) return;
          if (flagChange.flag === 'codeViaBot') {
            const d = await setCodeViaBot.mutateAsync({ enabled: flagChange.enabled, reason });
            toast(d.enabled ? 'Код клиента выдаётся через подтверждение в боте' : 'Код клиента снова выдаётся напрямую из программы', 'success');
            return;
          }
          // Объект, а не boolean: так в теле уходит и причина для журнала.
          const input = { enabled: flagChange.enabled, reason };
          const d = await setFreeMode.mutateAsync(input);
          toast(d.enabled
            ? 'Программа бесплатна для всех'
            : `Тарифы снова платные. Подписки продлены на бесплатный период: ${d.extended?.users ?? 0} польз.`, 'success');
        }}
      />

      <ConfirmDialog
        open={deleteKey !== null}
        onOpenChange={open => !open && setDeleteKey(null)}
        title={`Удалить ключ ${deleteKey?.key ?? ''}?`}
        description="Программа с этим ключом перестанет подбирать коды. Чтобы приостановить, нажмите «Отозвать»."
        confirmLabel="Удалить ключ"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!deleteKey) return;
          await removeKey.mutateAsync({ id: deleteKey.id, reason });
          toast('Ключ удалён', 'success');
        }}
      />

      <ConfirmDialog
        open={deletePromo !== null}
        onOpenChange={open => !open && setDeletePromo(null)}
        title={`Удалить промокод ${deletePromo?.code ?? ''}?`}
        description="По нему больше нельзя будет скачать программу. Чтобы приостановить, нажмите «Отключить»."
        confirmLabel="Удалить промокод"
        tone="danger"
        requireReason
        onConfirm={async ({ reason }) => {
          if (!deletePromo) return;
          await removePromo.mutateAsync({ id: deletePromo.id, reason });
          toast('Промокод удалён', 'success');
        }}
      />
    </div>
  );
}

/**
 * Дата окончания бесплатного периода: программа за 14 дней показывает плашку, крон за 7 и за 1 день
 * пишет пользователям, а в саму дату (около 9:00 МСК) выключает режим со сдвигом подписок.
 */
function FreeUntil({ current }: { current: string | null }) {
  const toast = useToast();
  const setFreeMode = useSetAdminAppFreeMode();
  const [date, setDate] = useState(current ? current.slice(0, 10) : '');
  const save = (until: string | null) =>
    setFreeMode.mutate(
      { enabled: true, until },
      {
        onSuccess: d => toast(d.until ? `Бесплатный период до ${new Date(d.until).toLocaleDateString('ru-RU')}` : 'Дата окончания снята', 'success'),
        onError: error => toast(error.message, 'error'),
      },
    );
  return (
    <div className={`${s.toolbar} ${p.formRow}`} style={{ marginTop: 12 }}>
      <Field label="Бесплатно до (включительно)">
        <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
      </Field>
      <Button
        className={p.tap}
        loading={setFreeMode.isPending}
        disabled={!date}
        // Конец дня по Москве: «до 01.12 включительно» = до 02.12 00:00 МСК.
        onClick={() => save(new Date(`${date}T23:59:59+03:00`).toISOString())}
      >
        Сохранить дату
      </Button>
      {current && (
        <Button variant="ghost" className={p.tap} loading={setFreeMode.isPending} onClick={() => { setDate(''); save(null); }}>
          Без даты
        </Button>
      )}
      <p className={s.mutedNote}>
        {current
          ? `Сейчас: до ${new Date(current).toLocaleString('ru-RU')}. За 14 дней — плашка в программе, за 7 и 1 день — письмо и Telegram, в эту дату режим выключится сам.`
          : 'Без даты режим работает, пока его не выключат вручную.'}
      </p>
    </div>
  );
}

const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

/**
 * Статистика «Помощника ПВЗ»: скачали (кнопка «Скачать» на сайте, уникальные — по хешу IP),
 * вошли в программу (новые компьютеры), пользуются (были в сети), оплатили.
 */
function AppStatsCard() {
  const [days, setDays] = useState(14);
  const stats = useAdminAppStats(days);
  const t = stats.data?.totals;
  return (
    <Card>
      <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Помощник ПВЗ — скачивания и установки</h3>
        <ChipFilter
          label="Период"
          value={String(days)}
          onChange={v => setDays(Number(v))}
          options={[{ value: '7', label: '7 дней' }, { value: '14', label: '14 дней' }, { value: '30', label: '30 дней' }, { value: '90', label: '90 дней' }]}
        />
      </div>
      {stats.isPending ? (
        <Skeleton height={140} />
      ) : stats.isError ? (
        <Alert tone="error">Не удалось загрузить статистику: {stats.error.message}</Alert>
      ) : t ? (
        <>
          <div className={s.tiles} style={{ marginTop: 12 }}>
            <Stat value={t.downloadVisitors} label="скачали (уникальные)" hint={`всего скачиваний: ${t.downloads}`} />
            <Stat value={t.devices} label="компьютеров вошли в программу" hint={`аккаунтов: ${t.accounts}`} />
            <Stat value={t.active24h} label="пользуются сегодня" hint={`за 7 дней: ${t.active7d}`} />
            <Stat value={t.paidUsers} label="с оплаченным тарифом" hint={`выручка: ${rub(t.revenue)}`} />
          </div>
          <p className={s.mutedNote}>
            Скачивания считаются с кнопки «Скачать» на сайте{t.since ? ` с ${new Date(t.since).toLocaleDateString('ru-RU')}` : ''}.
            Для поста добавьте к ссылке метку: <code>shk-wb.ru/api/payments/download-program?from=tg</code> — она появится в «Откуда».
          </p>
          <Table>
            <thead>
              <tr><th>День</th><th>Скачали</th><th>Вошли (новые ПК)</th><th>Оплаты</th><th>Сумма</th></tr>
            </thead>
            <tbody>
              {stats.data!.days.map(d => (
                <tr key={d.day}>
                  <td>{new Date(`${d.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' })}</td>
                  <td>{d.visitors ? <b>{d.visitors}</b> : '—'}{d.downloads > d.visitors ? <span className={s.mutedNote}> ({d.downloads})</span> : null}</td>
                  <td>{d.devices || '—'}</td>
                  <td>{d.payments || '—'}</td>
                  <td>{d.revenue ? rub(d.revenue) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {stats.data!.sources.length > 0 && (
            <>
              <h4 style={{ marginTop: 16 }}>Откуда скачивали</h4>
              <Table>
                <thead><tr><th>Источник</th><th>Скачали</th></tr></thead>
                <tbody>
                  {stats.data!.sources.map(x => (
                    <tr key={x.source}><td>{x.source}</td><td>{x.visitors}{x.downloads > x.visitors ? ` (${x.downloads})` : ''}</td></tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </>
      ) : null}
    </Card>
  );
}

