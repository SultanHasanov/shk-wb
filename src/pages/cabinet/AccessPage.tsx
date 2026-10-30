import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Laptop, Lock, MapPin, ShieldCheck } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Segmented, Switch, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { type AppAccount, type AppDevice, useAppAccount, useSetDeviceAccess } from '../../api/app';
import { matchingPreset, permissionActions, permissionPresets, permissionSections, type PermissionItem } from '../../lib/app-permissions';
import { useDocumentMeta } from '../../lib/seo';
import { useLocalePath, useT } from '../../i18n';
import s from './AccessPage.module.css';

/** «Без пункта» — ПК без программы WB (дома, в офисе) или ещё не сообщивший пункт. */
const NO_POINT = '-';

function groupDevices(account: AppAccount) {
  const known = new Set((account.points ?? []).map(p => p.wbPointId));
  const by = new Map<string, AppDevice[]>();
  for (const d of account.devices) {
    const key = d.pointWb && known.has(d.pointWb) ? d.pointWb : d.pointWb || NO_POINT;
    by.set(key, [...(by.get(key) ?? []), d]);
  }
  return by;
}

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
      <Alert tone="info">
        <ol className={s.steps}>
          <li>{t('Выберите пункт — ниже появятся компьютеры, на которых стоит программа WB этого пункта.', 'Пунктті таңдаңыз — төменде осы пункттің WB бағдарламасы орнатылған компьютерлер шығады.')}</li>
          <li>{t('Выберите компьютер и выключите то, что сотрудникам не нужно. Можно начать с готового шаблона.', 'Компьютерді таңдап, қызметкерлерге қажет еместі өшіріңіз. Дайын үлгіден бастауға болады.')}</li>
          <li>{t('Нажмите «Сохранить». Программа на этом компьютере применит изменения в течение 10 минут или сразу после перезапуска.', '«Сақтау» батырмасын басыңыз. Бағдарлама өзгерістерді 10 минут ішінде немесе қайта іске қосқаннан кейін қолданады.')}</li>
        </ol>
      </Alert>
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
  useEffect(() => {
    if (!devices.some(d => d.id === deviceId)) setDeviceId(devices[0]?.id ?? null);
  }, [devices, deviceId]);
  const device = devices.find(d => d.id === deviceId) ?? null;

  return (
    <>
      {tabs.length > 1 && (
        <Segmented
          label={t('Пункт', 'Пункт')}
          value={point}
          onChange={setPoint}
          options={tabs.map(k => ({ value: k, label: pointName(k), icon: k === NO_POINT ? <Laptop size={15} /> : <MapPin size={15} /> }))}
        />
      )}
      <div className={s.layout}>
        <Card>
          <div className="stack">
            <div className="row"><h2 style={{ margin: 0 }}>{pointName(point)}</h2><Badge>{devices.length}</Badge></div>
            {point === NO_POINT && (
              <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-13)' }}>
                {t('Компьютеры без программы WB или с версией программы старше 1.8.0.', 'WB бағдарламасы жоқ немесе нұсқасы 1.8.0-ден ескі компьютерлер.')}
              </p>
            )}
            <div className={s.devices}>
              {devices.map(d => {
                const closed = d.denied?.length ?? 0;
                return (
                  <button key={d.id} type="button" className={`${s.device} ${d.id === deviceId ? s.on : ''}`} onClick={() => setDeviceId(d.id)}>
                    <Laptop size={18} />
                    <span className={s.deviceText}>
                      <strong>{d.name}</strong>
                      <span className="muted">{t('Был в сети', 'Желіде болды')} {new Date(d.lastSeenAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    </span>
                    {closed > 0
                      ? <Badge tone="warning"><Lock size={12} /> {t(`Закрыто ${closed}`, `Жабық ${closed}`)}</Badge>
                      : <Badge tone="success">{t('Всё открыто', 'Бәрі ашық')}</Badge>}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
        {device ? <DeviceAccess key={device.id} device={device} others={devices.filter(d => d.id !== device.id)} /> : null}
      </div>
    </>
  );
}

function DeviceAccess({ device, others }: { device: AppDevice; others: AppDevice[] }) {
  const t = useT();
  const toast = useToast();
  const save = useSetDeviceAccess();
  const sections = permissionSections(t);
  const actions = permissionActions(t);
  const presets = permissionPresets(t);
  const [denied, setDenied] = useState<string[]>(device.denied ?? []);
  const saved = device.denied ?? [];
  const dirty = denied.length !== saved.length || denied.some(k => !saved.includes(k));
  const preset = matchingPreset(presets, denied);

  const toggle = (key: string, open: boolean) =>
    setDenied(cur => (open ? cur.filter(k => k !== key) : [...cur, key]));

  const persist = async (ids: string[]) => {
    try {
      for (const id of ids) await save.mutateAsync({ id, denied });
      toast(ids.length > 1 ? t(`Сохранено для ${ids.length} компьютеров`, `${ids.length} компьютер үшін сақталды`) : t('Сохранено', 'Сақталды'), 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const list = (title: string, items: PermissionItem[]) => (
    <div className="stack">
      <h3 style={{ margin: 0 }}>{title}</h3>
      {items.map(p => (
        <Switch key={p.key} checked={!denied.includes(p.key)} onChange={e => toggle(p.key, e.target.checked)} description={p.hint}>
          {p.title}
        </Switch>
      ))}
    </div>
  );

  return (
    <Card>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{device.name}</h2>
          {denied.length === 0 && <Badge tone="success"><ShieldCheck size={12} /> {t('Всё открыто', 'Бәрі ашық')}</Badge>}
        </div>
        <div className={s.presets}>
          {presets.map(p => (
            <button key={p.id} type="button" className={`${s.preset} ${preset === p.id ? s.on : ''}`} onClick={() => setDenied(p.denied)}>
              <strong>{p.title}</strong>
              <span className="muted">{p.hint}</span>
            </button>
          ))}
        </div>
        <div className={s.lists}>
          {list(t('Разделы', 'Бөлімдер'), sections)}
          {list(t('Действия', 'Әрекеттер'), actions)}
        </div>
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
