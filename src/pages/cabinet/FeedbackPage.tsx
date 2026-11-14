import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, Download, Link2, MessageSquareText, Pause, Play, Plus, Printer, Send, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Segmented, Select, Switch, Tabs, Textarea, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { useCabinet, cabinetKey } from '../../api/cabinet';
import {
  type FeedbackBoard,
  type FeedbackBoardInput,
  type FeedbackEntry,
  type FeedbackFilter,
  type FeedbackKind,
  useDeleteFeedback,
  useDeleteFeedbackBoard,
  useFeedbackBoards,
  useFeedbackEntries,
  useReadFeedback,
  useSaveFeedbackBoard,
} from '../../api/feedback';
import {
  DEFAULT_DESIGN,
  DEFAULT_HEADLINE,
  DEFAULT_NOTE,
  FORMAT_OPTIONS,
  THEME_OPTIONS,
  cardPng,
  cardSvg,
  colorReadable,
  palette,
  printCard,
  type FeedbackFormat,
} from '../../lib/feedback-card';
import { clearDraft, draftKey, readDraft, sameValue, writeDraft } from '../../lib/feedback-draft';
import { TelegramLogin } from '../../auth/TelegramLogin';
import { useQueryClient } from '@tanstack/react-query';
import { useDocumentMeta } from '../../lib/seo';
import { type T, useT } from '../../i18n';
import s from './FeedbackPage.module.css';

type Tab = 'inbox' | 'qr';

const KIND_LOOK: Record<FeedbackKind, { cls: string; ru: string; kz: string }> = {
  complaint: { cls: s.kindComplaint, ru: 'Жалоба', kz: 'Шағым' },
  idea: { cls: s.kindIdea, ru: 'Предложение', kz: 'Ұсыныс' },
  thanks: { cls: s.kindThanks, ru: 'Благодарность', kz: 'Алғыс' },
};

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const boardTitle = (b: Pick<FeedbackBoard, 'label' | 'place'>, t: T) => b.label || b.place || t('QR без названия', 'Атаусыз QR');

function Stars({ value, size = 17 }: { value: number; size?: number }) {
  return (
    <span className={s.stars} style={{ fontSize: size }} role="img" aria-label={`Оценка ${value} из 5`}>
      {'★'.repeat(value)}
      <span className={s.starsOff}>{'★'.repeat(5 - value)}</span>
    </span>
  );
}

export function FeedbackPage() {
  const t = useT();
  useDocumentMeta(t('Отзывы клиентов — кабинет', 'Клиент пікірлері — кабинет'));
  const [params, setParams] = useSearchParams();
  const boards = useFeedbackBoards();
  const tab: Tab = params.get('tab') === 'qr' ? 'qr' : params.get('tab') === 'inbox' ? 'inbox' : boards.data && !boards.data.items.length ? 'qr' : 'inbox';
  const setTab = (next: Tab) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', next); return n; }, { replace: true });
  const unread = boards.data?.summary.unread ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('Отзывы клиентов', 'Клиент пікірлері')}</h1>
        <p>{t(
          'Повесьте карточку с QR-кодом на дверь или стол выдачи. Клиент отсканирует её и анонимно оставит оценку, комментарий и фото — отзыв придёт сюда, в Telegram и на почту.',
          'QR-коды бар карточканы есікке немесе беру үстеліне іліңіз. Клиент оны сканерлеп, бағасын, пікірін және фотосын жасырын қалдырады — пікір осында, Telegram-ға және поштаға келеді.',
        )}</p>
      </header>
      {boards.isPending ? <CabinetLoading /> : boards.isError ? <CabinetError error={boards.error} retry={() => boards.refetch()} /> : (
        <Tabs<Tab>
          label={t('Разделы отзывов', 'Пікірлер бөлімдері')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'inbox', label: unread ? `${t('Отзывы', 'Пікірлер')} · ${unread}` : t('Отзывы', 'Пікірлер'), content: <Inbox data={boards.data} onCreate={() => setTab('qr')} /> },
            { value: 'qr', label: t('QR-коды', 'QR-кодтар'), content: <QrCodes boards={boards.data.items} limit={boards.data.limit} /> },
          ]}
        />
      )}
    </div>
  );
}

// ───────────────────────── Входящие отзывы ─────────────────────────

function Inbox({ data, onCreate }: { data: NonNullable<ReturnType<typeof useFeedbackBoards>['data']>; onCreate: () => void }) {
  const t = useT();
  const toast = useToast();
  const [filter, setFilter] = useState<FeedbackFilter>('all');
  const [board, setBoard] = useState('');
  const entries = useFeedbackEntries(filter, board);
  const read = useReadFeedback();
  const remove = useDeleteFeedback();
  const [photo, setPhoto] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<FeedbackEntry | null>(null);
  const names = useMemo(() => new Map(data.items.map(b => [b.id, boardTitle(b, t)])), [data.items, t]);
  const { summary } = data;
  const maxRating = Math.max(1, ...summary.ratings30);

  if (!data.items.length) {
    return (
      <Card>
        <EmptyState
          icon={<MessageSquareText size={26} />}
          title={t('Отзывов пока нет', 'Әзірге пікір жоқ')}
          text={t('Создайте QR-код, распечатайте карточку и повесьте её там, где клиенты ждут заказ.', 'QR-код жасап, карточканы басып шығарыңыз және клиенттер тапсырыс күтетін жерге іліңіз.')}
          action={<Button onClick={onCreate}><Plus size={18} />{t('Создать QR-код', 'QR-код жасау')}</Button>}
        />
      </Card>
    );
  }

  const items = entries.data?.pages.flatMap(p => p.items) ?? [];
  const filters: ReadonlyArray<{ value: FeedbackFilter; label: string }> = [
    { value: 'all', label: t('Все', 'Барлығы') },
    { value: 'new', label: summary.unread ? `${t('Новые', 'Жаңа')} · ${summary.unread}` : t('Новые', 'Жаңа') },
    { value: 'complaint', label: t('Жалобы', 'Шағымдар') },
    { value: 'idea', label: t('Предложения', 'Ұсыныстар') },
    { value: 'thanks', label: t('Благодарности', 'Алғыстар') },
  ];

  return (
    <div className="stack">
      <div className={s.stats}>
        <Card>
          <div className={s.statLabel}>{t('Средняя оценка, 30 дней', 'Орташа баға, 30 күн')}</div>
          <div className={s.statRow}>
            <span className={s.statValue}>{summary.avg30 === null ? '—' : summary.avg30.toLocaleString('ru-RU')}</span>
            {summary.avg30 !== null && <Stars value={Math.round(summary.avg30)} size={18} />}
          </div>
        </Card>
        <Card>
          <div className={s.statLabel}>{t('Отзывов, 30 дней', 'Пікірлер, 30 күн')}</div>
          <div className={s.statValue}>{summary.count30}</div>
          <div className={s.statHint}>{t(`Жалоб ${summary.kinds30.complaint} · предложений ${summary.kinds30.idea}`, `Шағым ${summary.kinds30.complaint} · ұсыныс ${summary.kinds30.idea}`)}</div>
        </Card>
        <Card>
          <div className={s.statLabel}>{t('Новые', 'Жаңа')}</div>
          <div className={`${s.statValue} ${summary.unread ? s.statAccent : ''}`}>{summary.unread}</div>
          <div className={s.statHint}>{summary.unread ? t('ещё не прочитаны', 'әлі оқылмаған') : t('всё прочитано', 'бәрі оқылды')}</div>
        </Card>
        <Card>
          <div className={s.statLabel}>{t('Распределение, 30 дней', 'Таралуы, 30 күн')}</div>
          <div className={s.bars}>
            {[5, 4, 3, 2, 1].map(n => (
              <div key={n} className={s.barRow}>
                <span>{n}</span>
                <span className={s.barTrack}><span className={s.barFill} style={{ width: `${(summary.ratings30[n - 1] / maxRating) * 100}%` }} /></span>
                <span>{summary.ratings30[n - 1]}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className={s.toolbar}>
        <Segmented<FeedbackFilter> label={t('Фильтр отзывов', 'Пікір сүзгісі')} value={filter} onChange={setFilter} options={filters} />
        <div className={s.toolbarRight}>
          {data.items.length > 1 && (
            <Select aria-label={t('QR-код', 'QR-код')} value={board} onChange={e => setBoard(e.target.value)}>
              <option value="">{t('Все QR-коды', 'Барлық QR-кодтар')}</option>
              {data.items.map(b => <option key={b.id} value={b.id}>{boardTitle(b, t)}</option>)}
            </Select>
          )}
          <Button variant="secondary" size="sm" disabled={!summary.unread} loading={read.isPending && Boolean(read.variables && 'all' in read.variables)}
            onClick={() => read.mutate(board ? { all: true, boardId: board } : { all: true }, { onError: e => toast(e.message, 'error') })}>
            {t('Прочитать все', 'Барлығын оқу')}
          </Button>
        </div>
      </div>

      {entries.isPending ? <CabinetLoading /> : entries.isError ? <CabinetError error={entries.error} retry={() => entries.refetch()} /> : !items.length ? (
        <Card>
          <EmptyState
            icon={<MessageSquareText size={26} />}
            title={filter === 'all' && !board ? t('Отзывов пока нет', 'Әзірге пікір жоқ') : t('По этому фильтру пусто', 'Бұл сүзгі бойынша бос')}
            text={filter === 'all' && !board
              ? t('Как только клиент отсканирует карточку и отправит отзыв, он появится здесь.', 'Клиент карточканы сканерлеп, пікір жібергенде, ол осында пайда болады.')
              : t('Попробуйте другой фильтр или QR-код.', 'Басқа сүзгіні немесе QR-кодты таңдаңыз.')}
          />
        </Card>
      ) : (
        <div className="stack">
          {items.map(entry => (
            <article key={entry.id} className={`${s.entry} ${entry.isRead ? '' : s.entryNew}`}>
              <div className={s.entryHead}>
                <Stars value={entry.rating} />
                <span className={`${s.kind} ${KIND_LOOK[entry.kind].cls}`}>{t(KIND_LOOK[entry.kind].ru, KIND_LOOK[entry.kind].kz)}</span>
                <span className={s.meta}>{names.get(entry.boardId) ?? t('Удалённый QR', 'Жойылған QR')} · {when(entry.createdAt)}</span>
                {!entry.isRead && <Badge tone="accent">{t('Новый', 'Жаңа')}</Badge>}
              </div>
              {entry.comment
                ? <p className={s.comment}>{entry.comment}</p>
                : <p className={`${s.comment} ${s.noComment}`}>{t('Без комментария — только оценка', 'Пікірсіз — тек баға')}</p>}
              {entry.photos.length > 0 && (
                <div className={s.thumbs}>
                  {entry.photos.map((p, i) => (
                    <button key={p.id} type="button" className={s.thumb} onClick={() => setPhoto(p.url)} aria-label={t(`Открыть фото ${i + 1}`, `${i + 1}-фотоны ашу`)}>
                      <img src={p.url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              <div className={s.entryActions}>
                {!entry.isRead && (
                  <Button variant="secondary" size="sm" loading={read.isPending && Boolean(read.variables && 'id' in read.variables && read.variables.id === entry.id)}
                    onClick={() => read.mutate({ id: entry.id }, { onError: e => toast(e.message, 'error') })}>
                    {t('Прочитано', 'Оқылды')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setToDelete(entry)}>{t('Удалить', 'Жою')}</Button>
              </div>
            </article>
          ))}
          {entries.hasNextPage && (
            <Button variant="secondary" loading={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>{t('Показать ещё', 'Тағы көрсету')}</Button>
          )}
        </div>
      )}

      <Modal open={Boolean(photo)} onOpenChange={open => !open && setPhoto(null)} title={t('Фото клиента', 'Клиент фотосы')} size="lg">
        {photo && <img src={photo} alt={t('Фото из отзыва', 'Пікірдегі фото')} className={s.photoFull} />}
      </Modal>
      <Modal
        open={Boolean(toDelete)}
        onOpenChange={open => !open && setToDelete(null)}
        title={t('Удалить отзыв?', 'Пікірді жою керек пе?')}
        description={t('Отзыв и его фото удалятся без возможности восстановить.', 'Пікір мен оның фотолары қайтарусыз жойылады.')}
        footer={<>
          <Button variant="secondary" onClick={() => setToDelete(null)}>{t('Отмена', 'Болдырмау')}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete.id, {
            onSuccess: () => { setToDelete(null); toast(t('Отзыв удалён', 'Пікір жойылды'), 'success'); },
            onError: e => toast(e.message, 'error'),
          })}>{t('Удалить', 'Жою')}</Button>
        </>}
      >
        {null}
      </Modal>
    </div>
  );
}

// ───────────────────────── QR-коды ─────────────────────────

function QrCodes({ boards, limit }: { boards: FeedbackBoard[]; limit: number }) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const param = params.get('board');
  // Выбранный QR живёт в адресе: после обновления страницы или привязки Telegram владелец там же.
  const selected = param === 'new' || !boards.length ? null : boards.find(b => b.id === param) ?? boards[0];
  const isNew = param === 'new' || !boards.length;
  const select = (id: string) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', 'qr'); n.set('board', id); return n; }, { replace: true });
  const cabinet = useCabinet();
  const userId = cabinet.data?.profile.userId ?? 'anon';
  const pendingNew = readDraft(draftKey(userId, null));

  return (
    <div className="stack">
      <div className={s.boardList} role="list">
        {boards.map(b => (
          <button key={b.id} type="button" role="listitem" className={`${s.boardChip} ${!isNew && selected?.id === b.id ? s.boardChipOn : ''}`} onClick={() => select(b.id)}>
            <span className={`${s.dot} ${b.isActive ? s.dotOn : ''}`} aria-hidden="true" />
            <span className={s.boardChipName}>{boardTitle(b, t)}</span>
            {b.stats.unread > 0 && <span className={s.boardChipNew}>{b.stats.unread}</span>}
            {!b.isActive && <span className={s.boardChipMuted}>{t('пауза', 'кідіріс')}</span>}
          </button>
        ))}
        {boards.length < limit && (
          <button type="button" className={`${s.boardChip} ${s.boardChipAdd} ${isNew ? s.boardChipOn : ''}`} onClick={() => select('new')}>
            <Plus size={16} aria-hidden="true" />
            {pendingNew ? t('Новый QR · черновик', 'Жаңа QR · жоба') : t('Новый QR', 'Жаңа QR')}
          </button>
        )}
      </div>
      {cabinet.isPending ? <CabinetLoading /> : cabinet.isError ? <CabinetError error={cabinet.error} retry={() => cabinet.refetch()} /> : (
        <BoardEditor
          key={isNew ? 'new' : selected!.id}
          board={isNew ? null : selected!}
          userId={userId}
          telegramLinked={Boolean(cabinet.data.profile.telegram)}
          email={cabinet.data.profile.telegramOnly ? null : cabinet.data.profile.email}
          onCreated={id => select(id)}
          onDeleted={() => setParams(p => { const n = new URLSearchParams(p); n.delete('board'); return n; }, { replace: true })}
          limitReached={isNew && boards.length >= limit}
        />
      )}
    </div>
  );
}

function inputFrom(board: FeedbackBoard | null): FeedbackBoardInput {
  if (!board) {
    return { label: '', place: '', address: '', headline: DEFAULT_HEADLINE, note: DEFAULT_NOTE, design: { ...DEFAULT_DESIGN }, notifyTelegram: true, notifyEmail: true, isActive: true };
  }
  return {
    label: board.label, place: board.place, address: board.address, headline: board.headline, note: board.note,
    design: { ...board.design }, notifyTelegram: board.notifyTelegram, notifyEmail: board.notifyEmail, isActive: board.isActive,
  };
}

const PLACEHOLDER_URL = 'https://shk-wb.ru/o/XXXXXXXX';

function BoardEditor({ board, userId, telegramLinked, email, onCreated, onDeleted, limitReached }: {
  board: FeedbackBoard | null;
  userId: string;
  telegramLinked: boolean;
  email: string | null;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  limitReached: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const client = useQueryClient();
  const save = useSaveFeedbackBoard();
  const remove = useDeleteFeedbackBoard();
  const key = draftKey(userId, board?.id ?? null);
  const base = useMemo(() => inputFrom(board), [board]);
  // Черновик из этого браузера — если владелец закрыл вкладку, не сохранив правки.
  const [initial] = useState(() => {
    const draft = readDraft<FeedbackBoardInput>(key);
    return draft && !sameValue(draft.value, base) ? draft : null;
  });
  const [form, setForm] = useState<FeedbackBoardInput>(initial?.value ?? base);
  const [restoredAt, setRestoredAt] = useState<number | null>(initial?.savedAt ?? null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'print' | 'png' | 'save' | 'pause' | null>(null);
  const dirty = !sameValue(form, base);

  // Автосохранение черновика: каждое изменение формы — в localStorage (с паузой, чтобы не писать на каждую букву).
  const timer = useRef<number | undefined>(undefined);
  // QR уже создан, а список ещё не обновился — редактор «нового» живёт ещё миг; черновик больше не пишем,
  // иначе «Новый QR» потом откроется с текстом уже созданного.
  const created = useRef(false);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (created.current) return;
    timer.current = window.setTimeout(() => (dirty ? writeDraft(key, form) : clearDraft(key)), 300);
    return () => window.clearTimeout(timer.current);
  }, [dirty, form, key]);
  // Сохранить немедленно, если вкладку закрывают прямо сейчас (таймер мог не успеть), и предупредить браузером.
  useEffect(() => {
    if (!dirty || created.current) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      writeDraft(key, form);
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty, form, key]);

  const set = <K extends keyof FeedbackBoardInput>(field: K, value: FeedbackBoardInput[K]) => setForm(f => ({ ...f, [field]: value }));
  const setDesign = (patch: Partial<FeedbackBoardInput['design']>) => setForm(f => ({ ...f, design: { ...f.design, ...patch } }));
  const colorOk = form.design.theme !== 'custom' || colorReadable(form.design.color);
  const url = board?.url ?? PLACEHOLDER_URL;
  const text = { place: form.place, address: form.address, headline: form.headline, note: form.note };
  // text собирается из form на каждом рендере — зависимость form его покрывает.
  const preview = useMemo(() => cardSvg(text, form.design, url, { width: '100%', height: '100%' }), [form, url]);
  const format = FORMAT_OPTIONS.find(f => f.value === form.design.format) ?? FORMAT_OPTIONS[0];

  function submit() {
    if (!colorOk) return;
    setBusy('save');
    save.mutate({ id: board?.id ?? null, input: form }, {
      onSettled: () => setBusy(null),
      onSuccess: saved => {
        if (!board) created.current = true;
        window.clearTimeout(timer.current);
        clearDraft(key);
        setRestoredAt(null);
        toast(board ? t('Изменения сохранены', 'Өзгерістер сақталды') : t('QR-код создан — можно печатать', 'QR-код жасалды — басып шығаруға болады'), 'success');
        if (!board) onCreated(saved.id);
      },
      onError: e => toast(e.message, 'error'),
    });
  }

  function discard() {
    clearDraft(key);
    setForm(base);
    setRestoredAt(null);
  }

  function toggleActive() {
    if (!board) return;
    // Пауза — сразу и только по сохранённой версии: черновик формы не трогаем.
    setBusy('pause');
    save.mutate({ id: board.id, input: { ...inputFrom(board), isActive: !board.isActive } }, {
      onSettled: () => setBusy(null),
      onSuccess: () => {
        setForm(f => ({ ...f, isActive: !board.isActive }));
        toast(board.isActive ? t('Приём отзывов приостановлен', 'Пікір қабылдау тоқтатылды') : t('Приём отзывов включён', 'Пікір қабылдау қосылды'), 'success');
      },
      onError: e => toast(e.message, 'error'),
    });
  }

  async function print() {
    if (!board) return;
    setBusy('print');
    try {
      await printCard(text, form.design, board.url);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('Не удалось открыть печать', 'Басып шығаруды ашу мүмкін болмады'), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function png() {
    if (!board) return;
    setBusy('png');
    try {
      const blob = await cardPng(text, form.design, board.url);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `qr-otzyvy-${board.slug.toLowerCase()}-${form.design.format}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('Не удалось сохранить PNG', 'PNG сақтау мүмкін болмады'), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!board) return;
    try {
      await navigator.clipboard.writeText(board.url);
      toast(t('Ссылка скопирована', 'Сілтеме көшірілді'), 'success');
    } catch {
      toast(board.url);
    }
  }

  const onLinked = useCallback(() => {
    setLinkOpen(false);
    client.invalidateQueries({ queryKey: cabinetKey });
    toast(t('Telegram привязан — отзывы будут приходить в бот', 'Telegram байланды — пікірлер ботқа келеді'), 'success');
  }, [client, t, toast]);
  const onLinkError = useCallback((message: string) => toast(message, 'error'), [toast]);

  if (limitReached) {
    return <Alert tone="warning">{t('Можно создать до 10 QR-кодов. Удалите ненужный, чтобы добавить новый.', '10 QR-кодқа дейін жасауға болады. Жаңасын қосу үшін керексізін жойыңыз.')}</Alert>;
  }

  return (
    <div className={s.editor}>
      <Card className={s.form}>
        {restoredAt && (
          <Alert tone="info">
            <div className={s.restored}>
              <span>{t(`Восстановили несохранённые изменения от ${new Date(restoredAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`, `${new Date(restoredAt).toLocaleString('ru-RU')} сақталмаған өзгерістер қалпына келтірілді.`)}</span>
              <button type="button" className="link-btn" onClick={discard}>{board ? t('Вернуть сохранённую версию', 'Сақталған нұсқаны қайтару') : t('Начать заново', 'Басынан бастау')}</button>
            </div>
          </Alert>
        )}

        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('Пункт', 'Пункт')}</h2>
          <Field label={t('Название QR в кабинете', 'Кабинеттегі QR атауы')} help={t('Только для вас: «Дверь», «Стол выдачи», «Второй пункт»', 'Тек сіз үшін: «Есік», «Беру үстелі», «Екінші пункт»')}>
            <Input value={form.label} maxLength={60} placeholder={t('Например, Стол выдачи', 'Мысалы, Беру үстелі')} onChange={e => set('label', e.target.value)} />
          </Field>
          <Field label={t('Название на карточке', 'Карточкадағы атау')}>
            <Input value={form.place} maxLength={80} placeholder="ПВЗ Wildberries" onChange={e => set('place', e.target.value)} />
          </Field>
          <Field label={t('Адрес', 'Мекенжай')}>
            <Input value={form.address} maxLength={120} placeholder={t('ул. Ленина, 24', 'Ленин к-сі, 24')} onChange={e => set('address', e.target.value)} />
          </Field>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('Текст карточки', 'Карточка мәтіні')}</h2>
          <Field label={t('Заголовок', 'Тақырып')}>
            <Input value={form.headline} maxLength={60} placeholder={DEFAULT_HEADLINE} onChange={e => set('headline', e.target.value)} />
          </Field>
          <Field label={t('Подпись', 'Жазба')} help={t('Подойдёт и «Поблагодарите менеджера», и «Что нам улучшить?»', '«Менеджерге алғыс айтыңыз» немесе «Нені жақсартайық?» сияқты')}>
            <Textarea value={form.note} maxLength={140} rows={2} onChange={e => set('note', e.target.value)} />
          </Field>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('Формат', 'Формат')}</h2>
          <div className={s.formats} role="radiogroup" aria-label={t('Формат карточки', 'Карточка форматы')}>
            {FORMAT_OPTIONS.map(f => (
              <button key={f.value} type="button" role="radio" aria-checked={form.design.format === f.value}
                className={`${s.format} ${form.design.format === f.value ? s.formatOn : ''}`} onClick={() => setDesign({ format: f.value as FeedbackFormat })}>
                <b>{f.label}</b>
                <span>{f.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('Цвет', 'Түс')}</h2>
          <div className={s.swatches} role="radiogroup" aria-label={t('Цветовая тема', 'Түс тақырыбы')}>
            {THEME_OPTIONS.map(o => {
              const p = palette({ ...form.design, theme: o.value });
              return (
                <button key={o.value} type="button" role="radio" aria-checked={form.design.theme === o.value} aria-label={o.label} title={o.label}
                  className={`${s.swatch} ${form.design.theme === o.value ? s.swatchOn : ''} ${o.value === 'light' ? s.swatchLight : ''}`}
                  style={{ background: `linear-gradient(135deg, ${p.bg[0]}, ${p.bg[1]})` }}
                  onClick={() => setDesign({ theme: o.value })} />
              );
            })}
            <label className={`${s.custom} ${form.design.theme === 'custom' ? s.customOn : ''}`}>
              <input type="color" value={form.design.color} onChange={e => setDesign({ theme: 'custom', color: e.target.value })} aria-label={t('Свой цвет', 'Өз түсіңіз')} />
              {t('Свой цвет', 'Өз түсіңіз')}
            </label>
          </div>
          {!colorOk && (
            <Alert tone="error">{t('Цвет слишком светлый — телефон может не считать QR-код. Выберите цвет темнее.', 'Түс тым ашық — телефон QR-кодты оқымауы мүмкін. Қоюырақ түс таңдаңыз.')}</Alert>
          )}
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('Куда присылать отзывы', 'Пікірлерді қайда жіберу')}</h2>
          <div className={s.channel}>
            <Switch checked={form.notifyTelegram} onChange={e => set('notifyTelegram', e.target.checked)}
              description={telegramLinked ? t('В наш бот, вместе с фото', 'Біздің ботқа, фотомен бірге') : t('Telegram не привязан к кабинету', 'Telegram кабинетке байланбаған')}>
              Telegram
            </Switch>
            {form.notifyTelegram && !telegramLinked && (
              <div className={s.linkPrompt}>
                <Send size={18} aria-hidden="true" />
                <div>
                  <b>{t('Привяжите Telegram, чтобы получать отзывы сразу', 'Пікірлерді бірден алу үшін Telegram байлаңыз')}</b>
                  <p>{t('Это займёт полминуты. Вы останетесь на этой странице, всё, что вы ввели, сохранится.', 'Бұл жарты минут алады. Осы бетте қаласыз, енгізгеніңіздің бәрі сақталады.')}</p>
                  <Button size="sm" onClick={() => { writeDraft(key, form); setLinkOpen(true); }}><Link2 size={16} />{t('Привязать Telegram', 'Telegram байлау')}</Button>
                </div>
              </div>
            )}
          </div>
          <div className={s.channel}>
            <Switch checked={form.notifyEmail} onChange={e => set('notifyEmail', e.target.checked)}
              description={email ? email : t('Почта не указана — добавьте её в профиле', 'Пошта көрсетілмеген — профильде қосыңыз')}>
              {t('Почта', 'Пошта')}
            </Switch>
            {form.notifyEmail && !email && <Link className={s.inlineLink} to="/cabinet/profile">{t('Добавить почту в профиле', 'Профильге пошта қосу')}</Link>}
          </div>
          <p className={s.muted}>{t('В кабинете отзывы видны всегда.', 'Кабинетте пікірлер әрқашан көрінеді.')}</p>
        </section>

        <div className={s.saveRow}>
          <Button onClick={submit} loading={busy === 'save'} disabled={!colorOk || (!dirty && Boolean(board)) || busy === 'pause'}>
            {board ? t('Сохранить изменения', 'Өзгерістерді сақтау') : t('Создать QR-код', 'QR-код жасау')}
          </Button>
          {dirty && board && <span className={s.muted}>{t('Есть несохранённые изменения — черновик хранится в этом браузере', 'Сақталмаған өзгерістер бар — жоба осы браузерде сақталады')}</span>}
          {!board && <span className={s.muted}>{t('Черновик сохраняется сам, даже если закрыть вкладку', 'Жоба өзі сақталады, бетті жапсаңыз да')}</span>}
        </div>

        {board && (
          <div className={s.dangerRow}>
            <Button variant="secondary" size="sm" onClick={toggleActive} loading={busy === 'pause'} disabled={busy === 'save'}>
              {board.isActive ? <><Pause size={16} />{t('Приостановить приём', 'Қабылдауды тоқтату')}</> : <><Play size={16} />{t('Возобновить приём', 'Қабылдауды жалғастыру')}</>}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}><Trash2 size={16} />{t('Удалить QR', 'QR жою')}</Button>
          </div>
        )}
      </Card>

      <section className={s.previewCol} aria-label={t('Превью карточки', 'Карточка алдын ала көрінісі')}>
        <div className={s.previewStage}>
          <div className={`${s.previewCard} ${s[`fmt_${form.design.format}`]}`} dangerouslySetInnerHTML={{ __html: preview }} />
          {!board && <div className={s.previewBadge}>{t('Пример — настоящий QR появится после создания', 'Үлгі — нақты QR жасалғаннан кейін пайда болады')}</div>}
          {board && !board.isActive && <div className={s.previewBadge}>{t('Приём отзывов на паузе — клиент увидит сообщение об этом', 'Пікір қабылдау тоқтатылған — клиент бұл туралы хабарды көреді')}</div>}
        </div>
        <div className={s.previewActions}>
          <Button onClick={print} disabled={!board || !colorOk} loading={busy === 'print'}><Printer size={18} />{t('Печать', 'Басып шығару')}</Button>
          <Button variant="secondary" onClick={png} disabled={!board || !colorOk} loading={busy === 'png'}><Download size={18} />PNG</Button>
          <Button variant="secondary" onClick={copy} disabled={!board}><Copy size={18} />{t('Ссылка', 'Сілтеме')}</Button>
        </div>
        <p className={s.muted}>
          {format.sheet}. {board
            ? <>{t('Ссылка: ', 'Сілтеме: ')}<span className="mono">{board.url.replace(/^https:\/\//, '')}</span>. {t('QR не меняется при смене цвета и текста — перепечатывать старые карточки не нужно.', 'Түс пен мәтін өзгергенде QR өзгермейді — ескі карточкаларды қайта басудың қажеті жоқ.')}</>
            : t('Сначала создайте QR — после этого его можно распечатать и скачать.', 'Алдымен QR жасаңыз — содан кейін басып шығаруға және жүктеуге болады.')}
        </p>
        {board && dirty && <Alert tone="warning">{t('Печать и PNG берут текст и цвет из формы — не забудьте сохранить изменения.', 'Басып шығару мен PNG мәтін мен түсті формадан алады — өзгерістерді сақтауды ұмытпаңыз.')}</Alert>}
      </section>

      <Modal open={linkOpen} onOpenChange={setLinkOpen} title={t('Привязать Telegram', 'Telegram байлау')}
        description={t('Нажмите кнопку и подтвердите вход в Telegram. После этого окно закроется, а вы останетесь в конструкторе — с тем же текстом и цветом.', 'Түймені басып, Telegram-да растаңыз. Содан кейін терезе жабылады, ал сіз сол мәтін мен түспен конструкторда қаласыз.')}>
        <div className={s.linkModal}>
          {linkOpen && <TelegramLogin mode="link" closeMiniApp={false} navigateAfterLogin={false} onSuccess={onLinked} onError={onLinkError} />}
          <p className={s.muted}>{t('Не открывается? Привяжите Telegram в разделе «Профиль» — черновик QR дождётся вас здесь.', 'Ашылмай ма? Telegram-ды «Профиль» бөлімінде байлаңыз — QR жобасы сізді осында күтеді.')} <Link to="/cabinet/profile">{t('Открыть профиль', 'Профильді ашу')}</Link></p>
        </div>
      </Modal>
      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('Удалить QR-код?', 'QR-кодты жою керек пе?')}
        description={t('Напечатанные карточки перестанут работать, а все отзывы по этому QR и их фото удалятся.', 'Басылған карточкалар жұмыс істемейді, ал осы QR бойынша барлық пікірлер мен фотолар жойылады.')}
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmDelete(false)}>{t('Отмена', 'Болдырмау')}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => board && remove.mutate(board.id, {
            onSuccess: () => { clearDraft(key); setConfirmDelete(false); toast(t('QR-код удалён', 'QR-код жойылды'), 'success'); onDeleted(); },
            onError: e => toast(e.message, 'error'),
          })}>{t('Удалить', 'Жою')}</Button>
        </>}
      >
        {null}
      </Modal>
    </div>
  );
}
