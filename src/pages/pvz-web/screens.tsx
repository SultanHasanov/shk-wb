import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Camera, X } from 'lucide-react';
import { Alert, Button, EmptyState, Modal, Spinner } from '../../ui';
import { type T, useT } from '../../i18n';
import { ApiError } from '../../api/client';
import { wbImageUrls } from '../../lib/wb-image';
import {
  type ClientMatch,
  type ClientQr,
  type MatchReason,
  type PvzCell,
  type PvzGoods,
  issueClientQr,
  isWbLoginRequired,
  searchClients,
  searchClientsByPhoto,
  useChargePreview,
} from '../../api/pvz-web';
import s from './PvzWebApp.module.css';

/** Кому показываем QR: клиент и, если известна, его ячейка. */
export type QrTarget = { sid: string; cell: string; name: string };

const LONG_DAYS = 7;

function daysText(t: T, days: number) {
  const mod10 = days % 10, mod100 = days % 100;
  const ru = mod10 === 1 && mod100 !== 11 ? 'день' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
  return t(`${days} ${ru}`, `${days} күн`);
}

function goodsText(t: T, count: number) {
  const mod10 = count % 10, mod100 = count % 100;
  const ru = mod10 === 1 && mod100 !== 11 ? 'товар' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'товара' : 'товаров';
  return t(`${count} ${ru}`, `${count} тауар`);
}

function DaysBadge({ days }: { days: number | null }) {
  const t = useT();
  if (days == null) return null;
  return <span className={`${s.days} ${days > LONG_DAYS ? s.daysLong : ''}`}>{daysText(t, days)}</span>;
}

/** Фото товара с серверов WB. Не открылось на расчётном сервере — пробуем соседние, потом оставляем пустую рамку. */
function GoodThumb({ nm, small = false }: { nm: number | null; small?: boolean }) {
  const urls = useMemo(() => (nm ? wbImageUrls(nm) : []), [nm]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [nm]);
  return (
    <span className={`${s.thumb} ${small ? s.thumbSmall : ''}`} aria-hidden="true">
      {attempt < urls.length && <img src={urls[attempt]} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setAttempt(attempt + 1)} />}
    </span>
  );
}

/** «Бренд · размер · цвет» — что есть. */
function goodDetails(g: { brand: string; size: string; color: string }) {
  return [g.brand, g.size, g.color].filter(Boolean).join(' · ');
}

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

// ---------- Ячейки ----------

export function CellsScreen({ data, onQr }: { data: PvzGoods; onQr: (target: QrTarget) => void }) {
  const t = useT();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const keyOf = (c: PvzCell) => `${c.cell}|${c.sid}`;
  const selected = data.cells.find(c => keyOf(c) === selectedKey) ?? null;
  const stats = useMemo(() => ({
    cells: new Set(data.cells.map(c => c.cell)).size,
    clients: new Set(data.cells.map(c => c.sid)).size,
    long: data.cells.filter(c => (c.days ?? 0) > LONG_DAYS).length,
  }), [data.cells]);

  if (!data.cells.length) {
    return <EmptyState title={t('В пункте сейчас нет товаров', 'Пунктте қазір тауар жоқ')} text={t('WB не вернул ни одного товара в ячейках. Если это не так — нажмите «Обновить».', 'WB ұяшықтарда бірде-бір тауар қайтармады. Олай болмаса — «Жаңарту» түймесін басыңыз.')} />;
  }

  return (
    <>
      <div className={s.titleRow}><h1 className={s.h1}>{t('Ячейки', 'Ұяшықтар')}</h1></div>
      <div className={s.stats}>
        <div className={s.stat}><div className={s.statLabel}>{t('Занято ячеек', 'Бос емес ұяшықтар')}</div><div className={s.statValue}>{stats.cells}</div></div>
        <div className={s.stat}><div className={s.statLabel}>{t('Клиентов', 'Клиенттер')}</div><div className={s.statValue}>{stats.clients}</div></div>
        <div className={s.stat}><div className={s.statLabel}>{t('Товаров в пункте', 'Пункттегі тауарлар')}</div><div className={s.statValue}>{data.goodsCount}</div></div>
        <div className={s.stat}><div className={s.statLabel}>{t('Лежат дольше 7 дней', '7 күннен артық жатыр')}</div><div className={s.statValue}>{stats.long}</div></div>
      </div>
      <div className={s.split}>
        <div className={s.cellGrid}>
          {data.cells.map(c => (
            <button key={keyOf(c)} type="button" className={`${s.cellCard} ${selected && keyOf(c) === keyOf(selected) ? s.cellCardActive : ''}`} onClick={() => setSelectedKey(keyOf(c))}>
              <span className={s.cellTop}>
                <span className={s.cellNum}>{c.cell}</span>
                <DaysBadge days={c.days} />
              </span>
              <span className={s.cellBody}>
                <span className={s.cellName}>{c.name || (c.tail ? `${t('Тел.', 'Тел.')} …${c.tail}` : t('Клиент', 'Клиент'))}</span>
                <span className={s.cellMeta}>{goodsText(t, c.goods.length)}{c.name && c.tail ? ` · ${t('тел.', 'тел.')} …${c.tail}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
        {selected && <button type="button" className={s.scrim} aria-label={t('Закрыть', 'Жабу')} onClick={() => setSelectedKey(null)} />}
        <aside className={`${s.panel} ${s.panelSticky} ${selected ? s.panelSheet : s.panelEmpty}`} aria-label={t('Карточка ячейки', 'Ұяшық карточкасы')}>
          {!selected ? (
            <p className={s.muted}>{t('Выберите ячейку — здесь появятся клиент и его товары.', 'Ұяшықты таңдаңыз — мұнда клиент пен оның тауарлары көрсетіледі.')}</p>
          ) : (
            <>
              <div className={s.panelHead}>
                <h2 className={s.h2}>{t('Ячейка', 'Ұяшық')} {selected.cell}</h2>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <DaysBadge days={selected.days} />
                  <Button variant="ghost" size="sm" className={s.panelClose} aria-label={t('Закрыть', 'Жабу')} onClick={() => setSelectedKey(null)}><X size={18} /></Button>
                </span>
              </div>
              <dl className={s.facts}>
                {selected.name && <><dt>{t('Клиент', 'Клиент')}</dt><dd><strong>{selected.name}</strong></dd></>}
                <dt>{t('Телефон', 'Телефон')}</dt><dd>{selected.tail ? `+7 ••• •••-${selected.tail}` : '—'}</dd>
                <dt>{t('ID клиента', 'Клиент ID')}</dt><dd className={s.mono}>{selected.sid}</dd>
              </dl>
              <div className={s.goodList}>
                <div className={s.sectionLabel}>{t('Товары в ячейке', 'Ұяшықтағы тауарлар')}</div>
                {selected.goods.map((g, i) => (
                  <div key={`${g.shk}-${i}`} className={s.good}>
                    <GoodThumb nm={g.nm} />
                    <div className={s.goodBody}>
                      <div className={s.goodTitle}>{g.title || t('Товар', 'Тауар')}</div>
                      {goodDetails(g) && <div className={s.goodMeta}>{goodDetails(g)}</div>}
                      <div className={s.goodMeta}>
                        {[g.shk && `${t('ШК', 'ШК')} ${g.shk}`, g.nm && `${t('арт.', 'арт.')} ${g.nm}`].filter(Boolean).join(' · ')}
                      </div>
                      {g.price != null && <div className={s.goodPrice}>{g.price.toLocaleString('ru-RU')} ₽</div>}
                    </div>
                  </div>
                ))}
              </div>
              <Button block onClick={() => onQr({ sid: selected.sid, cell: selected.cell, name: selected.name })}>{t('QR-код клиента', 'Клиенттің QR-коды')}</Button>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

// ---------- Все товары ----------

const PAGE = 200;

export function GoodsScreen({ data }: { data: PvzGoods }) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => data.cells.flatMap(c => c.goods.map(g => ({ ...g, cell: c.cell, client: c.name, tail: c.tail }))), [data.cells]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => (needle
    ? rows.filter(r => r.cell.toLowerCase() === needle || r.shk.includes(needle) || r.title.toLowerCase().includes(needle) || r.brand.toLowerCase().includes(needle) || String(r.nm ?? '') === needle || r.client.toLowerCase().includes(needle))
    : rows), [rows, needle]);
  useEffect(() => setLimit(PAGE), [needle]);

  return (
    <>
      <div className={s.titleRow}>
        <h1 className={s.h1}>{t('Все товары', 'Барлық тауарлар')}</h1>
        <span className={s.muted}>{goodsText(t, rows.length)} {t('в пункте', 'пунктте')}</span>
      </div>
      <input className={s.filterInput} value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('Ячейка, ШК, артикул, название или бренд', 'Ұяшық, ШК, артикул, атауы немесе бренд')} aria-label={t('Фильтр товаров', 'Тауарлар сүзгісі')} />
      {!shown.length ? (
        <EmptyState title={t('Ничего не нашли', 'Ештеңе табылмады')} text={needle ? t('Попробуйте другой запрос.', 'Басқа сұраныс жасап көріңіз.') : t('WB не вернул ни одного товара в ячейках.', 'WB ұяшықтарда бірде-бір тауар қайтармады.')} />
      ) : (
        <div className={s.table}>
          <div className={s.rowHead}>
            <span>{t('Ячейка', 'Ұяшық')}</span><span /><span>{t('Товар', 'Тауар')}</span><span>{t('Цена', 'Бағасы')}</span>
            <span>{t('ШК', 'ШК')}</span><span>{t('Клиент', 'Клиент')}</span><span>{t('В пункте', 'Пунктте')}</span>
          </div>
          {shown.slice(0, limit).map((r, i) => (
            <div key={`${r.cell}-${r.shk}-${i}`} className={s.row}>
              <span className={s.rowCell}>{r.cell}</span>
              <span className={s.rowThumb}><GoodThumb nm={r.nm} small /></span>
              <span className={s.rowTitle}>{r.title || t('Товар', 'Тауар')}{goodDetails(r) && <span className={s.rowSub}>{goodDetails(r)}</span>}</span>
              <span className={s.rowBrand}>{r.price != null ? `${r.price.toLocaleString('ru-RU')} ₽` : ''}</span>
              <span className={`${s.rowShk} ${s.mono}`}>{r.shk}</span>
              <span className={s.rowClient}>{[r.client, r.tail && `…${r.tail}`].filter(Boolean).join(' ')}</span>
              <span className={s.rowDays}><DaysBadge days={r.days} /></span>
            </div>
          ))}
        </div>
      )}
      {shown.length > limit && <Button variant="secondary" className={s.more} onClick={() => setLimit(limit + PAGE)}>{t('Показать ещё', 'Тағы көрсету')}</Button>}
    </>
  );
}

// ---------- Код клиента ----------

/** Фото этикетки уменьшаем в браузере: серверу для чтения ШК хватает 1600 px, а оригинал с телефона — 5–10 МБ. */
async function photoToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function whyText(t: T, why: MatchReason[]) {
  const names: Record<MatchReason, string> = {
    cell: t('номер ячейки', 'ұяшық нөмірі'),
    sid: t('ID клиента', 'клиент ID'),
    shk: t('ШК товара', 'тауар ШК'),
    phone: t('телефон', 'телефон'),
  };
  return why.map(w => names[w]).join(', ');
}

type SearchResult = { matches: ClientMatch[]; note: string | null };

export function CodeScreen({ initialQuery, onQr, onWbLost }: { initialQuery: string; onQr: (target: QrTarget) => void; onWbLost: () => void }) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery);
  const fileRef = useRef<HTMLInputElement>(null);
  const failed = (error: unknown) => { if (isWbLoginRequired(error)) onWbLost(); };

  const textSearch = useMutation({
    mutationFn: async (q: string): Promise<SearchResult> => ({ matches: (await searchClients(q)).matches, note: null }),
    onError: failed,
  });
  const photoSearch = useMutation({
    mutationFn: async (file: File): Promise<SearchResult> => {
      const out = await searchClientsByPhoto(await photoToDataUrl(file));
      return {
        matches: out.matches,
        note: out.codes.length
          ? t(`На фото распознан ШК ${out.codes.join(', ')}`, `Фотодан ШК танылды: ${out.codes.join(', ')}`)
          : t('На фото не нашли ШК. Сфотографируйте этикетку ближе и ровнее или введите ШК цифрами.', 'Фотодан ШК табылмады. Затбелгіні жақынырақ және түзу түсіріңіз немесе ШК-ны сандармен енгізіңіз.'),
      };
    },
    onError: failed,
  });
  // показываем результат того поиска, который запускали последним
  const [last, setLast] = useState<'text' | 'photo'>('text');
  const active = last === 'text' ? textSearch : photoSearch;
  const digits = query.replace(/\D/g, '');

  const runText = textSearch.mutate;
  useEffect(() => {
    if (digits.length < 2) return undefined;
    const timer = window.setTimeout(() => { setLast('text'); runText(digits); }, 400);
    return () => window.clearTimeout(timer);
  }, [digits, runText]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!digits) return;
    setLast('text');
    textSearch.mutate(digits);
  };
  const onFile = (file: File | undefined) => {
    if (!file) return;
    setQuery('');
    setLast('photo');
    photoSearch.mutate(file);
  };
  const idle = last === 'text' && digits.length < 2;

  return (
    <>
      <div className={s.titleRow}><h1 className={s.h1}>{t('Код клиента', 'Клиент коды')}</h1></div>
      <div className={s.codeColumn}>
        <form className={s.searchRow} onSubmit={submit}>
          <input
            className={s.searchInput} inputMode="numeric" autoFocus value={query} onChange={e => setQuery(e.target.value)}
            placeholder={t('Ячейка, конец телефона, ШК или ID клиента', 'Ұяшық, телефонның соңы, ШК немесе клиент ID')}
            aria-label={t('Ячейка, телефон, ШК или ID клиента', 'Ұяшық, телефон, ШК немесе клиент ID')}
          />
          <label className={s.photoButton} aria-disabled={photoSearch.isPending}>
            {photoSearch.isPending ? <Spinner size={18} /> : <Camera size={18} aria-hidden="true" />}
            {t('Фото этикетки', 'Затбелгі фотосы')}
            <input ref={fileRef} className={s.hiddenInput} type="file" accept="image/*" capture="environment" disabled={photoSearch.isPending}
              onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </form>

        {idle ? (
          <div className={s.hintBox}>
            {t('Введите номер ячейки, последние цифры телефона (от трёх), ШК товара или ID клиента. Или сфотографируйте этикетку — ШК распознаётся сам.',
              'Ұяшық нөмірін, телефонның соңғы сандарын (үштен бастап), тауар ШК-сын немесе клиент ID-ін енгізіңіз. Не затбелгіні суретке түсіріңіз — ШК өзі танылады.')}
          </div>
        ) : active.isPending ? (
          <div className={s.hintBox} role="status">{last === 'photo' ? t('Читаем ШК с фото…', 'Фотодан ШК оқып жатырмыз…') : t('Ищем клиента…', 'Клиентті іздеп жатырмыз…')}</div>
        ) : active.isError ? (
          <Alert tone="error">{errorText(active.error, t('Не удалось выполнить поиск', 'Іздеу орындалмады'))}</Alert>
        ) : active.data ? (
          <>
            {active.data.note && <Alert tone={active.data.matches.length ? 'success' : 'info'}>{active.data.note}</Alert>}
            {!active.data.matches.length && !(last === 'photo' && active.data.note) && (
              <EmptyState title={t('Никого не нашли', 'Ешкім табылмады')} text={t('В пункте нет клиента с таким номером. Проверьте цифры или обновите данные WB.', 'Пунктте мұндай нөмірлі клиент жоқ. Сандарды тексеріңіз немесе WB деректерін жаңартыңыз.')} />
            )}
            {active.data.matches.map(m => (
              <div key={m.sid} className={s.match}>
                <div className={s.matchCell}>{m.cells.join(', ') || '—'}</div>
                <div className={s.matchBody}>
                  <div><strong>{m.name || (m.tail ? `${t('Тел.', 'Тел.')} …${m.tail}` : t('Клиент', 'Клиент'))}</strong><span className={s.why}>{t('совпал', 'сәйкес келді')}: {whyText(t, m.why)}</span></div>
                  <div className={s.cellMeta}>{m.tail ? `+7 ••• •••-${m.tail} · ` : ''}ID {m.sid}</div>
                </div>
                <Button variant="secondary" onClick={() => onQr({ sid: m.sid, cell: m.cells.length === 1 ? m.cells[0] : '', name: m.name })}>{t('Показать QR', 'QR көрсету')}</Button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

// ---------- QR клиента ----------

export function QrDialog({ target, onClose }: { target: QrTarget | null; onClose: () => void }) {
  const t = useT();
  const open = target !== null;
  const preview = useChargePreview(open);
  const issue = useMutation<ClientQr, unknown, QrTarget>({ mutationFn: tg => issueClientQr({ sid: tg.sid, cell: tg.cell || undefined }) });
  const reset = issue.reset;
  useEffect(() => { reset(); }, [target?.sid, reset]);

  if (!target) return null;
  const error = issue.error;
  const walletShort = error instanceof ApiError && error.code === 'WALLET_SHORT';
  const title = [target.name || t('Клиент', 'Клиент'), target.cell && `${t('ячейка', 'ұяшық')} ${target.cell}`].filter(Boolean).join(' · ');

  return (
    <Modal open={open} onOpenChange={v => { if (!v) onClose(); }} title={title} description={`${t('ID клиента', 'Клиент ID')} ${target.sid}`} sheet>
      <div className={s.qr}>
        {issue.data ? (
          <>
            <img className={s.qrImage} src={issue.data.image} alt={t('QR-код клиента', 'Клиенттің QR-коды')} />
            <div className={s.muted}>{issue.data.spent}</div>
            <div className={s.cellMeta}>{t('Код действует сегодня. Повторный показ этого клиента сегодня — без списания.', 'Код бүгін жарамды. Осы клиентті бүгін қайта көрсету — есептен шығарусыз.')}</div>
          </>
        ) : (
          <>
            <div className={s.qrPlaceholder}>{t('QR появится после нажатия кнопки', 'QR түймені басқаннан кейін пайда болады')}</div>
            {preview.isPending ? <div className={s.muted} role="status">{t('Проверяем, что спишется…', 'Не есептен шығатынын тексеріп жатырмыз…')}</div>
              : preview.data ? <div className={s.muted}>{preview.data.line}</div>
              : <div className={s.muted}>{t('Спишется 1 код из тарифа или пакета, если они есть.', 'Тарифтен немесе пакеттен 1 код есептен шығады, егер олар бар болса.')}</div>}
            {error != null && (
              <Alert tone="error">
                {errorText(error, t('Не удалось выдать код', 'Код берілмеді'))}
                {walletShort && <> <Link to="/cabinet/packages">{t('Пополнить баланс', 'Балансты толтыру')}</Link></>}
              </Alert>
            )}
            <Button block loading={issue.isPending} onClick={() => issue.mutate(target)}>{t('Показать QR-код', 'QR-кодты көрсету')}</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
