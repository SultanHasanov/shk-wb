import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileClock, Printer, QrCode } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Segmented,
  Table,
  Tabs,
} from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, useCabinet, useCabinetMutation, useHistory } from '../../api/cabinet';
import { apiBlob } from '../../api/client';
import type { GenerationEntry } from '../../api/cabinet';
import { useDocumentMeta } from '../../lib/seo';
import { useT } from '../../i18n';
import s from './HistoryPage.module.css';

type Filter = 'all' | 'product' | 'box';

/** Номера пачки: у массовой генерации это список, у одиночной — единственный код. */
function entryCodes(entry: GenerationEntry): string[] {
  if (entry.codes?.length) return entry.codes;
  return entry.code ? [entry.code] : [];
}

/**
 * Печать уже созданной пачки. Пачку в 200 штук печатают частями, поэтому
 * здесь же видно, что уже выведено на бумагу, и можно допечатать остаток.
 */
function PrintDialog({ entry, onClose }: { entry: GenerationEntry; onClose: () => void }) {
  const t = useT();
  const [columns, setColumns] = useState(4);
  const [onlyUnprinted, setOnlyUnprinted] = useState(true);
  const [count, setCount] = useState<number | ''>('');
  const [fileError, setFileError] = useState('');
  const [filePending, setFilePending] = useState(false);
  const mark = useCabinetMutation<{ entryId: string; codes: string[] }, { printedCodes: string[] }>(
    '/api/cabinet/history',
    'PATCH',
  );

  const codes = entryCodes(entry);
  const printed = new Set(entry.printedCodes ?? []);
  const pool = onlyUnprinted ? codes.filter(code => !printed.has(code)) : codes;
  const limit = Number(count);
  const chosen = limit > 0 ? pool.slice(0, limit) : pool;

  const url = (inline: boolean) => {
    // Одиночная запись сохраняет компактный физический размер сетки «5 в ряд».
    const params = new URLSearchParams({ columns: String(entry.mode === 'custom' ? 5 : columns) });
    if (entry.batchId) params.set('batch', entry.batchId);
    else params.set('history', entry.id);
    if (entry.category === 'box') {
      params.set('variant', 'box');
      params.set('prefix', entry.prefix || 'TRBX');
    }
    if (chosen.length && chosen.length < codes.length) params.set('codes', chosen.join(','));
    if (inline) params.set('inline', '1');
    return `/api/stickers/pdf?${params.toString()}`;
  };

  // Файл открывается в соседней вкладке, поэтому отметку ставим по факту клика.
  const remember = () => {
    if (chosen.length) mark.mutate({ entryId: entry.id, codes: chosen });
  };

  const openHistoryPdf = async (inline: boolean) => {
    setFileError('');
    setFilePending(true);
    const printWindow = inline ? window.open('about:blank', '_blank') : null;
    try {
      const blob = await apiBlob(url(inline));
      const objectUrl = URL.createObjectURL(blob);
      if (inline && printWindow) printWindow.location.href = objectUrl;
      else {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `stickers-history-${entry.id}.pdf`;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      remember();
    } catch (error) {
      printWindow?.close();
      setFileError(error instanceof Error ? error.message : t('Не удалось подготовить PDF', 'PDF дайындау мүмкін болмады'));
    } finally {
      setFilePending(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={t('Печать пачки', 'Буманы басып шығару')}
      description={t('Выберите раскладку листа и сколько стикеров вывести.', 'Парақ орналасуын және қанша стикер шығаруды таңдаңыз.')}
    >
      <div className="stack">
        <div className="row">
          <span className="muted">{t(`В пачке ${codes.length}`, `Бумада ${codes.length}`)}</span>
          <span className="muted">{t(`Напечатано ${printed.size}`, `Басылды ${printed.size}`)}</span>
          <strong>{t(`К печати сейчас: ${chosen.length}`, `Қазір басуға: ${chosen.length}`)}</strong>
        </div>

        {entry.mode === 'range' && (
          <>
            <Segmented
              label={t('Количество колонок на листе', 'Парақтағы бағандар саны')}
              value={String(columns)}
              onChange={value => setColumns(Number(value))}
              options={[
                { value: '1', label: '1' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '4', label: '4' },
                { value: '5', label: '5' },
              ]}
            />
            <p className="muted">
              {t('Выберите, сколько QR-кодов или стикеров должно помещаться в одной строке листа A4.', 'A4 парағының бір жолына қанша QR-код немесе стикер сыю керектігін таңдаңыз.')}
            </p>
          </>
        )}

        <Checkbox
          checked={onlyUnprinted}
          onChange={e => setOnlyUnprinted(e.target.checked)}
          id="history-only-unprinted"
        >
          {t('Только те, что ещё не печатались', 'Тек әлі басылмағандары')}
        </Checkbox>

        <Field label={t('Сколько напечатать', 'Қанша басып шығару')} help={t(`Доступно ${pool.length}. Пусто — все.`, `Қолжетімді ${pool.length}. Бос болса — барлығы.`)}>
          <Input
            type="number"
            min={1}
            max={pool.length}
            placeholder={t(`Все ${pool.length}`, `Барлығы ${pool.length}`)}
            value={count}
            onChange={e => setCount(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </Field>

        {!chosen.length && (
          <Alert tone="info">
            {t('Вся пачка уже напечатана. Снимите галочку, чтобы напечатать повторно.', 'Бүкіл бума басылып қойған. Қайта басу үшін белгіні алып тастаңыз.')}
          </Alert>
        )}

        {Boolean(chosen.length) && (
          <div className="row">
            {entry.batchId ? <a href={url(false)} download onClick={remember}>
              <Button>
                <Download size={18} />
                {t('Скачать PDF', 'PDF жүктеп алу')}
              </Button>
            </a> : <Button disabled={filePending} onClick={() => openHistoryPdf(false)}><Download size={18} />{t('Скачать PDF', 'PDF жүктеп алу')}</Button>}
            {entry.batchId ? <a href={url(true)} target="_blank" rel="noopener noreferrer" onClick={remember}>
              <Button variant="secondary">
                <Printer size={18} />
                {t('Печать', 'Басып шығару')}
              </Button>
            </a> : <Button variant="secondary" disabled={filePending} onClick={() => openHistoryPdf(true)}><Printer size={18} />{t('Печать', 'Басып шығару')}</Button>}
          </div>
        )}

        {fileError && <Alert tone="error">{fileError}</Alert>}
        {mark.isError && <Alert tone="error">{mark.error.message}</Alert>}
      </div>
    </Modal>
  );
}

function PreviewDialog({ entry, onClose }: { entry: GenerationEntry; onClose: () => void }) {
  const t = useT();
  const codes = entryCodes(entry);
  const [visible, setVisible] = useState(Math.min(4, codes.length));
  const imageUrl = (code: string) => {
    const params = new URLSearchParams({ code });
    if (entry.batchId) params.set('batch', entry.batchId);
    else params.set('history', entry.id);
    if (entry.category === 'box') {
      params.set('variant', 'box');
      params.set('prefix', entry.prefix || 'TRBX');
    }
    return `/api/stickers/image?${params.toString()}`;
  };

  return (
    <Modal open onOpenChange={open => !open && onClose()} title={t('Готовые QR-коды', 'Дайын QR-кодтар')}>
      <div className="stack">
        <div className={s.previewGrid}>
          {codes.slice(0, visible).map(code => (
            <figure key={code} className={s.previewCard}>
              <HistoryPreviewImage src={imageUrl(code)} code={code} authenticated={!entry.batchId} />
              <figcaption>{code}</figcaption>
            </figure>
          ))}
        </div>
        <div className="row">
          {visible < codes.length && (
            <>
              <Button variant="secondary" onClick={() => setVisible(Math.min(visible + 4, codes.length))}>
                {t('Показать ещё 4', 'Тағы 4 көрсету')}
              </Button>
              <Button variant="ghost" onClick={() => setVisible(codes.length)}>{t('Показать все', 'Барлығын көрсету')}</Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>{t('Свернуть', 'Жию')}</Button>
          <span className="muted">{t(`Показано ${visible} из ${codes.length}`, `${codes.length} ішінен ${visible} көрсетілді`)}</span>
        </div>
      </div>
    </Modal>
  );
}

function HistoryPreviewImage({ src, code, authenticated }: { src: string; code: string; authenticated: boolean }) {
  const [objectUrl, setObjectUrl] = useState('');
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    let currentUrl = '';
    void apiBlob(src).then(blob => {
      if (!active) return;
      currentUrl = URL.createObjectURL(blob);
      setObjectUrl(currentUrl);
    });
    return () => {
      active = false;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [authenticated, src]);
  return <img src={authenticated ? objectUrl : src} alt={`QR ${code}`} loading="lazy" />;
}

export function HistoryPage() {
  const t = useT();
  useDocumentMeta(t('История генераций — кабинет', 'Генерациялар тарихы — кабинет'));
  const [filter, setFilter] = useState<Filter>('all');
  const [printing, setPrinting] = useState<GenerationEntry | null>(null);
  const [previewing, setPreviewing] = useState<GenerationEntry | null>(null);
  const query = useHistory(filter);
  const cabinet = useCabinet();
  const dismiss = useCabinetMutation<{ dismissImportNotice: boolean }>(
    '/api/cabinet/preferences',
    'PATCH',
  );

  if (query.isPending)
    return (
      <div className="page">
        <CabinetLoading />
      </div>
    );
  if (query.isError)
    return (
      <div className="page">
        <CabinetError error={query.error} retry={() => query.refetch()} />
      </div>
    );

  const imported = cabinet.data?.profile.preferences;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t('История генераций', 'Генерациялар тарихы')}</h1>
        <p>{t('Серверная история доступна на всех ваших устройствах.', 'Сервердегі тарих барлық құрылғыларыңызда қолжетімді.')}</p>
      </header>

      {Boolean(
        imported?.historyImportedAt &&
        imported.historyImportedCount > 0 &&
        !imported.historyImportNoticeDismissedAt,
      ) && (
        <Alert tone="info">
          <div className="row">
            <span>{t('Перенесено локальных записей:', 'Ауыстырылған жергілікті жазбалар:')} {imported?.historyImportedCount}.</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dismiss.mutate({ dismissImportNotice: true })}
            >
              {t('Скрыть', 'Жасыру')}
            </Button>
          </div>
        </Alert>
      )}

      <Tabs
        label={t('Тип стикера', 'Стикер түрі')}
        value={filter}
        onChange={setFilter}
        items={[
          { value: 'all', label: t('Все', 'Барлығы') },
          { value: 'product', label: t('Товары', 'Тауарлар') },
          { value: 'box', label: t('QR коробок', 'Қорап QR-кодтары') },
        ]}
      />

      <div className="section">
        {query.data.items.length ? (
          <Table>
            <thead>
              <tr>
                <th>{t('Дата', 'Күні')}</th>
                <th>{t('Тип', 'Түрі')}</th>
                <th>{t('Режим', 'Режим')}</th>
                <th>{t('Количество', 'Саны')}</th>
                <th>{t('Номера', 'Нөмірлер')}</th>
                <th>{t('Напечатано', 'Басылды')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.items.map(g => {
                const codes = entryCodes(g);
                const printedCount = (g.printedCodes ?? []).filter(code =>
                  codes.includes(code),
                ).length;
                return (
                  <tr key={g.id}>
                    <td>{dateTime(g.createdAt)}</td>
                    <td>
                      <Badge tone={g.category === 'box' ? 'accent' : 'default'}>
                        {g.category === 'box' ? t('QR коробок', 'Қорап QR-кодтары') : t('Товары', 'Тауарлар')}
                      </Badge>
                    </td>
                    <td>{g.customJobId ? t(`Свой список · пачка ${(g.customJobPart ?? 0) + 1}`, `Өз тізім · ${(g.customJobPart ?? 0) + 1}-бума`) : g.mode === 'range' ? t('Массово', 'Көптеп') : t('По номеру', 'Нөмір бойынша')}</td>
                    <td>{g.customJob ? <><strong>{g.quantity}</strong><div className="muted">{t(`Всего: ${g.customJob.generated} из ${g.customJob.total}, осталось ${g.customJob.remaining}`, `Барлығы: ${g.customJob.total} ішінен ${g.customJob.generated}, ${g.customJob.remaining} қалды`)}</div></> : g.quantity}</td>
                    <td className="mono">
                      {g.code || g.codes?.slice(0, 2).join(' — ') || g.batchId || '—'}
                    </td>
                    <td>
                      {codes.length ? (
                        <Badge tone={printedCount >= codes.length ? 'success' : 'default'}>
                          {t(`${printedCount} из ${codes.length}`, `${codes.length} ішінен ${printedCount}`)}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <Button size="sm" variant="secondary" disabled={!codes.length} onClick={() => setPreviewing(g)}>
                          <QrCode size={16} />
                          {t('Посмотреть QR', 'QR қарау')}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!codes.length} onClick={() => setPrinting(g)}>
                          <Printer size={16} />
                          {t('Печать', 'Басып шығару')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Card>
            <EmptyState
              icon={<FileClock />}
              title={t('Здесь пока пусто', 'Мұнда әзірге бос')}
              text={t('Новые генерации появятся здесь автоматически.', 'Жаңа генерациялар осында автоматты түрде пайда болады.')}
              action={
                <Link to="/cabinet/generator">
                  <Button>{t('Открыть генератор', 'Генераторды ашу')}</Button>
                </Link>
              }
            />
          </Card>
        )}
      </div>

      {printing && <PrintDialog entry={printing} onClose={() => setPrinting(null)} />}
      {previewing && <PreviewDialog entry={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  );
}
