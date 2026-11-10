import { Link } from 'react-router-dom';
import { Eye, MessageSquare, ShieldBan, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../../ui';
import u from './user.module.css';

/**
 * Главные действия карточки. Десктоп — липкая панель под шапкой; телефон —
 * панель у нижнего края (нижняя навигация админки на карточке скрыта),
 * прячется при открытой клавиатуре. Место под неё в конце карточки оставляет
 * нижний отступ `.page` (user.module.css): отдельная прокладка здесь стояла бы
 * над вкладками, а не под ними.
 */
export function UserActionBar({
  onMessage,
  onLimits,
  onRestrict,
  previewHref,
  restricted,
}: {
  onMessage: () => void;
  onLimits: () => void;
  onRestrict: () => void;
  previewHref: string;
  restricted: boolean;
}) {
  const restrictLabel = restricted ? 'Изменить ограничение' : 'Ограничить';
  return (
    <>
      <div className={u.actionBar} role="toolbar" aria-label="Действия с пользователем">
        <Button onClick={onMessage}>
          <MessageSquare size={16} aria-hidden="true" />
          Написать
        </Button>
        <Button variant="secondary" onClick={onLimits}>
          <SlidersHorizontal size={16} aria-hidden="true" />
          Лимиты и доступы
        </Button>
        <Button variant="danger" onClick={onRestrict}>
          <ShieldBan size={16} aria-hidden="true" />
          {restrictLabel}
        </Button>
        <span className={u.actionSpacer} />
        <Link to={previewHref} target="_blank" rel="noreferrer">
          <Button variant="ghost" tabIndex={-1}>
            <Eye size={16} aria-hidden="true" />
            Предпросмотр кабинета
          </Button>
        </Link>
      </div>

      <nav className={u.mobileBar} aria-label="Действия с пользователем" data-hide-on-keyboard="">
        <Button size="sm" onClick={onMessage}>
          Написать
        </Button>
        <Button size="sm" variant="secondary" onClick={onLimits}>
          Лимиты
        </Button>
        <Button size="sm" variant="danger" onClick={onRestrict}>
          {restricted ? 'Ограничение' : 'Ограничить'}
        </Button>
        <Link to={previewHref} target="_blank" rel="noreferrer" aria-label="Предпросмотр кабинета">
          <Button size="sm" variant="ghost" tabIndex={-1} aria-hidden="true">
            <Eye size={18} />
          </Button>
        </Link>
      </nav>
    </>
  );
}
