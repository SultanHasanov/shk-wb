import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Field, Input, Modal, Select } from '../../ui';
import { api } from '../../api/client';
import { MarketplaceScopeToggle } from '../../components/MarketplaceScopeToggle';
import {
  CELL_PRINT_DEVICES,
  CELL_PRINT_DURATIONS,
  type CellPrintMarketplaceScope,
  formatTotal,
  getCellPrintScopedPrice,
  getLicensePack,
  getPack,
  HEADLINE_PACK_LIST,
  iterationWord,
  LICENSE_PACK_LIST,
  POPULAR_LICENSE_PACK,
  POPULAR_PACK,
} from '../../lib/pricing';

// Покупки самой программы здесь больше нет: установщик скачивается бесплатно.
export type LicenseCheckout =
  | { kind: 'program_license'; targetKey?: string }
  | { kind: 'cell_print_license'; targetKey?: string; deviceLimit?: number; activeDevices?: number; marketplaceScope?: CellPrintMarketplaceScope }
  // Пополнение кода генератора: пул общий, поэтому у него единственный параметр —
  // сколько генераций добавить к уже имеющемуся коду.
  | { kind: 'stickers'; targetKey: string };

type Payment = { confirmationUrl: string };

export function LicenseCheckoutModal({
  checkout,
  availableKopecks,
  onClose,
}: {
  checkout: LicenseCheckout;
  availableKopecks: number;
  onClose: () => void;
}) {
  const [iterations, setIterations] = useState(POPULAR_LICENSE_PACK);
  const [durationDays, setDurationDays] = useState(30);
  const [deviceLimit, setDeviceLimit] = useState(
    checkout.kind === 'cell_print_license' ? (checkout.deviceLimit ?? 1) : 1,
  );
  const [marketplaceScope, setMarketplaceScope] = useState<CellPrintMarketplaceScope>(
    checkout.kind === 'cell_print_license' ? (checkout.marketplaceScope ?? 'wb') : 'wb',
  );
  const [promoCode, setPromoCode] = useState('');
  const [generations, setGenerations] = useState(POPULAR_PACK);
  const [accepted, setAccepted] = useState(false);
  const [useBalance, setUseBalance] = useState(false);

  const total =
    checkout.kind === 'program_license'
      ? getLicensePack(iterations).total
      : checkout.kind === 'stickers'
        ? getPack(generations).total
        : getCellPrintScopedPrice(durationDays, deviceLimit, marketplaceScope);
  const totalKopecks = Math.round(total * 100);
  const appliedKopecks = useBalance ? Math.min(totalKopecks, availableKopecks) : 0;
  const payableTotal = (totalKopecks - appliedKopecks) / 100;
  const title =
    checkout.kind === 'stickers'
      ? 'Пополнить код доступа'
      : checkout.kind === 'program_license'
        ? checkout.targetKey
          ? 'Пополнить ключ «Подбора кодов»'
          : 'Купить ключ «Подбора кодов»'
        : checkout.targetKey
          ? 'Продлить ключ «Печати ячеек»'
          : 'Купить ключ «Печати ячеек»';

  const payment = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        productKind: checkout.kind,
        accepted,
        returnTo: 'cabinet',
        referralCreditKopecks: useBalance ? Number.MAX_SAFE_INTEGER : 0,
      };
      if (checkout.kind === 'program_license') {
        body.licenseIterations = iterations;
        if (checkout.targetKey) body.renewalTargetKey = checkout.targetKey;
      }
      if (checkout.kind === 'cell_print_license') {
        body.durationDays = durationDays;
        body.deviceLimit = deviceLimit;
        body.marketplaceScope = marketplaceScope;
        body.promoCode = promoCode.trim().toUpperCase();
        if (checkout.targetKey) body.renewalTargetKey = checkout.targetKey;
      }
      if (checkout.kind === 'stickers') {
        body.quantity = generations;
        body.renewalTargetKey = checkout.targetKey;
      }
      return api<Payment>('/api/payments/create', { method: 'POST', body: JSON.stringify(body) });
    },
    onSuccess: data => location.assign(data.confirmationUrl),
  });

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={title}
      description="После подтверждения откроется защищённая страница оплаты ЮKassa."
    >
      <div className="stack">
        {checkout.kind === 'program_license' && (
          <Field label="Количество итераций">
            <Select value={iterations} onChange={e => setIterations(Number(e.target.value))}>
              {LICENSE_PACK_LIST.map(pack => (
                <option key={pack.quantity} value={pack.quantity}>
                  {pack.quantity} {iterationWord(pack.quantity)} — {formatTotal(pack.total)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {checkout.kind === 'stickers' && (
          <Field label="Количество генераций">
            <Select value={generations} onChange={e => setGenerations(Number(e.target.value))}>
              {HEADLINE_PACK_LIST.map(pack => (
                <option key={pack.quantity} value={pack.quantity}>
                  {pack.quantity} генераций — {formatTotal(pack.total)}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {checkout.kind === 'cell_print_license' && (
          <>
            <Field label="Для какого маркетплейса">
              <MarketplaceScopeToggle
                value={marketplaceScope}
                onChange={setMarketplaceScope}
                disabled={Boolean(checkout.targetKey)}
              />
            </Field>
            <div className="grid grid-2">
              <Field label="Срок">
                <Select
                  value={durationDays}
                  onChange={e => setDurationDays(Number(e.target.value))}
                >
                  {CELL_PRINT_DURATIONS.map(item => (
                    <option key={item.days} value={item.days}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Количество компьютеров">
                <Select value={deviceLimit} onChange={e => setDeviceLimit(Number(e.target.value))}>
                  {CELL_PRINT_DEVICES.map(count => (
                    <option
                      key={count}
                      value={count}
                      disabled={count < (checkout.activeDevices ?? 0)}
                    >
                      {count}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Промокод (необязательно)">
              <Input
                value={promoCode}
                maxLength={32}
                onChange={e => setPromoCode(e.target.value.toUpperCase())}
              />
            </Field>
            {checkout.targetKey && (
              <Alert tone="info">
                Неиспользованные дни сохранятся. Новый срок добавится к текущему окончанию, а для
                истёкшего ключа начнётся с момента оплаты.
              </Alert>
            )}
          </>
        )}

        {checkout.targetKey && (
          <p className="muted" style={{ margin: 0 }}>
            {checkout.kind === 'stickers' ? 'Код останется прежним' : 'Ключ останется прежним'}:{' '}
            <strong className="mono">{checkout.targetKey}</strong>
          </p>
        )}

        <div className="row">
          <span className="muted">К оплате</span>
          <strong style={{ fontSize: 'var(--fs-24)' }}>{formatTotal(payableTotal)}</strong>
        </div>

        <Checkbox checked={accepted} onChange={e => setAccepted(e.target.checked)}>
          Принимаю{' '}
          <a className="accent" href="/offer" target="_blank" rel="noreferrer">
            оферту
          </a>{' '}
          и{' '}
          <a className="accent" href="/privacy" target="_blank" rel="noreferrer">
            политику конфиденциальности
          </a>
        </Checkbox>
        {availableKopecks > 0 && (
          <Checkbox checked={useBalance} onChange={e => setUseBalance(e.target.checked)}>
            Использовать реферальный баланс — доступно {formatTotal(availableKopecks / 100)}
          </Checkbox>
        )}
        {useBalance && (
          <Alert tone="info">
            Из реферального баланса спишется {formatTotal(appliedKopecks / 100)}. К оплате останется{' '}
            {formatTotal(payableTotal)}.
          </Alert>
        )}
        {payment.isError && <Alert tone="error">{payment.error.message}</Alert>}
        <div className="row">
          <Button disabled={!accepted} loading={payment.isPending} onClick={() => payment.mutate()}>
            {payableTotal > 0 ? 'Перейти к оплате' : 'Оплатить балансом'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  );
}
