import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { type AdminProgramKey, useAdminAppCrackFallback, useAdminAppFreeMode, useAdminAppStats, useAdminResource, useAdminResourceMutation, useSetAdminAppCrackFallback, useSetAdminAppFreeMode } from '../../api/admin';
import { useAppPlans } from '../../api/app';
import { shortDate } from '../../lib/admin-users';
import { Alert, Badge, Button, Card, Field, Input, Segmented, Skeleton, Stat, Switch, Table, useToast } from '../../ui';
import s from '../../layout/AdminShell.module.css';

type Promo = { id: number; code: string; limit: number; used: number; active: boolean; note: string | null };

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

  return (
    <div className="page stack-lg">
      <AppStatsCard />
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
            onChange={e =>
              setFreeMode.mutate(e.target.checked, {
                onSuccess: d => toast(d.enabled
                  ? 'Программа бесплатна для всех'
                  : `Тарифы снова платные. Подписки продлены на бесплатный период: ${d.extended?.users ?? 0} польз.`, 'success'),
                onError: error => toast(error.message, 'error'),
              })
            }
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
          className={s.toolbar}
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
          <Button type="submit" loading={keyMutation.create.isPending}>Создать</Button>
        </form>
        {keyMutation.create.isError && <Alert tone="error">{keyMutation.create.error.message}</Alert>}
      </Card>

      <section className="stack">
        <h3>Ключи</h3>
        {keys.isPending ? <Skeleton height={160} /> : keys.data?.length ? (
          <Table>
            <thead><tr><th>Ключ</th><th>Использовано</th><th>Создан</th><th>Статус</th><th>Пометка</th><th /></tr></thead>
            <tbody>
              {keys.data.map(key => (
                <tr key={key.id}>
                  <td className="mono">{key.key}</td>
                  <td>{key.used} из {key.limit}</td>
                  <td>{shortDate(key.createdAt)}</td>
                  <td><Badge tone={key.active ? 'success' : 'error'}>{key.active ? 'Активен' : 'Отозван'}</Badge></td>
                  <td>{key.note || '—'}</td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => keyMutation.update.mutate({ id: key.id, active: !key.active } as never)}>
                        {key.active ? 'Отозвать' : 'Вернуть'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Удалить ключ ${key.key}?`)) keyMutation.remove.mutate(key.id); }}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <Card>Ключей пока нет.</Card>}
      </section>

      <Card>
        <h3>Промокоды на скачивание программы</h3>
        <form
          className={s.toolbar}
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
          <Button type="submit" variant="secondary" loading={promoMutation.create.isPending}>Создать</Button>
        </form>

        {promos.data?.length ? (
          <Table>
            <thead><tr><th>Код</th><th>Использовано</th><th>Статус</th><th>Пометка</th><th /></tr></thead>
            <tbody>
              {promos.data.map(promo => (
                <tr key={promo.id}>
                  <td className="mono">{promo.code}</td>
                  <td>{promo.used} из {promo.limit}</td>
                  <td><Badge tone={promo.active ? 'success' : 'error'}>{promo.active ? 'Активен' : 'Отключён'}</Badge></td>
                  <td>{promo.note || '—'}</td>
                  <td>
                    <div className={s.row}>
                      <Button variant="ghost" size="sm" onClick={() => promoMutation.update.mutate({ id: promo.id, active: !promo.active } as never)}>
                        {promo.active ? 'Отключить' : 'Включить'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (window.confirm(`Удалить промокод ${promo.code}?`)) promoMutation.remove.mutate(promo.id); }}>
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
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
    <div className={s.toolbar} style={{ marginTop: 12 }}>
      <Field label="Бесплатно до (включительно)">
        <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
      </Field>
      <Button
        loading={setFreeMode.isPending}
        disabled={!date}
        // Конец дня по Москве: «до 01.12 включительно» = до 02.12 00:00 МСК.
        onClick={() => save(new Date(`${date}T23:59:59+03:00`).toISOString())}
      >
        Сохранить дату
      </Button>
      {current && (
        <Button variant="ghost" loading={setFreeMode.isPending} onClick={() => { setDate(''); save(null); }}>
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
        <Segmented
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

