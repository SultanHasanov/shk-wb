import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal } from '../ui';
import { useT } from '../i18n';
import {
  EMPTY_WHATS_NEW_STATE,
  WHATS_NEW,
  markSeen,
  readWhatsNewState,
  unseenEntries,
  updateWhatsNewState,
  type WhatsNewEntry,
  type WhatsNewState,
} from '../lib/whats-new';
import s from './WhatsNew.module.css';

/**
 * Состояние «Что нового» одного аккаунта: что уже показано и какие разделы открыты.
 *
 * Правка идёт в два места: в память (чтобы окно и метка пропали сразу, даже когда
 * хранилище недоступно — приватное окно) и в localStorage свежим «прочитать —
 * изменить — записать». Окно и меню держат по своей копии и не затирают друг друга.
 */
export function useWhatsNewState(userId: string | null) {
  const [box, setBox] = useState(() => ({
    userId,
    state: userId ? readWhatsNewState(userId) : EMPTY_WHATS_NEW_STATE,
  }));
  let current = box;
  if (box.userId !== userId) {
    // Сменился аккаунт — берём его запись сразу, без кадра с чужим состоянием.
    current = { userId, state: userId ? readWhatsNewState(userId) : EMPTY_WHATS_NEW_STATE };
    setBox(current);
  }

  const update = useCallback(
    (change: (state: WhatsNewState) => WhatsNewState) => {
      if (!userId) return;
      setBox(prev => (prev.userId === userId ? { userId, state: change(prev.state) } : prev));
      updateWhatsNewState(userId, change);
    },
    [userId],
  );

  return [current.state, update] as const;
}

/**
 * Окно «Что нового»: показывается один раз на каждую запись. Закрытие любым
 * способом (кнопка, крестик, Esc, клик мимо) считается «прочитано».
 */
export function WhatsNew({
  userId,
  createdAt,
  entries = WHATS_NEW,
}: {
  userId: string;
  /** Дата регистрации аккаунта (ISO): новости старше неё не показываются. null — показать всё. */
  createdAt: string | null;
  entries?: readonly WhatsNewEntry[];
}) {
  const t = useT();
  const navigate = useNavigate();
  const [state, update] = useWhatsNewState(userId);
  const unseen = unseenEntries(state, createdAt, entries);
  if (!unseen.length) return null;

  const dismiss = () => update(current => markSeen(current, unseen.map(entry => entry.id)));
  const openSection = (path: string) => {
    dismiss();
    navigate(path);
  };
  const openLabel = t('Открыть раздел', 'Бөлімді ашу');
  // Одна новость — кнопка раздела в подвале рядом с «Понятно»; несколько — у каждой своя.
  const single = unseen.length === 1 ? unseen[0] : null;
  const singleTarget = single?.sections[0];

  return (
    <Modal
      open
      onOpenChange={open => {
        if (!open) dismiss();
      }}
      title={t('Что нового', 'Не жаңалық')}
      description={t('Коротко о том, что изменилось в кабинете.', 'Кабинетте не өзгергені туралы қысқаша.')}
      footer={
        <>
          <Button variant={singleTarget ? 'secondary' : 'primary'} onClick={dismiss}>
            {t('Понятно', 'Түсінікті')}
          </Button>
          {singleTarget && <Button onClick={() => openSection(singleTarget)}>{openLabel}</Button>}
        </>
      }
    >
      <div className={s.entries}>
        {unseen.map(entry => (
          <section key={entry.id}>
            <h3 className={s.entryTitle}>{t(entry.title[0], entry.title[1])}</h3>
            <ul className={s.list}>
              {entry.items.map(([ru, kz]) => (
                <li key={ru}>{t(ru, kz)}</li>
              ))}
            </ul>
            {!single && entry.sections[0] && (
              <div className={s.entryAction}>
                <Button variant="secondary" size="sm" onClick={() => openSection(entry.sections[0])}>
                  {openLabel}
                </Button>
              </div>
            )}
          </section>
        ))}
      </div>
    </Modal>
  );
}
