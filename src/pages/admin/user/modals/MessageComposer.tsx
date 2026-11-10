import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleAlert, Mail, Monitor, Send, UserRound } from 'lucide-react';
import type { AdminMessageResult, AdminMessageTargets, AdminUserDetail, ChannelResult, MessageChannel } from '../../../../api/admin';
import { useMessageTargets, useSendMessage } from '../../../../api/admin-controls';
import { formatMskDateTime } from '../../../../lib/admin-audit';
import {
  MESSAGE_LIMITS,
  channelStatusLabel,
  channelStatusTone,
  isChannelOk,
  isValidMessageLink,
  linkPreview,
  pcMessageText,
  pluralChannels,
} from '../../../../lib/admin-controls';
import { Alert, Badge, Button, Field, Input, Modal, Segmented, Skeleton, Textarea } from '../../../../ui';
import { ErrorBlock, errorText, useIdempotencyKey } from '../../kit';
import { displayNameOf, modalSubtitle, realEmail } from '../shared';
import u from '../user.module.css';

const ORDER: readonly MessageChannel[] = ['cabinet', 'email', 'telegram', 'pc'];

const REASONS: Record<string, string> = {
  no_address: 'нет почты',
  not_confirmed: 'почта не подтверждена',
  not_configured: 'почта не настроена на сервере',
  not_linked: 'Telegram не привязан',
  not_started: 'бот не запущен',
  blocked: 'бот заблокирован',
  no_devices: 'нет ПК с Помощником ПВЗ',
};

type Preview = 'tg' | 'mail' | 'pc';

function ago(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 60) return `${Math.max(1, minutes)} мин`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн.`;
}

function availability(targets: AdminMessageTargets, channel: MessageChannel): { available: boolean; note: string } {
  if (channel === 'cabinet') return { available: true, note: 'всегда доступен' };
  if (channel === 'email') {
    const t = targets.email;
    if (!t.available) return { available: false, note: REASONS[t.reason ?? ''] ?? 'недоступна' };
    return { available: true, note: `${t.address ?? ''}${t.confirmed ? ' · подтверждена' : ''}` };
  }
  if (channel === 'telegram') {
    const t = targets.telegram;
    if (!t.available) return { available: false, note: REASONS[t.reason ?? ''] ?? 'недоступен' };
    return { available: true, note: `${t.username ? `@${t.username} · ` : ''}бот запущен` };
  }
  const t = targets.pc;
  if (!t.available) return { available: false, note: REASONS[t.reason ?? ''] ?? 'недоступно' };
  return { available: true, note: 'выберите компьютеры' };
}

const TITLES: Record<MessageChannel, string> = {
  cabinet: 'Кабинет на сайте',
  email: 'Почта',
  telegram: 'Telegram',
  pc: 'Сообщение на ПК',
};

/** После «из N»: «из 1 канала», «из 4 каналов». */
function ofChannels(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'канала' : 'каналов';
}

function capital(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Окно «Написать пользователю» (макет Message): каналы с доступностью, ПК,
 * тема, текст со счётчиками, ссылка, предпросмотр и итог по каждому каналу.
 */
export function MessageComposer({
  open,
  onOpenChange,
  detail,
  initialChannels,
  initialDeviceIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AdminUserDetail;
  initialChannels?: MessageChannel[];
  initialDeviceIds?: string[];
}) {
  const userId = detail.userId;
  const targets = useMessageTargets(userId, open);
  const send = useSendMessage();
  const key = useIdempotencyKey(open);
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<Preview>('tg');
  const [result, setResult] = useState<AdminMessageResult | null>(null);
  const [hiddenTg, setHiddenTg] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (!open) return;
    initialized.current = false;
    setSubject('');
    setBody('');
    setLink('');
    setResult(null);
    setHiddenTg(false);
    setError(null);
    setPending(false);
    busy.current = false;
    setPreview(initialChannels?.includes('pc') ? 'pc' : 'tg');
  }, [open]);

  // Каналы по умолчанию — когда узнали, какие доступны (один раз на открытие).
  // Ждём свежий ответ: при повторном открытии в кеше лежит прошлый снимок, и по нему
  // отметился бы канал, который с тех пор стал недоступен.
  useEffect(() => {
    if (!open || !targets.data || targets.isFetching || initialized.current) return;
    initialized.current = true;
    const data = targets.data;
    const wanted = initialChannels ?? ['cabinet', 'email', 'telegram'];
    setChannels(ORDER.filter(channel => wanted.includes(channel) && availability(data, channel).available));
    const known = new Set(data.pc.devices.map(device => device.id));
    setDeviceIds((initialDeviceIds ?? []).filter(id => known.has(id)).slice(0, MESSAGE_LIMITS.devices));
  }, [open, targets.data, targets.isFetching]);

  // Каждое обновление доступности: канал, ставший недоступным, и пропавшие ПК снимаем —
  // иначе галочка осталась бы отмеченной на выключенном поле, и её нельзя было бы снять.
  useEffect(() => {
    if (!open || !targets.data || !initialized.current) return;
    const data = targets.data;
    setChannels(prev => {
      const next = prev.filter(channel => availability(data, channel).available);
      return next.length === prev.length ? prev : next;
    });
    const known = new Set(data.pc.devices.map(device => device.id));
    setDeviceIds(prev => {
      const next = prev.filter(id => known.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [open, targets.data]);

  const data = targets.data;
  // Пока не пришёл свежий список каналов — показываем загрузку, а не прошлый снимок.
  const targetsLoading = targets.isPending || (targets.isFetching && !initialized.current);
  const linkTrim = link.trim();
  const linkOk = isValidMessageLink(linkTrim);
  const pcSelected = channels.includes('pc');
  const effective = data
    ? channels.filter(channel => availability(data, channel).available && (channel === 'pc' ? deviceIds.length > 0 : true))
    : [];
  const count = effective.length;
  const len = body.length;
  const pcText = pcMessageText(subject.trim(), body.trim());
  const subjectOk = subject.trim().length > 0 && subject.length <= MESSAGE_LIMITS.subject;
  const bodyOk = body.trim().length > 0 && body.length <= MESSAGE_LIMITS.body;
  const canSend = Boolean(data) && count > 0 && subjectOk && bodyOk && linkOk && !pending;

  let hint = 'Отправка повторно не задублирует письмо';
  if (!subjectOk) hint = 'Укажите тему';
  else if (!bodyOk) hint = len > MESSAGE_LIMITS.body ? `Текст длиннее ${MESSAGE_LIMITS.body} символов` : 'Напишите текст';
  else if (!linkOk) hint = 'Проверьте ссылку';
  else if (pcSelected && deviceIds.length === 0) hint = 'Выберите компьютеры или снимите канал «Сообщение на ПК»';

  const toggleChannel = (channel: MessageChannel) =>
    setChannels(prev => (prev.includes(channel) ? prev.filter(c => c !== channel) : ORDER.filter(c => c === channel || prev.includes(c))));
  const toggleDevice = (id: string) =>
    setDeviceIds(prev => (prev.includes(id) ? prev.filter(d => d !== id) : prev.length >= MESSAGE_LIMITS.devices ? prev : [...prev, id]));

  const submit = async () => {
    if (!canSend || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await send.mutateAsync({
        userId,
        channels: effective,
        subject: subject.trim(),
        body: body.trim(),
        ...(linkTrim ? { link: linkTrim } : {}),
        ...(effective.includes('pc') ? { deviceIds } : {}),
        idempotencyKey: key,
      });
      setResult(response);
    } catch (err) {
      setError(errorText(err));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const guardedOpenChange = (next: boolean) => {
    if (!next && busy.current) return;
    onOpenChange(next);
  };

  const subtitle = modalSubtitle(detail);

  if (result) {
    return (
      <Modal
        open={open}
        onOpenChange={guardedOpenChange}
        title="Итог отправки"
        description={subtitle}
        size="lg"
        sheet
        footer={
          <div className={u.foot}>
            <span className={u.footHint}>
              Запись в журнале {result.messageRef} · статусы обновятся, когда пользователь прочитает сообщение
            </span>
            <Link to={`/panel/audit?tab=deliveries&userId=${encodeURIComponent(userId)}`} onClick={() => onOpenChange(false)}>
              <Button variant="secondary" tabIndex={-1}>
                Открыть в журнале
              </Button>
            </Link>
            <Button onClick={() => onOpenChange(false)}>Закрыть</Button>
          </div>
        }
      >
        <ResultView result={result} detail={detail} hiddenTg={hiddenTg} onHideTg={() => {
          setHiddenTg(true);
          setChannels(prev => prev.filter(channel => channel !== 'telegram'));
        }} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={guardedOpenChange}
      title="Написать пользователю"
      description={subtitle}
      size="lg"
      sheet
      footer={
        <div className={u.foot}>
          <span className={u.footHint} aria-live="polite">
            {hint}
          </span>
          <Button variant="secondary" onClick={() => guardedOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={!canSend} loading={pending}>
            <Send size={16} aria-hidden="true" />
            {count > 0 ? `Отправить · ${count} ${pluralChannels(count)}` : 'Выберите канал'}
          </Button>
        </div>
      }
    >
      <div className={u.modalBody}>
        <section className={u.box} aria-labelledby="msg-channels">
          <div className={u.boxHead}>
            <h3 id="msg-channels">Каналы</h3>
            <span>
              Выбрано: {count} {pluralChannels(count)} из 4
            </span>
          </div>
          {targetsLoading && <Skeleton height={120} />}
          {targets.isError && !data && <ErrorBlock error={targets.error} onRetry={targets.refetch} />}
          {data && !targetsLoading && (
            <>
              <div className={u.choiceGrid}>
                {ORDER.map(channel => {
                  const state = availability(data, channel);
                  const checked = channels.includes(channel);
                  const note =
                    channel === 'pc' && state.available && checked
                      ? deviceIds.length > 0
                        ? `${deviceIds.length} из ${data.pc.devices.length}`
                        : 'не выбран ни один компьютер'
                      : state.note;
                  return (
                    <div key={channel} className={`${u.choice} ${!state.available ? u.choiceOff : checked ? u.choiceOn : ''}`}>
                      <input
                        id={`msg-ch-${channel}`}
                        type="checkbox"
                        checked={checked && state.available}
                        disabled={!state.available}
                        onChange={() => toggleChannel(channel)}
                      />
                      <label htmlFor={`msg-ch-${channel}`}>
                        <strong>{TITLES[channel]}</strong>
                        <small>{note}</small>
                      </label>
                    </div>
                  );
                })}
              </div>
              {pcSelected && data.pc.devices.length > 0 && (
                <div className={u.box} role="group" aria-labelledby="msg-devices">
                  <div className={u.boxHead}>
                    <h3 id="msg-devices">Компьютеры с Помощником ПВЗ</h3>
                    <span>до {MESSAGE_LIMITS.devices}</span>
                  </div>
                  <div className={u.choiceGrid}>
                    {data.pc.devices.map(device => {
                      const checked = deviceIds.includes(device.id);
                      return (
                        <div key={device.id} className={`${u.choice} ${checked ? u.choiceOn : ''}`}>
                          <input id={`msg-pc-${device.id}`} type="checkbox" checked={checked} onChange={() => toggleDevice(device.id)} />
                          <label htmlFor={`msg-pc-${device.id}`}>
                            <strong>
                              {device.name} · {device.online ? 'в сети' : `не в сети${device.lastSeenAt ? ` ${ago(device.lastSeenAt)}` : ''}`}
                            </strong>
                            <small style={{ color: 'var(--text-muted)' }}>
                              {device.online ? 'покажем сразу' : 'доставим, когда включится'}
                              {device.openMessages > 0 ? ` · непрочитанных: ${device.openMessages}` : ''}
                            </small>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className={u.muted}>Канал недоступен, если почта не подтверждена или бот заблокирован, — тогда он показан серым с причиной.</p>
            </>
          )}
        </section>

        <Field label="Тема" help="В письме и заголовке уведомления">
          <Input value={subject} maxLength={MESSAGE_LIMITS.subject} onChange={event => setSubject(event.target.value)} />
        </Field>

        <Field label="Текст">
          <Textarea rows={6} value={body} maxLength={MESSAGE_LIMITS.body} onChange={event => setBody(event.target.value)} />
        </Field>
        <div className={u.counter} style={{ marginTop: 'calc(-1 * var(--sp-3))' }} aria-live="polite">
          <span className={len > MESSAGE_LIMITS.telegram ? u.counterError : undefined}>
            Telegram {len} / {MESSAGE_LIMITS.telegram}
          </span>
          {' · '}
          <span className={pcText.length >= MESSAGE_LIMITS.pc ? u.counterWarn : undefined}>
            ПК {pcText.length} / {MESSAGE_LIMITS.pc}
          </span>
          {' · '}
          <span className={len > MESSAGE_LIMITS.cabinetBody ? u.counterWarn : undefined}>
            Кабинет {len} / {MESSAGE_LIMITS.cabinetBody}
          </span>
          {pcText.length >= MESSAGE_LIMITS.pc && <span className={u.counterWarn}> · на ПК покажем первые {MESSAGE_LIMITS.pc} символов</span>}
          {len > MESSAGE_LIMITS.cabinetBody && <span className={u.counterWarn}> · в кабинете — первые {MESSAGE_LIMITS.cabinetBody}</span>}
        </div>

        <Field
          label="Ссылка (необязательно)"
          error={linkOk ? undefined : 'Ссылка должна начинаться с https:// или с / для страниц сайта'}
          help="Ссылка должна начинаться с https:// или с / для страниц сайта"
        >
          <Input value={link} maxLength={MESSAGE_LIMITS.link} placeholder="/cabinet" inputMode="url" onChange={event => setLink(event.target.value)} />
        </Field>

        <section className={u.box} aria-labelledby="msg-preview">
          <div className={u.boxHead}>
            <h3 id="msg-preview">Как увидит пользователь</h3>
          </div>
          <Segmented<Preview>
            label="Предпросмотр"
            value={preview}
            onChange={setPreview}
            options={[
              { value: 'tg', label: 'Telegram' },
              { value: 'mail', label: 'Почта' },
              { value: 'pc', label: 'ПК' },
            ]}
          />
          {preview === 'tg' && (
            <div className={u.previewTg}>
              <span className={u.previewMeta}>ШК ВБ · бот</span>
              <b>{subject || 'Тема'}</b>
              {'\n\n'}
              {body || 'Текст сообщения'}
              {linkTrim && linkOk && <span className={u.previewLink}>Открыть · {linkPreview(linkTrim)}</span>}
            </div>
          )}
          {preview === 'mail' && (
            <div className={u.previewMail}>
              <span className={u.previewMeta}>ШК ВБ · уведомление · кому: {data?.email.address ?? realEmail(detail) ?? '—'}</span>
              <b>{subject || 'Тема'}</b>
              {'\n\n'}
              {body || 'Текст сообщения'}
              {linkTrim && linkOk && `\n\n${linkPreview(linkTrim)}`}
              {'\n\n—\nПисьмо пришло, потому что у вас есть аккаунт на shk-wb.ru'}
            </div>
          )}
          {preview === 'pc' && (
            <div className={u.previewPc}>
              <span className={u.previewMeta}>Помощник ПВЗ · {data?.pc.devices.find(d => deviceIds.includes(d.id))?.name ?? 'ПК'}</span>
              {pcText}
            </div>
          )}
        </section>

        <p className={u.muted}>Получатель: {displayNameOf(detail)}</p>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}

function resultTitle(item: ChannelResult): string {
  if (item.channel === 'cabinet') return 'Кабинет на сайте';
  if (item.channel === 'email') return 'Почта';
  if (item.channel === 'telegram') return `Telegram${item.recipient ? ` · ${item.recipient}` : ''}`;
  return `ПК · ${item.deviceName ?? item.deviceId.slice(0, 8)}`;
}

function resultNote(item: ChannelResult): string {
  if (item.error && !isChannelOk(item.status)) return `Ошибка: ${item.error}`;
  if (item.channel === 'cabinet') return item.status === 'failed' ? 'Не удалось создать уведомление' : 'В разделе «Уведомления», пользователь увидит при входе';
  if (item.channel === 'email') {
    if (item.status === 'not_configured') return 'Почта на сервере не настроена (нет RESEND_API_KEY) — письмо не ушло';
    return [item.recipient, item.providerId ? `id ${item.providerId}` : null].filter(Boolean).join(' · ') || channelStatusLabel('email', item.status);
  }
  if (item.channel === 'telegram') {
    if (item.status === 'blocked') return 'Ошибка: бот заблокирован пользователем';
    return channelStatusLabel('telegram', item.status);
  }
  if (item.status === 'queued') return item.online ? 'Окно показано в Помощнике ПВЗ, ожидает прочтения' : 'ПК не в сети — покажем, когда включится';
  return channelStatusLabel('pc', item.status);
}

function ResultView({
  result,
  detail,
  hiddenTg,
  onHideTg,
}: {
  result: AdminMessageResult;
  detail: AdminUserDetail;
  hiddenTg: boolean;
  onHideTg: () => void;
}) {
  // Ответ без итога (старый сервер, совместимое notify) не должен ронять окно.
  const results = Array.isArray(result.results) ? result.results : [];
  const summary = result.summary ?? { ok: results.filter(item => isChannelOk(item.status)).length, total: results.length };
  const allOk = summary.total > 0 && summary.ok === summary.total;
  return (
    <div className={u.modalBody}>
      <div className={u.summary} role="status">
        <strong>
          {allOk ? <CheckCircle2 size={20} aria-hidden="true" style={{ color: 'var(--success)', verticalAlign: '-4px' }} /> : null}{' '}
          Отправлено по {summary.ok} из {summary.total} {ofChannels(summary.total)}
        </strong>
        <span>
          {result.sentAt ? formatMskDateTime(result.sentAt) : ''} · «{result.subject}»{result.replayed ? ' · повтор: показан прежний итог' : ''}
        </span>
      </div>
      <div className={u.results}>
        {results.map((item, index) => {
          const ok = isChannelOk(item.status);
          const tgBlocked = item.channel === 'telegram' && item.status === 'blocked';
          const Icon = item.channel === 'email' ? Mail : item.channel === 'pc' ? Monitor : item.channel === 'telegram' ? Send : UserRound;
          return (
            <div key={`${item.channel}-${index}`} className={`${u.resultRow} ${ok ? '' : u.resultBad}`}>
              <Icon size={20} aria-hidden="true" />
              <div>
                <strong>{resultTitle(item)}</strong>
                <small>{resultNote(item)}</small>
                {tgBlocked && !hiddenTg && <small>Канал вернётся, когда пользователь снова запустит бота</small>}
                {tgBlocked && hiddenTg && <small>Канал отмечен недоступным и скрыт.</small>}
              </div>
              {tgBlocked && !hiddenTg && (
                <Button variant="secondary" size="sm" style={{ minHeight: 'var(--tap)' }} onClick={onHideTg}>
                  Отметить и скрыть канал
                </Button>
              )}
              <Badge tone={tgBlocked && hiddenTg ? 'default' : channelStatusTone(item.status)}>
                {tgBlocked && hiddenTg ? 'Скрыт' : ok ? capital(item.channel === 'email' ? 'отправлено' : 'доставлено') : capital(channelStatusLabel(item.channel, item.status))}
              </Badge>
            </div>
          );
        })}
      </div>
      {!allOk && (
        <p className={u.muted}>
          <CircleAlert size={14} aria-hidden="true" /> Не дошедшие каналы видны в журнале доставок {displayNameOf(detail)}. Письмо и Telegram с ошибкой можно отправить повторно оттуда.
        </p>
      )}
    </div>
  );
}
