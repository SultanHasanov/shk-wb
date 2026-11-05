import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Laptop, MapPin, MessageSquare, Send, Volume2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Segmented, Select, Textarea, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import {
  type AppAccount, type AppDevice, type PcMessage, useAppAccount, usePcMessages, useSendPcMessage, useSetDeviceAlertSound,
} from '../../api/app';
import { ALERT_SOUNDS, DEFAULT_ALERT_SOUND, playSound } from '../../lib/alert-sounds';
import { computerWord } from '../../lib/pricing';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useLocale, useLocalePath, useT } from '../../i18n';
import s from './PcMessagesPage.module.css';

/** «Без пункта» — ПК без программы WB или ещё не сообщивший пункт (как в «Доступе сотрудников»). */
const NO_POINT = '-';
const MAX_TEXT = 500;

function groupDevices(account: AppAccount) {
  const known = new Set((account.points ?? []).map(p => p.wbPointId));
  const by = new Map<string, AppDevice[]>();
  for (const d of account.devices) {
    const key = d.pointWb && known.has(d.pointWb) ? d.pointWb : d.pointWb || NO_POINT;
    by.set(key, [...(by.get(key) ?? []), d]);
  }
  return by;
}

const shortDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function statusBadge(m: PcMessage, t: T) {
  switch (m.status) {
    case 'answered':
      return <Badge tone="success">{m.answer === 'reply' ? t('Ответ', 'Жауап') : m.answerLabel ?? t('Ответ', 'Жауап')}</Badge>;
    case 'read':
      return <Badge tone="accent">{t('Показано', 'Көрсетілді')}</Badge>;
    case 'delivered':
      return <Badge tone="accent">{t('Доставлено', 'Жеткізілді')}</Badge>;
    case 'expired':
      return <Badge tone="warning">{t('Не доставлено за 3 дня', '3 күнде жеткізілмеді')}</Badge>;
    default:
      return <Badge tone="warning">{t('Ждёт ПК', 'ДК күтуде')}</Badge>;
  }
}

export function PcMessagesPage() {
  const t = useT();
  const lp = useLocalePath();
  useDocumentMeta(t('Сообщения на ПК — кабинет', 'ДК-ға хабарламалар — кабинет'));
  // «в сети» живёт 70 с — обновляем список ПК, пока страница открыта
  const account = useAppAccount({ refetchInterval: 30_000 });

  if (account.isPending) return <div className="page"><CabinetLoading /></div>;
  if (account.isError) return <div className="page"><CabinetError error={account.error} retry={() => account.refetch()} /></div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Сообщения на ПК', 'ДК-ға хабарламалар')}</h1>
          <p className="muted">
            {t('Напишите на компьютер пункта: в «Помощнике ПВЗ» окно появится поверх всего и прозвучит сигнал, даже если программа свёрнута в трей или из аккаунта вышли. Сотрудник ответит кнопкой или текстом — ответ придёт сюда и в Telegram.',
              'Пункт компьютеріне жазыңыз: «ПВЗ көмекшісінде» терезе бәрінің үстінде шығады және дыбыс беріледі. Қызметкер түймемен немесе мәтінмен жауап береді.')}
          </p>
        </div>
      </header>
      {account.data.devices.length === 0 ? (
        <EmptyState
          icon={<Laptop />}
          title={t('Программа ещё не подключена', 'Бағдарлама әлі қосылмаған')}
          text={t('Установите «Помощник ПВЗ» и войдите тем же логином и паролем, что на сайте.', '«ПВЗ көмекшісін» орнатып, сайттағы логин мен құпиясөзбен кіріңіз.')}
        />
      ) : (
        <Picker account={account.data} />
      )}
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-13)' }}>
        <Link to={lp('/cabinet/subscription')}>{t('Компьютеры и их роли', 'Компьютерлер мен рөлдер')}</Link>
        {' · '}
        {t('Сообщения работают в программе версии 1.12 и новее.', 'Хабарламалар 1.12 және одан жаңа нұсқада жұмыс істейді.')}
      </p>
    </div>
  );
}

function Picker({ account }: { account: AppAccount }) {
  const t = useT();
  const locale = useLocale();
  const groups = useMemo(() => groupDevices(account), [account]);
  const pointName = (wb: string) => {
    if (wb === NO_POINT) return t('Без пункта', 'Пунктсіз');
    const p = (account.points ?? []).find(x => x.wbPointId === wb);
    return p?.name || t(`Пункт №${wb}`, `№${wb} пункт`);
  };
  const tabs = [...groups.keys()].sort((a, b) => (a === NO_POINT ? 1 : b === NO_POINT ? -1 : pointName(a).localeCompare(pointName(b))));
  // ?device=<id> — ссылка из уведомления «ответ с ПК»
  const [params] = useSearchParams();
  const wanted = params.get('device');
  const wantedPoint = wanted ? tabs.find(k => groups.get(k)?.some(d => d.id === wanted)) : undefined;
  const [point, setPoint] = useState(wantedPoint ?? tabs[0]);
  const devices = groups.get(point) ?? [];
  const [deviceId, setDeviceId] = useState<string | null>(wantedPoint ? wanted : devices[0]?.id ?? null);
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
            <div>
              <h2 style={{ margin: 0 }}>{pointName(point)}</h2>
              <span className="muted" style={{ fontSize: 'var(--fs-13)' }}>{devices.length} {computerWord(devices.length, locale)}</span>
            </div>
            <div className={s.devices}>
              {devices.map(d => (
                <button key={d.id} type="button" className={`${s.device} ${d.id === deviceId ? s.on : ''}`} onClick={() => setDeviceId(d.id)}>
                  <span className={`${s.dot} ${d.online ? '' : s.off}`} title={d.online ? t('В сети', 'Желіде') : t('Не в сети', 'Желіде емес')} />
                  <span className={s.deviceText}>
                    <strong>{d.name}</strong>
                    <span className="muted">
                      {d.online ? t('В сети', 'Желіде') : `${t('Был в сети', 'Желіде болды')} ${shortDate(d.lastSeenAt)}`}
                      {d.appVersion ? ` · v${d.appVersion}` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Card>
        {device ? <Thread key={device.id} device={device} /> : null}
      </div>
    </>
  );
}

function Thread({ device }: { device: AppDevice }) {
  const t = useT();
  const toast = useToast();
  const messages = usePcMessages(device.id);
  const send = useSendPcMessage();
  const setSound = useSetDeviceAlertSound();
  const [text, setText] = useState('');
  const sound = device.alertSound ?? DEFAULT_ALERT_SOUND;

  const submit = () => {
    const clean = text.trim();
    if (!clean) return;
    send.mutate({ deviceId: device.id, text: clean }, {
      onSuccess: () => { setText(''); toast(device.online ? t('Отправлено — на ПК сейчас появится окно', 'Жіберілді') : t('Отправлено — ПК получит, когда выйдет в сеть', 'Жіберілді'), 'success'); },
      onError: e => toast(e instanceof Error ? e.message : String(e), 'error'),
    });
  };

  const changeSound = (id: string) => {
    playSound(id);
    setSound.mutate({ id: device.id, alertSound: id }, {
      onSuccess: () => toast(t('Звук сохранён — программа подхватит его в течение минуты', 'Дыбыс сақталды'), 'success'),
      onError: e => toast(e instanceof Error ? e.message : String(e), 'error'),
    });
  };

  return (
    <Card>
      <div className="stack">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>{device.name}</h2>
          {device.online ? <Badge tone="success">{t('В сети', 'Желіде')}</Badge> : <Badge>{t('Не в сети', 'Желіде емес')}</Badge>}
        </div>

        <div className={s.compose}>
          <Textarea
            value={text}
            maxLength={MAX_TEXT}
            placeholder={t('Например: «Пришла поставка, примите срочно» или «Выключите свет перед уходом»', 'Мысалы: «Жеткізілім келді, жедел қабылдаңыз»')}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          />
          <div className={s.composeBar}>
            <Button onClick={submit} loading={send.isPending} disabled={!text.trim()}><Send size={15} /> {t('Отправить', 'Жіберу')}</Button>
            <span className="muted" style={{ fontSize: 'var(--fs-12)' }}>Ctrl+Enter</span>
            <span className={s.counter}>{text.length} / {MAX_TEXT}</span>
          </div>
        </div>

        <div className={s.soundRow}>
          <Volume2 size={16} />
          <label htmlFor="pc-sound" style={{ fontSize: 'var(--fs-13)' }}>{t('Сигнал на этом ПК', 'Осы ДК-дағы дыбыс')}</label>
          <Select id="pc-sound" value={sound} disabled={setSound.isPending} onChange={e => changeSound(e.target.value)}>
            {ALERT_SOUNDS.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
          </Select>
          <Button variant="ghost" size="sm" onClick={() => playSound(sound)}>{t('Прослушать', 'Тыңдау')}</Button>
        </div>

        {messages.isPending ? (
          <CabinetLoading />
        ) : messages.isError ? (
          <CabinetError error={messages.error} retry={() => messages.refetch()} />
        ) : messages.data.items.length === 0 ? (
          <EmptyState icon={<MessageSquare />} title={t('Сообщений пока нет', 'Хабарламалар әлі жоқ')} text={t('Первое сообщение появится здесь вместе со статусом доставки и ответом.', 'Бірінші хабарлама жеткізу мәртебесімен және жауаппен осында шығады.')} />
        ) : (
          <div className={s.thread}>
            {messages.data.items.map(m => (
              <div key={m.id} className={s.item}>
                <div className={s.itemHead}>
                  <span>{shortDate(m.createdAt)}</span>
                  {statusBadge(m, t)}
                  {m.answeredAt && <span>{t('ответ', 'жауап')} {shortDate(m.answeredAt)}</span>}
                </div>
                <div className={s.itemText}>{m.text}</div>
                {m.answer === 'reply' && m.reply && <div className={s.reply}>{m.reply}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
