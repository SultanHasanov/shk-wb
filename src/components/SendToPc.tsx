import { Laptop, Send } from 'lucide-react';
import { Button, useToast } from '../ui';
import { useT } from '../i18n';
import s from './SendToPc.module.css';

/**
 * Программы — только для Windows, поэтому на телефоне вместо «Скачать» объясняем,
 * как поставить на компьютер, и даём отправить ссылку себе (Telegram, почта,
 * заметки — системное меню «Поделиться»; без него ссылка копируется).
 */
export function useShareLink() {
  const t = useT();
  const toast = useToast();
  return async (title: string) => {
    const url = window.location.origin + window.location.pathname;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (e) {
        // Пользователь закрыл меню — это не ошибка.
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('Ссылка скопирована — откройте её на компьютере', 'Сілтеме көшірілді — оны компьютерде ашыңыз'), 'success');
    } catch {
      toast(url);
    }
  };
}

export function SendToPc({ program }: { program: string }) {
  const t = useT();
  const share = useShareLink();
  return (
    <div className={`${s.card} mobile-only`}>
      <div className={s.head}>
        <span className={s.icon}><Laptop size={20} /></span>
        <strong>{t('Программа ставится на компьютер', 'Бағдарлама компьютерге орнатылады')}</strong>
      </div>
      <ol className={s.steps}>
        <li>{t('Откройте эту страницу на компьютере с Windows 10 или 11', 'Осы бетті Windows 10 немесе 11 компьютерінде ашыңыз')}</li>
        <li>{t('Нажмите «Скачать бесплатно» и установите', '«Тегін жүктеп алу» басып, орнатыңыз')}</li>
        <li>{t('Войдите тем же аккаунтом, что на сайте', 'Сайттағы аккаунтпен кіріңіз')}</li>
      </ol>
      <Button block variant="secondary" onClick={() => share(program)}>
        <Send size={16} />
        {t('Отправить ссылку себе', 'Сілтемені өзіңізге жіберу')}
      </Button>
    </div>
  );
}
