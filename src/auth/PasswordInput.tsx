import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useT } from '../i18n';
import { Input } from '../ui';

/**
 * Поле пароля с «глазком» (по прототипу модалки входа). Все пропсы, включая id/aria от Field
 * и ref от react-hook-form, уходят в сам <input>; кнопка только переключает type.
 */
export function PasswordInput({ style, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <Input {...p} type={shown ? 'text' : 'password'} style={{ flex: 1, paddingRight: 44, ...style }} />
      <button
        type="button"
        aria-label={shown ? t('Скрыть пароль', 'Құпиясөзді жасыру') : t('Показать пароль', 'Құпиясөзді көрсету')}
        title={shown ? t('Скрыть пароль', 'Құпиясөзді жасыру') : t('Показать пароль', 'Құпиясөзді көрсету')}
        onClick={() => setShown(v => !v)}
        style={{
          position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', width: 36, height: 36,
          border: 0, borderRadius: 10, background: 'transparent', color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      >
        {shown ? <EyeOff size={20} /> : <Eye size={20} />}
      </button>
    </div>
  );
}
