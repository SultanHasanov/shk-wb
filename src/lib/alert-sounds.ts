/**
 * Звуки окна «сообщение от владельца» в «Помощнике ПВЗ». Те же шесть WAV встроены в программу
 * (src-tauri/sounds) и лежат на сайте в sounds/pvz — чтобы владелец мог прослушать их в кабинете.
 * Список id должен совпадать с server/_app-account.js ALERT_SOUNDS и sound.rs IDS.
 */
export const ALERT_SOUNDS = [
  { id: 'chime', title: 'Перезвон' },
  { id: 'bell', title: 'Колокольчик' },
  { id: 'ding', title: 'Динь' },
  { id: 'knock', title: 'Стук' },
  { id: 'pulse', title: 'Три сигнала' },
  { id: 'soft', title: 'Мягкий' },
] as const;

export type AlertSoundId = (typeof ALERT_SOUNDS)[number]['id'];

export const DEFAULT_ALERT_SOUND: AlertSoundId = 'chime';

export function soundUrl(id: string) {
  return `/sounds/pvz/${id}.wav`;
}

export function soundTitle(id: string | null | undefined) {
  return ALERT_SOUNDS.find(s => s.id === id)?.title ?? ALERT_SOUNDS[0].title;
}

/** Прослушать в браузере. Ошибки автоплея (нет жеста) глотаем — кнопка всегда по клику. */
export function playSound(id: string) {
  try {
    const audio = new Audio(soundUrl(id));
    void audio.play().catch(() => undefined);
  } catch {
    /* нет Audio (SSR, старый браузер) */
  }
}
