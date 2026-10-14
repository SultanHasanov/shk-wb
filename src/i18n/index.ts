import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { UNSAFE_LocationContext, useLocation } from 'react-router-dom';
import { preferCurrency } from '../lib/currency';

/**
 * Языки сайта: русский и казахский.
 *
 * Тексты пишутся парой прямо в компоненте — t('Русский', 'Қазақша'). Отдельные
 * словари с ключами на 1200 строк быстро расходятся с вёрсткой: перевод живёт
 * рядом с оригиналом, а забыть второй аргумент не даст TypeScript.
 *
 * Откуда берётся язык:
 *  - публичные страницы — из адреса: /kz/... казахский, без префикса русский.
 *    Только так казахские страницы попадают в поиск: пререндер снимает их по
 *    отдельным адресам (build-static.mjs);
 *  - кабинет, вход, оплата — из выбора посетителя (localStorage).
 */

export type Locale = 'ru' | 'kk';
export type Text = { ru: string; kk: string };
export type T = (ru: string, kk: string) => string;

export const KZ_PREFIX = '/kz';
const STORAGE_KEY = 'locale';

/** Разделы без языковых адресов: язык в них — сохранённый выбор. */
const APP_SECTIONS = /^\/(cabinet|panel|login|register|forgot-password|reset-password|payment-result|bot-checkout|telegram-account|r)(\/|$)/;

function readStored(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'kk' || value === 'ru' ? value : null;
  } catch {
    return null;
  }
}

let stored: Locale | null = readStored();
const listeners = new Set<() => void>();

export function setLocalePreference(locale: Locale) {
  stored = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Приватный режим: выбор проживёт до перезагрузки.
  }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStoredLocale(): Locale | null {
  return useSyncExternalStore(subscribe, () => stored, () => null);
}

export function isKzPath(pathname: string) {
  return pathname === KZ_PREFIX || pathname.startsWith(`${KZ_PREFIX}/`);
}

/** Адрес без языкового префикса: /kz/program → /program, /kz → /. */
export function stripLocale(pathname: string) {
  if (!isKzPath(pathname)) return pathname;
  return pathname.slice(KZ_PREFIX.length) || '/';
}

/** Публичный адрес на нужном языке. Разделы приложения префикса не получают. */
export function localizePath(path: string, locale: Locale) {
  const [pathname, rest = ''] = splitPath(path);
  const base = stripLocale(pathname);
  if (locale === 'ru' || APP_SECTIONS.test(base) || !base.startsWith('/')) return base + rest;
  return (base === '/' ? KZ_PREFIX : KZ_PREFIX + base) + rest;
}

function splitPath(path: string): [string, string] {
  const index = path.search(/[?#]/);
  return index === -1 ? [path, ''] : [path.slice(0, index), path.slice(index)];
}

export function localeForPath(pathname: string, preference: Locale | null): Locale {
  if (isKzPath(pathname)) return 'kk';
  if (APP_SECTIONS.test(pathname)) return preference ?? 'ru';
  return 'ru';
}

export function useLocale(): Locale {
  // Контекст, а не useLocation: компоненты UI-кита рендерятся и вне роутера
  // (тесты, порталы), где useLocation бросает исключение.
  const location = useContext(UNSAFE_LocationContext)?.location;
  const pathname = location?.pathname ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  return localeForPath(pathname, useStoredLocale());
}

/** Язык вне React (форматирование дат в хелперах): тот же расчёт, что в useLocale. */
export function currentLocale(): Locale {
  const pathname = typeof window === 'undefined' ? '/' : window.location.pathname;
  return localeForPath(pathname, stored);
}

export function translate(locale: Locale): T {
  return locale === 'kk' ? (_ru, kk) => kk : ru => ru;
}

export function useT(): T {
  const locale = useLocale();
  return useCallback<T>((ru, kk) => (locale === 'kk' ? kk : ru), [locale]);
}

/** Для текстов из констант: { ru, kk } → строка на текущем языке. */
export function pick(text: Text, locale: Locale) {
  return text[locale];
}

/** Ссылки внутри публичной части: на казахской версии ведут на /kz/... */
export function useLocalePath() {
  const locale = useLocale();
  return useCallback((path: string) => localizePath(path, locale), [locale]);
}

/** Intl-локаль для дат и чисел. Казахский Intl знает, но числа пишет так же. */
export function intlLocale(locale: Locale) {
  return locale === 'kk' ? 'kk-KZ' : 'ru-RU';
}

/**
 * Один раз на приложение: <html lang>, запоминание выбора и валюта по умолчанию.
 * Заход на /kz-страницу — тоже выбор языка: кабинет и вход откроются по-казахски.
 */
export function useLocaleEffects() {
  const { pathname } = useLocation();
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale === 'kk' ? 'kk' : 'ru';
    if (locale === 'kk') preferCurrency('KZT');
  }, [locale]);
  useEffect(() => {
    if (isKzPath(pathname) && stored !== 'kk') setLocalePreference('kk');
  }, [pathname]);
}
