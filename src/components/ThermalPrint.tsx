import { useEffect, useState } from 'react';
import { Printer, Bluetooth } from 'lucide-react';
import { Alert, Button, Field, Input, Select } from '../ui';
import {
  DESIGN_HEIGHT,
  PRINTER_MODELS,
  printLabels,
  parseThermalSize,
  THERMAL_SIZES,
  widthWarning,
  type PrinterModelValue,
  type ThermalSizeValue,
} from '../lib/thermal-print';
import { niimbotSupported, printOnNiimbot } from '../lib/niimbot';
import { useT } from '../i18n';
import s from './ThermalPrint.module.css';

/** Ключ тот же, что в старом js/app.js: у постоянных клиентов размер подхватится. */
const STORAGE_KEY = 'thermal-print-settings';

type Saved = { size?: string; width?: string; height?: string; printer?: string };

function readSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Saved;
  } catch {
    return {};
  }
}

const isSize = (value: string): value is ThermalSizeValue =>
  THERMAL_SIZES.some(item => item.value === value);
const isModel = (value: string): value is PrinterModelValue =>
  PRINTER_MODELS.some(item => item.value === value);

/**
 * Печать этикеток по одной. Блок вернулся из старой статики: в React-версии от
 * него не осталось ничего, хотя лендинги обещают и TSC, и NIIMBOT.
 *
 * `defaultSize` приходит из настроек кабинета — до этого они сохранялись в базу,
 * и их никто не читал.
 */
export function ThermalPrint({
  imageUrls,
  kind,
  defaultSize,
}: {
  imageUrls: readonly string[];
  kind: 'product' | 'box';
  defaultSize?: string;
}) {
  const t = useT();
  const [sizeValue, setSizeValue] = useState<ThermalSizeValue>(() => {
    const saved = readSaved().size;
    if (saved && isSize(saved)) return saved;
    return defaultSize && isSize(defaultSize) ? defaultSize : '58x40';
  });
  const [customWidth, setCustomWidth] = useState(() => readSaved().width ?? '50');
  const [customHeight, setCustomHeight] = useState(() => readSaved().height ?? '30');
  const [model, setModel] = useState<PrinterModelValue>(() => {
    const saved = readSaved().printer;
    return saved && isModel(saved) ? saved : 'other';
  });
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [niimbotBusy, setNiimbotBusy] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ size: sizeValue, width: customWidth, height: customHeight, printer: model }),
      );
    } catch {
      // Приватный режим: настройки просто не переживут перезагрузку.
    }
  }, [sizeValue, customWidth, customHeight, model]);

  const parsed = parseThermalSize(sizeValue, customWidth, customHeight);
  const sizeError = 'error' in parsed ? parsed.error : '';
  const warning = 'error' in parsed ? '' : widthWarning(parsed, model);
  const blocked = Boolean(sizeError || warning) || !imageUrls.length;

  const sizeLabel = (item: { value: string; label: string }) =>
    item.value === 'custom' ? t('Свой размер', 'Өз өлшеміңіз') : item.label.replace('мм', t('мм', 'мм'));
  const modelLabel = (item: { value: string; label: string }) =>
    item.value === 'other' ? t('Другой принтер', 'Басқа принтер') : item.label.replace('до', t('до', 'дейін'));
  // Тексты проверки размера приходят из lib/thermal-print.ts по-русски.
  const sizeHint = sizeError
    ? t(sizeError, 'Енді және биіктікті рұқсат етілген шектерде көрсетіңіз.')
    : warning
      ? t(warning, 'Заттаңба ені осы модельдің шегінен асады. Кішірек өлшемді таңдаңыз.')
      : '';

  async function onThermal() {
    if ('error' in parsed || blocked) return;
    setFailed(false);
    try {
      await printLabels(imageUrls, parsed, DESIGN_HEIGHT[kind]);
      setStatus(t(`Открыто окно печати: ${parsed.width} × ${parsed.height} мм.`, `Басып шығару терезесі ашылды: ${parsed.width} × ${parsed.height} мм.`));
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : t('Не удалось открыть окно печати.', 'Басып шығару терезесін ашу мүмкін болмады.'));
    }
  }

  async function onNiimbot() {
    setFailed(false);
    setNiimbotBusy(true);
    try {
      await printOnNiimbot(imageUrls, (current, total) =>
        setStatus(t(`Печать ${current} из ${total}…`, `Басып шығару: ${total} ішінен ${current}…`)),
      );
      setStatus(t('Все этикетки отправлены на NIIMBOT.', 'Барлық заттаңбалар NIIMBOT-қа жіберілді.'));
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : t('Ошибка печати на NIIMBOT.', 'NIIMBOT-та басып шығару қатесі.'));
    } finally {
      setNiimbotBusy(false);
    }
  }

  return (
    <div className={s.block}>
      <div>
        <strong>{t('Печать по одной этикетке', 'Заттаңбаларды бір-бірден басу')}</strong>
        <p className={s.help}>
          {t(
            'Каждая этикетка печатается на отдельной странице размером с саму этикетку — для термопринтера с рулоном.',
            'Әр заттаңба өз өлшеміндей бөлек бетке басылады — орамды термопринтер үшін.',
          )}
        </p>
      </div>

      <Field label={t('Размер этикетки', 'Заттаңба өлшемі')}>
        <Select value={sizeValue} onChange={e => setSizeValue(e.target.value as ThermalSizeValue)}>
          {THERMAL_SIZES.map(item => (
            <option key={item.value} value={item.value}>
              {sizeLabel(item)}
            </option>
          ))}
        </Select>
      </Field>

      {sizeValue === 'custom' && (
        <div className={s.custom}>
          <Field label={t('Ширина, мм', 'Ені, мм')}>
            <Input
              inputMode="decimal"
              value={customWidth}
              onChange={e => setCustomWidth(e.target.value)}
            />
          </Field>
          <span className={s.separator} aria-hidden="true">
            ×
          </span>
          <Field label={t('Высота, мм', 'Биіктігі, мм')}>
            <Input
              inputMode="decimal"
              value={customHeight}
              onChange={e => setCustomHeight(e.target.value)}
            />
          </Field>
        </div>
      )}

      <Field label={t('Модель для проверки ширины', 'Енді тексеруге арналған модель')}>
        <Select value={model} onChange={e => setModel(e.target.value as PrinterModelValue)}>
          {PRINTER_MODELS.map(item => (
            <option key={item.value} value={item.value}>
              {modelLabel(item)}
            </option>
          ))}
        </Select>
      </Field>

      {sizeHint && <Alert tone="warning">{sizeHint}</Alert>}

      <p className={s.help}>
        {t(
          'В окне печати выберите термопринтер, масштаб 100%, поля «Нет», отключите колонтитулы и укажите такой же размер бумаги в драйвере.',
          'Басып шығару терезесінде термопринтерді, 100% масштабты, «Жоқ» жиектерін таңдаңыз, колонтитулдарды өшіріп, драйверде қағаздың дәл осындай өлшемін көрсетіңіз.',
        )}
      </p>

      <div className={s.actions}>
        <Button onClick={onThermal} disabled={blocked}>
          <Printer size={18} />
          {t('Печать на термопринтере', 'Термопринтерде басу')}
        </Button>
        {niimbotSupported() && (
          <Button variant="secondary" onClick={onNiimbot} loading={niimbotBusy} disabled={!imageUrls.length}>
            <Bluetooth size={18} />
            {t('Печать на NIIMBOT', 'NIIMBOT-та басу')}
          </Button>
        )}
      </div>

      {status && <Alert tone={failed ? 'error' : 'info'}>{status}</Alert>}
    </div>
  );
}
