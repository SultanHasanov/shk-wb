import { useCallback } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { useToast } from '../../../ui';
import type { AdminUserDetail } from '../../../api/admin';
import { isTelegramOnly } from '../../../lib/admin-users';

/** Общие подписи и помощники вкладок карточки пользователя. */

export const USER_TABS = [
  { value: 'overview', label: 'Обзор' },
  { value: 'access', label: 'Доступы и лимиты' },
  { value: 'devices', label: 'ПК и пункты' },
  { value: 'money', label: 'Деньги' },
  { value: 'messages', label: 'Сообщения' },
  { value: 'audit', label: 'Журнал' },
  { value: 'danger', label: 'Опасная зона' },
] as const;

export type UserTab = (typeof USER_TABS)[number]['value'];

/** ?tab= из адреса; неизвестное → «Обзор» (контракт 5.1). */
export function parseUserTab(value: string | null): UserTab {
  return USER_TABS.some(tab => tab.value === value) ? (value as UserTab) : 'overview';
}

export const PLAN_LABEL: Record<string, string> = { basic: 'Базовый', standard: 'Стандарт', pro: 'Про' };
export const CELL_DURATIONS = [3, 7, 30, 90, 180, 365] as const;
export const CELL_DEVICES = [1, 2, 3, 5, 10, 20] as const;
export const APP_TERMS = [1, 3, 6, 12] as const;

export const OAUTH_LABEL: Record<string, string> = { yandex: 'Яндекс ID', mailru: 'Mail.ru', vkid: 'VK ID' };

export function sourceLabel(source: string): string {
  return source === 'admin' ? 'админ' : source === 'partner' ? 'партнёр' : 'оплата';
}

/** Статус отрезка подписки/услуги на сейчас. */
export function periodState(item: { canceled: boolean; startsAt: string; endsAt: string }, now = Date.now()) {
  const active = !item.canceled && Date.parse(item.endsAt) > now && Date.parse(item.startsAt) <= now;
  const future = !item.canceled && Date.parse(item.startsAt) > now;
  const label = active ? 'активна' : future ? 'в очереди' : item.canceled ? 'отозвана' : 'истекла';
  const tone: 'success' | 'default' | 'error' = active ? 'success' : future ? 'default' : 'error';
  return { active, future, label, tone };
}

/** Имя для заголовков: имя из профиля, почта, @telegram или начало ID. */
export function displayNameOf(detail: AdminUserDetail): string {
  const name = detail.profile?.display_name?.trim();
  if (name) return name;
  if (detail.email && !isTelegramOnly(detail.email)) return detail.email;
  if (detail.telegram?.username) return `@${detail.telegram.username}`;
  return detail.userId.slice(0, 8);
}

/** Почта без технической telegram-почты. */
export function realEmail(detail: AdminUserDetail): string | null {
  return detail.email && !isTelegramOnly(detail.email) ? detail.email : null;
}

/** «Анна Смирнова · anna.s@example.ru» для шапок окон. */
export function modalSubtitle(detail: AdminUserDetail, extra?: string | null): string {
  const name = displayNameOf(detail);
  const email = realEmail(detail);
  return [name, email && email !== name ? email : null, extra].filter(Boolean).join(' · ');
}

/** Дней до даты (вверх), не меньше 0. */
export function daysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.ceil((time - now) / 86_400_000));
}

/**
 * Одинаковый хвост у быстрых действий карточки: тост об успехе или ошибке.
 * Возвращает промис — его можно отдать в ConfirmDialog/NumberDialog, тогда
 * ошибка покажется в самом окне и окно не закроется.
 */
export function useRunner() {
  const toast = useToast();
  return useCallback(
    async <TBody, TResult>(mutation: UseMutationResult<TResult, Error, TBody, unknown>, body: TBody, message: string): Promise<TResult> => {
      const result = await mutation.mutateAsync(body);
      toast(message, 'success');
      return result;
    },
    [toast],
  );
}

/** Для кнопок без окна: ошибка — тостом, а не необработанным промисом. */
export function useQuickRunner() {
  const toast = useToast();
  const run = useRunner();
  return useCallback(
    <TBody, TResult>(mutation: UseMutationResult<TResult, Error, TBody, unknown>, body: TBody, message: string) => {
      run(mutation, body, message).catch((error: unknown) => toast(error instanceof Error ? error.message : 'Не удалось выполнить действие', 'error'));
    },
    [run, toast],
  );
}
