// Иконки программ на кнопках бота: свои эмодзи из набора t.me/addemoji/shkwb_apps_by_shkwb_bot
// (создан ботом 17.11.2026 из icon.png программ, 100×100). Telegram показывает их на кнопках только
// пока у владельца бота есть Telegram Premium. Если Premium закончится или кнопки начнут ломаться —
// BOT_APP_ICONS=0 в .env обоих серверов, и кнопки вернутся к обычным эмодзи 💻/🖨.
const ICONS = {
  helper: { id: '5469821325981821893', fallback: '💻' },
  cellprint: { id: '5469891870819659663', fallback: '🖨' },
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

module.exports = { appButton };
