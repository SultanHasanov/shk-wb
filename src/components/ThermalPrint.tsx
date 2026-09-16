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

  async function onThermal() {
    if ('error' in parsed || blocked) return;
    setFailed(false);
    try {
      await printLabels(imageUrls, parsed, DESIGN_HEIGHT[kind]);
      setStatus(`Открыто окно печати: ${parsed.width} × ${parsed.height} мм.`);
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : 'Не удалось открыть окно печати.');
    }
  }

  async function onNiimbot() {
    setFailed(false);
    setNiimbotBusy(true);
    try {
      await printOnNiimbot(imageUrls, (current, total) =>
        setStatus(`Печать ${current} из ${total}…`),
      );
      setStatus('Все этикетки отправлены на NIIMBOT.');
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : 'Ошибка печати на NIIMBOT.');
    } finally {
      setNiimbotBusy(false);
    }
  }

  return (
    <div className={s.block}>
      <div>
        <strong>Печать по одной этикетке</strong>
        <p className={s.help}>
          Каждая этикетка печатается на отдельной странице размером с саму этикетку — для
          термопринтера с рулоном.
        </p>
      </div>

      <Field label="Размер этикетки">
        <Select value={sizeValue} onChange={e => setSizeValue(e.target.value as ThermalSizeValue)}>
          {THERMAL_SIZES.map(item => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </Field>

      {sizeValue === 'custom' && (
        <div className={s.custom}>
          <Field label="Ширина, мм">
            <Input
              inputMode="decimal"
              value={customWidth}
              onChange={e => setCustomWidth(e.target.value)}
            />
          </Field>
          <span className={s.separator} aria-hidden="true">
            ×
          </span>
          <Field label="Высота, мм">
            <Input
              inputMode="decimal"
              value={customHeight}
              onChange={e => setCustomHeight(e.target.value)}
            />
          </Field>
        </div>
      )}

      <Field label="Модель для проверки ширины">
        <Select value={model} onChange={e => setModel(e.target.value as PrinterModelValue)}>
          {PRINTER_MODELS.map(item => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </Field>

      {(sizeError || warning) && <Alert tone="warning">{sizeError || warning}</Alert>}

      <p className={s.help}>
        В окне печати выберите термопринтер, масштаб 100%, поля «Нет», отключите колонтитулы и
        укажите такой же размер бумаги в драйвере.
      </p>

      <div className={s.actions}>
        <Button onClick={onThermal} disabled={blocked}>
          <Printer size={18} />
          Печать на термопринтере
        </Button>
        {niimbotSupported() && (
          <Button variant="secondary" onClick={onNiimbot} loading={niimbotBusy} disabled={!imageUrls.length}>
            <Bluetooth size={18} />
            Печать на NIIMBOT
          </Button>
        )}
      </div>

      {status && <Alert tone={failed ? 'error' : 'info'}>{status}</Alert>}
    </div>
  );
}
