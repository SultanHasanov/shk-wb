import { useEffect } from 'react';

/** Поля, при вводе в которые на телефоне открывается клавиатура. */
const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea, [contenteditable="true"]';

const isField = (el: Element | null) => Boolean(el && el.matches(FIELD));

/**
 * Пока на телефоне открыта клавиатура, на <html> висит класс `keyboard-open`:
 * нижний таббар и липкие панели (`[data-hide-on-keyboard]`) прячутся и не
 * закрывают поле ввода. Признаков два: фокус в текстовом поле и сжатие
 * visualViewport (клавиатура «съедает» высоту) — фокус надёжнее на Android,
 * сжатие — когда браузер оставляет фокус, а клавиатуру уже убрал.
 */
export function useKeyboardOpen() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let timer = 0;
    const apply = () => {
      // При масштабировании пальцем видимая высота тоже падает, и зум принимался за
      // клавиатуру — таббар пропадал. Поэтому сжатие учитываем только без зума.
      const squeezed = vv ? vv.scale < 1.05 && vv.height < window.innerHeight * 0.75 : false;
      root.classList.toggle('keyboard-open', isField(document.activeElement) || squeezed);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isField(e.target as Element)) root.classList.add('keyboard-open');
    };
    // Переход фокуса между полями даёт focusout → focusin: ждём, пока он завершится.
    const onFocusOut = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(apply, 80);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    vv?.addEventListener('resize', apply);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      vv?.removeEventListener('resize', apply);
      root.classList.remove('keyboard-open');
    };
  }, []);
}
