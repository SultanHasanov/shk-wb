const { supabaseFetch } = require('./_supabase');

function hasValuableAccountRows(rows) {
  return Boolean(
    rows.orders.length || rows.stickers.length || rows.licenses.length || rows.cellLicenses.length ||
    rows.history.length || rows.requests.length || rows.ledger.length || rows.withdrawals.length ||
    rows.invited.length || rows.referrals.some(account =>
      ['available_kopecks', 'reserved_kopecks', 'earned_kopecks', 'paid_kopecks', 'debt_kopecks']
        .some(field => Number(account[field] || 0) !== 0),
    ),
  );
}

async function accountHasValuableData(userId) {
  const q = encodeURIComponent(userId);
  const [orders, stickers, licenses, cellLicenses, history, requests, ledger, withdrawals, invited, referrals] = await Promise.all([
    supabaseFetch(`payment_orders?user_id=eq.${q}&status=in.(waiting_for_capture,succeeded)&select=id&limit=1`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${q}&select=code&limit=1`),
    supabaseFetch(`license_keys?owner_user_id=eq.${q}&select=key&limit=1`),
    supabaseFetch(`cell_print_licenses?owner_user_id=eq.${q}&select=key&limit=1`),
    supabaseFetch(`user_generation_history?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetch(`telegram_generation_requests?user_id=eq.${q}&status=in.(processing,completed)&select=request_id&limit=1`),
    supabaseFetch(`referral_ledger?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetch(`referral_withdrawals?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetch(`referral_attributions?referrer_user_id=eq.${q}&select=invited_user_id&limit=1`),
    supabaseFetch(`referral_accounts?user_id=eq.${q}&select=available_kopecks,reserved_kopecks,earned_kopecks,paid_kopecks,debt_kopecks&limit=1`),
  ]);
  return hasValuableAccountRows({ orders, stickers, licenses, cellLicenses, history, requests, ledger, withdrawals, invited, referrals });
}

module.exports = { accountHasValuableData, hasValuableAccountRows };
