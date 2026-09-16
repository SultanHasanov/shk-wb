const { supabaseFetch, supabaseFetchWithMeta } = require('./_supabase');

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

async function accountMergePreview(userId) {
  const q = encodeURIComponent(userId);
  const [orders, stickers, history, licenses, cellLicenses, ledger, withdrawals, invited, referrals] = await Promise.all([
    supabaseFetchWithMeta(`payment_orders?user_id=eq.${q}&status=eq.succeeded&select=id&limit=1`),
    supabaseFetch(`sticker_access_codes?owner_user_id=eq.${q}&select=generation_limit,generation_used`),
    supabaseFetchWithMeta(`user_generation_history?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetchWithMeta(`license_keys?owner_user_id=eq.${q}&select=key&limit=1`),
    supabaseFetchWithMeta(`cell_print_licenses?owner_user_id=eq.${q}&select=key&limit=1`),
    supabaseFetchWithMeta(`referral_ledger?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetchWithMeta(`referral_withdrawals?user_id=eq.${q}&select=id&limit=1`),
    supabaseFetchWithMeta(`referral_attributions?referrer_user_id=eq.${q}&select=invited_user_id&limit=1`),
    supabaseFetch(`referral_accounts?user_id=eq.${q}&select=available_kopecks,reserved_kopecks,earned_kopecks,paid_kopecks,debt_kopecks&limit=1`),
  ]);
  const referral = referrals[0] || {};
  return {
    orders: orders.count || 0,
    history: history.count || 0,
    licenses: (licenses.count || 0) + (cellLicenses.count || 0),
    codes: stickers.length,
    generations: stickers.reduce((sum, row) => sum + Math.max(0, Number(row.generation_limit || 0) - Number(row.generation_used || 0)), 0),
    referralBalanceKopecks: Number(referral.available_kopecks || 0) + Number(referral.reserved_kopecks || 0),
    referralOperations: ledger.count || 0,
    referralWithdrawals: withdrawals.count || 0,
    invitedUsers: invited.count || 0,
  };
}

async function isTechnicalTelegramUser(userId) {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured');
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Unable to inspect Telegram account (${response.status})`);
  const user = await response.json();
  return /^telegram-[0-9]+@users[.]invalid$/i.test(String(user.email || ''));
}

module.exports = { accountHasValuableData, accountMergePreview, hasValuableAccountRows, isTechnicalTelegramUser };
