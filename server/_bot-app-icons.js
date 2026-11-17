// Иконки программ на кнопках и в текстах бота: свои эмодзи из набора t.me/addemoji/shkwb_apps_by_shkwb_bot
// (создан ботом 17.11.2026 из icon.png программ, 100×100). Telegram показывает их на кнопках только
// пока у владельца бота есть Telegram Premium. Если Premium закончится или кнопки начнут ломаться —
// BOT_APP_ICONS=0 в .env обоих серверов, и кнопки вернутся к обычным эмодзи 💻/🖨/🏷.
const ICONS = {
  helper: { id: '5469821325981821893', fallback: '💻' },
  cellprint: { id: '5469891870819659663', fallback: '🖨' },
  // Товарный стикер (этикетка со штрихкодом) — кнопки стикеров; добавлен 17.11.2026.
  sticker: { id: '5467730836549842352', fallback: '🏷' },
};

function iconsEnabled() {
  return String(process.env.BOT_APP_ICONS || '').trim() !== '0';
}

/** Кнопка с иконкой программы: appButton('helper', 'Помощник ПВЗ', { callback_data: 'menu:helper' }). */
function appButton(app, text, action) {
  const icon = ICONS[app];
  if (!icon || !iconsEnabled()) return { text: `${icon ? `${icon.fallback} ` : ''}${text}`, ...action };
  return { text, icon_custom_emoji_id: icon.id, ...action };
}

/** Иконка в тексте сообщения (parse_mode HTML): `${appEmoji('helper')} Помощник ПВЗ`. */
function appEmoji(app) {
  const icon = ICONS[app];
  if (!icon) return '';
  return iconsEnabled() ? `<tg-emoji emoji-id="${icon.id}">${icon.fallback}</tg-emoji>` : icon.fallback;
}

module.exports = { appButton, appEmoji };
