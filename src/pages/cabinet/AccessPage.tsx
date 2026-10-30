import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Laptop, Lock, MapPin, ShieldCheck } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Segmented, Switch, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { type AppAccount, type AppDevice, useAppAccount, useSetDeviceAccess } from '../../api/app';
import { matchingPreset, permissionActions, permissionPresets, permissionSections, type PermissionItem, type PermissionPreset } from '../../lib/app-permissions';
import { computerWord } from '../../lib/pricing';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useLocale, useLocalePath, useT } from '../../i18n';
import s from './AccessPage.module.css';

/** «Без пункта» — ПК без программы WB (дома, в офисе) или ещё не сообщивший пункт. */
const NO_POINT = '-';

/** Разделы и действия вперемешку, по смыслу: 26 переключателей одним столбцом не читались. */
const permissionGroups = (t: T) => [
  { id: 'issue', title: t('Выдача', 'Беру'), keys: ['cells', 'codeclient', 'tryon', 'notes', 'act.client_qr'] },
  { id: 'goods', title: t('Товары', 'Тауарлар'), keys: ['expensive', 'way', 'boxes', 'goods', 'video'] },
  { id: 'clients', title: t('Клиенты', 'Клиенттер'), keys: ['search', 'dossier', 'reviews', 'act.archive_view'] },
  { id: 'staff', title: t('Сотрудники и стикеры', 'Қызметкерлер мен стикерлер'), keys: ['staff', 'act.payroll', 'act.staff_edit', 'stickers', 'act.stickers_generate', 'cellprint'] },
  { id: 'admin', title: t('Настройки, оплаты и аккаунт', 'Баптаулар, төлемдер және аккаунт'), keys: ['telegram', 'settings', 'act.video_settings', 'act.load_pc', 'act.pay', 'act.account'] },
];

function groupDevices(account: AppAccount) {
  const known = new Set((account.points ?? []).map(p => p.wbPointId));
  const by = new Map<string, AppDevice[]>();
  for (const d of account.devices) {
    const key = d.pointWb && known.has(d.pointWb) ? d.pointWb : d.pointWb || NO_POINT;
    by.set(key, [...(by.get(key) ?? []), d]);
  }
  return by;
}

/** Настройки дошли до программы, если она выходила на связь после сохранения. */
function applied(d: AppDevice) {
  return !d.accessUpdatedAt || Date.parse(d.lastSeenAt) >= Date.parse(d.accessUpdatedAt);
}

/** Короткая сводка «что открыто»: имя шаблона или «Открыто N из M». */
function accessSummary(denied: string[], presets: PermissionPreset[], total: number, t: T) {
  const id = matchingPreset(presets, denied);
  if (id) return presets.find(p => p.id === id)!.title;
  const open = total - denied.length;
  return t(`Открыто ${open} из ${total}`, `${total} ішінен ${open} ашық`);
}

const shortDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AccessPage() {
  const t = useT();
  const lp = useLocalePath();
  useDocumentMeta(t('Доступ сотрудников — кабинет', 'Қызметкерлер қолжетімділігі — кабинет'));
  const account = useAppAccount();

  if (account.isPending) return <div className="page"><CabinetLoading /></div>;
  if (account.isError) return <div className="page"><CabinetError error={account.error} retry={() => account.refetch()} /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Доступ сотрудников', 'Қызметкерлер қолжетімділігі')}</h1>
        <p>{t('Закройте на компьютерах сотрудников разделы и действия программы «Помощник ПВЗ», которые им не нужны.', 'Қызметкерлер компьютерлерінде «ПВЗ көмекшісі» бағдарламасының қажет емес бөлімдері мен әрекеттерін жабыңыз.')}</p>
      </header>
      {/* Инструкция свёрнута: на телефоне три шага в рамке занимали полэкрана. */}
      <details className={s.howto}>
        <summary>{t('Как это работает', 'Бұл қалай жұмыс істейді')}</summary>
        <ol className={s.steps}>
          <li>{t('Выберите пункт — ниже появятся компьютеры, на которых стоит программа WB этого пункта.', 'Пунктті таңдаңыз — төменде осы пункттің WB бағдарламасы орнатылған компьютерлер шығады.')}</li>
          <li>{t('Выберите компьютер и выключите то, что сотрудникам не нужно. Можно начать с готового шаблона.', 'Компьютерді таңдап, қызметкерлерге қажет еместі өшіріңіз. Дайын үлгіден бастауға болады.')}</li>
          <li>{t('Нажмите «Сохранить». Программа на этом компьютере применит изменения в течение 10 минут или сразу после перезапуска.', '«Сақтау» батырмасын басыңыз. Бағдарлама өзгерістерді 10 минут ішінде немесе қайта іске қосқаннан кейін қолданады.')}</li>
        </ol>
      </details>
      {account.data.devices.length === 0 ? (
        <Card>
          <EmptyState icon={<Laptop />} title={t('Компьютеров пока нет', 'Компьютерлер әзірге жоқ')} text={t('Установите «Помощник ПВЗ» на компьютеры пунктов и войдите в аккаунт — они появятся здесь.', '«ПВЗ көмекшісін» пункт компьютерлеріне орнатып, аккаунтқа кіріңіз — олар осында шығады.')} />
        </Card>
      ) : (
        <AccessEditor account={account.data} />
      )}
      <p className="muted" style={{ margin: 0 }}>
        {t('Совет: подключайте компьютеры сотрудников кнопкой «Войти через сайт» в программе — тогда сотрудникам не нужен ваш пароль, и они не смогут сами открыть себе доступ в кабинете.', 'Кеңес: қызметкерлер компьютерлерін бағдарламадағы «Сайт арқылы кіру» батырмасымен қосыңыз — сонда оларға сіздің құпиясөзіңіз қажет емес.')}{' '}
        <Link to={lp('/cabinet/subscription')}>{t('Компьютеры и пункты', 'Компьютерлер мен пункттер')}</Link>
      </p>
    </div>
  );
}

function AccessEditor({ account }: { account: AppAccount }) {
  const t = useT();
  const locale = useLocale();
  const presets = permissionPresets(t);
  const total = permissionSections(t).length + permissionActions(t).length;
  const groups = useMemo(() => groupDevices(account), [account]);
  const pointName = (wb: string) => {
    if (wb === NO_POINT) return t('Без пункта', 'Пунктсіз');
    const p = (account.points ?? []).find(x => x.wbPointId === wb);
    return p?.name || t(`Пункт №${wb}`, `№${wb} пункт`);
  };
  const tabs = [...groups.keys()].sort((a, b) => (a === NO_POINT ? 1 : b === NO_POINT ? -1 : pointName(a).localeCompare(pointName(b))));
  const [point, setPoint] = useState(tabs[0]);
  const devices = groups.get(point) ?? [];
  const [deviceId, setDeviceId] = useState<string | null>(devices[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!devices.some(d => d.id === deviceId)) setDeviceId(devices[0]?.id ?? null);
  }, [devices, deviceId]);
  const device = devices.find(d => d.id === deviceId) ?? null;

  // Переход на другой ПК или пункт молча выбрасывал несохранённые переключатели.
  const leave = (go: () => void) => {
    if (dirty && !window.confirm(t('Есть несохранённые изменения. Перейти без сохранения?', 'Сақталмаған өзгерістер бар. Сақтамай өту керек пе?'))) return;
    setDirty(false);
    go();
  };

  return (
    <>
      {tabs.length > 1 && (
        <Segmented
          label={t('Пункт', 'Пункт')}
          value={point}
          onChange={k => leave(() => setPoint(k))}
          options={tabs.map(k => ({ value: k, label: pointName(k), icon: k === NO_POINT ? <Laptop size={15} /> : <MapPin size={15} /> }))}
        />
      )}
      <div className={s.layout}>
        <Card>
          <div className="stack">
            <div>
              <h2 style={{ margin: 0 }}>{pointName(point)}</h2>
              <span className="muted" style={{ fontSize: 'var(--fs-13)' }}>{devices.length} {computerWord(devices.length, locale)}</span>
            </div>
            {point === NO_POINT && (
              <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-13)' }}>
                {t('Компьютеры без программы WB или с версией программы старше 1.8.0.', 'WB бағдарламасы жоқ немесе нұсқасы 1.8.0-ден ескі компьютерлер.')}
              </p>
            )}
            <div className={s.devices}>
              {devices.map(d => {
                const closed = d.denied ?? [];
                return (
                  <button key={d.id} type="button" className={`${s.device} ${d.id === deviceId ? s.on : ''}`} onClick={() => d.id !== deviceId && leave(() => setDeviceId(d.id))}>
                    <Laptop size={18} />
                    <span className={s.deviceText}>
                      <strong>{d.name}</strong>
                      <span className="muted">{t('Был в сети', 'Желіде болды')} {shortDate(d.lastSeenAt)}</span>
                      {applied(d)
                        ? <span className={s.status}><CheckCircle2 size={12} /> {t('Настройки применены', 'Баптаулар қолданылды')}</span>
                        : <span className={`${s.status} ${s.pending}`}><Clock size={12} /> {t('Ждёт связи с программой', 'Бағдарламамен байланысты күтуде')}</span>}
                    </span>
                    {closed.length > 0
                      ? <Badge tone="warning"><Lock size={12} /> {accessSummary(closed, presets, total, t)}</Badge>
                      : <Badge tone="success">{t('Всё открыто', 'Бәрі ашық')}</Badge>}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
        {device ? (
          <DeviceAccess
            key={device.id}
            device={device}
            others={devices.filter(d => d.id !== device.id)}
            allOthers={account.devices.filter(d => d.id !== device.id)}
            onDirtyChange={setDirty}
          />
        ) : null}
      </div>
    </>
  );
}

function DeviceAccess({ device, others, allOthers, onDirtyChange }: {
  device: AppDevice;
  /** остальные ПК этого пункта — для «Применить ко всем» */
  others: AppDevice[];
  /** все остальные ПК аккаунта — чтобы предупредить, если управлять аккаунтом станет негде */
  allOthers: AppDevice[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSetDeviceAccess();
  const items = useMemo(() => new Map([...permissionSections(t), ...permissionActions(t)].map(p => [p.key, p])), [t]);
  const presets = permissionPresets(t);
  const [denied, setDenied] = useState<string[]>(device.denied ?? []);
  const saved = device.denied ?? [];
  const dirty = denied.length !== saved.length || denied.some(k => !saved.includes(k));
  const preset = matchingPreset(presets, denied);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Ключи, которых нет в группах (новые права из будущих версий), не должны пропасть из списка.
  const groups = useMemo(() => {
    const list = permissionGroups(t).map(g => ({ ...g, items: g.keys.map(k => items.get(k)).filter((p): p is PermissionItem => Boolean(p)) }));
    const grouped = new Set(list.flatMap(g => g.keys));
    const rest = [...items.values()].filter(p => !grouped.has(p.key));
    return rest.length ? [...list, { id: 'other', title: t('Другое', 'Басқа'), keys: rest.map(p => p.key), items: rest }] : list;
  }, [items, t]);

  const toggle = (key: string, open: boolean) =>
    setDenied(cur => (open ? cur.filter(k => k !== key) : [...cur, key]));
  const setGroup = (keys: string[], open: boolean) =>
    setDenied(cur => (open ? cur.filter(k => !keys.includes(k)) : [...new Set([...cur, ...keys])]));

  const persist = async (ids: string[]) => {
    try {
      for (const id of ids) await save.mutateAsync({ id, denied });
      toast(ids.length > 1 ? t(`Сохранено для ${ids.length} компьютеров`, `${ids.length} компьютер үшін сақталды`) : t('Сохранено', 'Сақталды'), 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  // Владелец может закрыть «Управлять аккаунтом» везде — тогда вернуть это можно только из кабинета.
  const accountLockedEverywhere = denied.includes('act.account') && allOthers.every(d => d.denied?.includes('act.account'));

  return (
    <Card>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{device.name}</h2>
          {denied.length === 0 && <Badge tone="success"><ShieldCheck size={12} /> {t('Всё открыто', 'Бәрі ашық')}</Badge>}
        </div>
        <div className={s.presets} role="radiogroup" aria-label={t('Шаблон доступа', 'Қолжетімділік үлгісі')}>
          {presets.map(p => (
            <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className={`${s.preset} ${preset === p.id ? s.on : ''}`} onClick={() => setDenied(p.denied)}>
              <span className={s.radio} aria-hidden="true" />
              <span className={s.presetText}>
                <strong>{p.title}</strong>
                <span className="muted">{p.hint}</span>
              </span>
            </button>
          ))}
          {preset === null && (
            <div className={`${s.preset} ${s.on}`}>
              <span className={s.radio} aria-hidden="true" />
              <span className={s.presetText}>
                <strong>{t('Свои настройки', 'Өз баптаулары')}</strong>
                <span className="muted">{accessSummary(denied, presets, items.size, t)}</span>
              </span>
            </div>
          )}
        </div>
        <div className={s.lists}>
          {groups.map(g => {
            const open = g.items.filter(p => !denied.includes(p.key)).length;
            const allOpen = open === g.items.length;
            return (
              <section key={g.id} className={s.group}>
                <div className={s.groupHead}>
                  <h3>{g.title}</h3>
                  <span className="muted">{t(`${open} из ${g.items.length}`, `${g.items.length} ішінен ${open}`)}</span>
                  <button type="button" className={s.groupToggle} onClick={() => setGroup(g.keys, !allOpen)}>
                    {allOpen ? t('Закрыть все', 'Бәрін жабу') : t('Открыть все', 'Бәрін ашу')}
                  </button>
                </div>
                {g.items.map(p => (
                  <Switch key={p.key} checked={!denied.includes(p.key)} onChange={e => toggle(p.key, e.target.checked)} description={p.hint}>
                    {p.title}
                  </Switch>
                ))}
              </section>
            );
          })}
        </div>
        {accountLockedEverywhere && (
          <Alert tone="warning">
            {t('«Управлять аккаунтом» будет закрыто на всех компьютерах. Отключать ПК, менять пароль и выходить на других компьютерах из программы станет нельзя — вернуть доступ можно будет только здесь, в кабинете.', '«Аккаунтты басқару» барлық компьютерде жабылады. Қолжетімділікті тек осы кабинеттен қайтаруға болады.')}
          </Alert>
        )}
        <div className={s.saveBar}>
          <Button disabled={!dirty} loading={save.isPending} onClick={() => persist([device.id])}>{t('Сохранить', 'Сақтау')}</Button>
          {others.length > 0 && (
            <Button variant="secondary" loading={save.isPending} onClick={() => persist([device.id, ...others.map(d => d.id)])}>
              {t(`Применить ко всем ПК пункта (${others.length + 1})`, `Пункттің барлық ДК-на қолдану (${others.length + 1})`)}
            </Button>
          )}
          {dirty && <Button variant="ghost" onClick={() => setDenied(saved)}>{t('Отменить', 'Болдырмау')}</Button>}
          <span className="muted" style={{ fontSize: 'var(--fs-13)' }}>
            {t('Изменения дойдут до программы за 10 минут или после её перезапуска.', 'Өзгерістер бағдарламаға 10 минутта немесе қайта іске қосқаннан кейін жетеді.')}
          </span>
        </div>
      </div>
    </Card>
  );
}
