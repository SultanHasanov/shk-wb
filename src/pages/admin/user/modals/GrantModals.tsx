import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAdminUserAction } from '../../../../api/admin';
import { MarketplaceScopeToggle } from '../../../../components/MarketplaceScopeToggle';
import type { CellPrintMarketplaceScope } from '../../../../lib/pricing';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '../../../../ui';
import { APP_TERMS, CELL_DEVICES, CELL_DURATIONS, PLAN_LABEL } from '../shared';

/**
 * Окна выдачи, перенесённые из прежней карточки без изменения поведения:
 * код генератора, индивидуальный заказ, ключ подборов, ключ ПВЗ Принт.
 * Плюс выдача подписки (раньше — строка полей прямо в карточке).
 */

type ModalProps = { open: boolean; onOpenChange: (open: boolean) => void; userId: string };

/** Тост, закрытие окна; ошибка — тостом, окно остаётся открытым (как было). */
function useSubmit(onOpenChange: (open: boolean) => void) {
  const toast = useToast();
  return <TBody,>(mutate: (body: TBody, options: { onSuccess: () => void; onError: (error: Error) => void }) => void, body: TBody, message: string) =>
    mutate(body, {
      onSuccess: () => {
        toast(message, 'success');
        onOpenChange(false);
      },
      onError: error => toast(error.message, 'error'),
    });
}

export function GrantStickerModal({ open, onOpenChange, userId }: ModalProps) {
  const grant = useAdminUserAction<{ userId: string; name: string; limit: number }>('grantSticker');
  const submit = useSubmit(onOpenChange);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Выдать код доступа" description="Код сгенерирует сервер и сразу привяжет его к этому пользователю.">
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          submit(grant.mutate, { userId, name: String(form.get('name') || ''), limit: Number(form.get('limit') || 0) }, 'Код выдан');
        }}
      >
        <Field label="Имя пакета">
          <Input name="name" defaultValue="Выдан администратором" required />
        </Field>
        <Field label="Сколько генераций">
          <Input name="limit" type="number" min={1} max={100000} defaultValue={100} required />
        </Field>
        <Button type="submit" loading={grant.isPending}>
          Выдать
        </Button>
      </form>
    </Modal>
  );
}

export function IndividualOrderModal({ open, onOpenChange, userId }: ModalProps) {
  const create = useAdminUserAction<{ userId: string; title: string; codes: string; totalAmount: number; creditUnits: number }>(
    'createIndividualStickerOrder',
  );
  const submit = useSubmit(onOpenChange);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Создать индивидуальный заказ"
      description="Номера будут закрыты до оплаты. Остаток генераций резервируется сразу."
    >
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          submit(
            create.mutate,
            {
              userId,
              title: String(form.get('title') || ''),
              codes: String(form.get('codes') || ''),
              totalAmount: Number(form.get('totalAmount') || 0),
              creditUnits: Number(form.get('creditUnits') || 0),
            },
            'Индивидуальный заказ выставлен',
          );
        }}
      >
        <Field label="Название">
          <Input name="title" defaultValue="Индивидуальный заказ стикеров" required />
        </Field>
        <Field label="Номера" help="По одному в строке. Повторы будут удалены.">
          <Textarea name="codes" rows={10} required />
        </Field>
        <Field label="Полная стоимость, ₽">
          <Input name="totalAmount" type="number" min="0" step="0.01" required />
        </Field>
        <Field label="Зачесть генераций из текущего пакета">
          <Input name="creditUnits" type="number" min="0" defaultValue="0" required />
        </Field>
        <Button type="submit" loading={create.isPending}>
          Выставить заказ
        </Button>
      </form>
    </Modal>
  );
}

export function GrantProgramKeyModal({ open, onOpenChange, userId }: ModalProps) {
  const grant = useAdminUserAction<{ userId: string; key: string; limit: number; note: string }>('grantProgramKey');
  const submit = useSubmit(onOpenChange);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Выдать ключ «Подбора кодов»">
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          submit(
            grant.mutate,
            { userId, key: String(form.get('key') || ''), limit: Number(form.get('limit') || 0), note: String(form.get('note') || '') },
            'Ключ выдан',
          );
        }}
      >
        <Field label="Ключ" help="6–64 латинские буквы, цифры или дефис">
          <Input name="key" defaultValue="WBPK-" required />
        </Field>
        <Field label="Лимит итераций">
          <Input name="limit" type="number" min={1} defaultValue={1000} required />
        </Field>
        <Field label="Пометка">
          <Input name="note" />
        </Field>
        <Button type="submit" loading={grant.isPending}>
          Выдать
        </Button>
      </form>
    </Modal>
  );
}

export function GrantCellLicenseModal({ open, onOpenChange, userId }: ModalProps) {
  const grant = useAdminUserAction<{
    userId: string;
    durationDays: number;
    deviceLimit: number;
    marketplaceScope: 'wb' | 'ozon' | 'both';
    note: string;
  }>('grantCellLicense');
  const [scope, setScope] = useState<CellPrintMarketplaceScope>('wb');
  const submit = useSubmit(onOpenChange);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Выдать ключ «ПВЗ Принт»">
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          submit(
            grant.mutate,
            {
              userId,
              durationDays: Number(form.get('durationDays')),
              deviceLimit: Number(form.get('deviceLimit')),
              marketplaceScope: scope,
              note: String(form.get('note') || ''),
            },
            'Ключ выдан',
          );
        }}
      >
        <Field label="Срок">
          <Select name="durationDays" defaultValue="30">
            {CELL_DURATIONS.map(days => (
              <option key={days} value={days}>
                {days} дней
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Устройств">
          <Select name="deviceLimit" defaultValue="1">
            {CELL_DEVICES.map(devices => (
              <option key={devices} value={devices}>
                {devices}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Маркетплейс">
          <MarketplaceScopeToggle value={scope} onChange={setScope} />
        </Field>
        <Field label="Пометка">
          <Input name="note" />
        </Field>
        <Button type="submit" loading={grant.isPending}>
          Выдать
        </Button>
      </form>
    </Modal>
  );
}

export function GrantSubscriptionModal({ open, onOpenChange, userId, initialPlan }: ModalProps & { initialPlan?: string | null }) {
  const grant = useAdminUserAction<{ userId: string; plan: string; months: number; reason?: string }>('grantAppSubscription');
  const submit = useSubmit(onOpenChange);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Выдать подписку «Помощник ПВЗ»"
      description="Выдаётся помимо оплаты: тариф применяется как при покупке — продление, повышение или очередь."
    >
      <form
        className="stack"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          submit(
            grant.mutate,
            {
              userId,
              plan: String(form.get('plan') || 'standard'),
              months: Number(form.get('months') || 1),
              reason: String(form.get('reason') || '').trim() || undefined,
            },
            'Подписка выдана',
          );
        }}
      >
        <Field label="Тариф">
          <Select name="plan" defaultValue={initialPlan && PLAN_LABEL[initialPlan] ? initialPlan : 'standard'}>
            {Object.entries(PLAN_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Срок">
          <Select name="months" defaultValue="1">
            {APP_TERMS.map(months => (
              <option key={months} value={months}>
                {months} {months === 1 ? 'месяц' : months < 5 ? 'месяца' : 'месяцев'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Причина для журнала" help="Необязательно. Видно только в журнале админки">
          <Input name="reason" maxLength={500} />
        </Field>
        <Button type="submit" loading={grant.isPending}>
          Выдать подписку
        </Button>
      </form>
    </Modal>
  );
}
