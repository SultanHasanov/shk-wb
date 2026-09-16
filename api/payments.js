const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { supabaseFetch } = require('../server/_supabase');
const {
  CELL_PRINT_PRICES,
  completeOrder,
  hasYookassa,
  LICENSE_PRICES,
  PACKAGE_PRICES,
  pricing,
  yookassa,
} = require('../server/_payments');
const { isAccessCode } = require('../server/_access-code');
const { enforceRateLimit } = require('../server/_rate-limit');
const { optionalUser, readReferralCookieDetails } = require('../server/_user-auth');
const { publicOrigin } = require('../server/_origin');
function publicOrder(row) {
  const program = row.product_kind === 'program',
    cellProgram = String(row.product_kind || '').startsWith('cell_print_');
  return {
    status: row.status,
    productKind: row.product_kind || 'stickers',
    quantity: Number(row.range_quantity || 0) + Number(row.custom_quantity || 0),
    rangeQuantity: row.range_quantity,
    customQuantity: row.custom_quantity,
    amount: Number(row.amount),
    accessCode: row.access_code,
    licenseKey: row.program_license_key || row.cell_print_license_key,
    licenseIterations: row.license_iterations,
    durationDays: row.cell_print_duration_days,
    deviceLimit: row.cell_print_device_limit,
    renewal: Boolean(row.renewal_target_key),
    downloadUrl:
      row.status === 'succeeded'
        ? cellProgram
          ? '/api/payments/download-cell-print'
          : program
            ? `/api/payments/download?token=${encodeURIComponent(row.public_token)}`
            : null
        : null,
    createdAt: row.created_at,
  };
}
async function getOrderBy(field, value) {
  const rows = await supabaseFetch(
    `payment_orders?${field}=eq.${encodeURIComponent(value)}&select=*&limit=1`,
  );
  return rows[0] || null;
}
async function maybeBindReferral(req, user) {
  const referral = readReferralCookieDetails(req);
  if (!user || !referral) return;
  await supabaseFetch('rpc/bind_referral', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: user.id,
      p_code: referral.code,
      p_captured_at: new Date(referral.capturedAt * 1000).toISOString(),
    }),
  }).catch(() => {});
}
module.exports = async function handler(req, res) {
  const action = String(req.query.action || '');
  try {
    if (action === 'config' && req.method === 'GET') {
      const settings = await supabaseFetch('payment_settings?select=enabled&id=eq.true&limit=1');
      return res.json({
        enabled: Boolean(settings[0]?.enabled && hasYookassa()),
        testMode: process.env.YOOKASSA_TEST_MODE !== 'false',
        packages: Object.entries(PACKAGE_PRICES).map(([quantity, total]) => ({
          quantity: Number(quantity),
          total,
        })),
        licensePackages: Object.entries(LICENSE_PRICES).map(([iterations, total]) => ({
          iterations: Number(iterations),
          total,
        })),
        cellPrintPrices: CELL_PRINT_PRICES,
      });
    }
    if (action === 'create' && req.method === 'POST') {
      if (
        !(await enforceRateLimit(req, res, {
          scope: 'payment-create',
          limit: 10,
          windowSeconds: 600,
        }))
      )
        return;
      const user = await optionalUser(req);
      await maybeBindReferral(req, user);
      const requestedKind = String(req.body?.productKind || '');
      const cellKinds = ['cell_print_program', 'cell_print_license', 'cell_print_bundle'];
      // Саму программу больше не продаём — установщик отдаётся свободно через
      // action=download-program. Заказы вида 'program' остались только в истории.
      if (requestedKind === 'program')
        return res.status(400).json({ error: 'Программа скачивается бесплатно' });
      const productKind =
        requestedKind === 'program_license'
          ? 'program_license'
          : cellKinds.includes(requestedKind)
            ? requestedKind
            : 'stickers';
      // Пул генераций общий, поэтому форма присылает одно число. Старый двухпакетный
      // формат ещё принимаем: вкладка со старым бандлом может оформить заказ уже
      // после деплоя, и такой заказ должен пройти, а не упасть на валидации.
      const legacyPacks = [
        Number(req.body?.rangeQuantity || 0),
        Number(req.body?.customQuantity || 0),
      ].filter(Boolean);
      const stickerPacks =
        Number(req.body?.quantity) > 0 ? [Number(req.body.quantity)] : legacyPacks;
      const licenseIterations = Number(req.body?.licenseIterations || 0);
      const cellDays = Number(req.body?.durationDays || 0),
        deviceLimit = Number(req.body?.deviceLimit || 0),
        promoCode = String(req.body?.promoCode || '')
          .trim()
          .toUpperCase();
      const renewalTargetKey = String(req.body?.renewalTargetKey || '')
        .trim()
        .toUpperCase();
      // Покупка из кабинета возвращает в кабинет, а не на публичную страницу.
      // Принимаем только фиксированный признак, а не URL от клиента: иначе это открытый редирект.
      const returnTarget = String(req.body?.returnTo || '');
      const resultPath = returnTarget === 'cabinet' ? '/cabinet/payment-result' : '/payment-result';
      if (returnTarget === 'telegram' && !user)
        return res.status(401).json({ error: 'Для оплаты через Telegram войдите в аккаунт' });
      const allowed = value =>
        Number.isInteger(value) && Object.prototype.hasOwnProperty.call(PACKAGE_PRICES, value);
      if (productKind === 'stickers' && (!stickerPacks.length || !stickerPacks.every(allowed)))
        return res.status(400).json({ error: 'Выберите один из доступных пакетов' });
      if (
        productKind === 'program_license' &&
        !Object.prototype.hasOwnProperty.call(LICENSE_PRICES, licenseIterations)
      )
        return res.status(400).json({ error: 'Выберите пакет итераций' });
      if (cellKinds.includes(productKind)) {
        if (productKind === 'cell_print_program') {
          if (cellDays !== 3 || deviceLimit !== 1)
            return res.status(400).json({ error: 'Некорректный пробный пакет' });
        } else if (!CELL_PRINT_PRICES[cellDays]?.[deviceLimit])
          return res.status(400).json({ error: 'Выберите срок и число устройств' });
      }
      if (renewalTargetKey) {
        if(!user)return res.status(401).json({ error: 'Для продления ключа войдите в аккаунт' });
        if (!['program_license', 'cell_print_license', 'stickers'].includes(productKind))
          return res.status(400).json({ error: 'Этот товар нельзя продлить' });
        if (productKind === 'stickers') {
          // Пополняем только свой код: он предъявительский, и промах в одной цифре
          // отправил бы оплаченные генерации чужому человеку.
          if (!isAccessCode(renewalTargetKey))
            return res.status(400).json({ error: 'Некорректный код доступа' });
          const owned = await supabaseFetch(
            `sticker_access_codes?code=eq.${encodeURIComponent(renewalTargetKey)}&owner_user_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=code&limit=1`,
          );
          if (!owned.length)
            return res.status(404).json({ error: 'Активный код для пополнения не найден' });
        } else if (productKind === 'program_license') {
          const owned = await supabaseFetch(
            `license_keys?key=eq.${encodeURIComponent(renewalTargetKey)}&owner_user_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=id,key&limit=1`,
          );
          if (!owned.length)
            return res.status(404).json({ error: 'Активный ключ для пополнения не найден' });
        } else {
          const owned = await supabaseFetch(
            `cell_print_licenses?key=eq.${encodeURIComponent(renewalTargetKey)}&owner_user_id=eq.${encodeURIComponent(user.id)}&active=eq.true&select=id,key,duration_days&limit=1`,
          );
          if (!owned.length)
            return res.status(404).json({ error: 'Активный ключ для продления не найден' });
          if (Number(owned[0].duration_days || 0) + cellDays > 4000)
            return res
              .status(409)
              .json({ error: 'Суммарный срок ключа не может превышать 4000 дней' });
          const activations = await supabaseFetch(
            `cell_print_activations?license_id=eq.${owned[0].id}&select=id`,
          );
          if (activations.length > deviceLimit)
            return res
              .status(409)
              .json({
                error: `Нельзя уменьшить лимит ниже ${activations.length}: сначала отвяжите лишние устройства`,
              });
        }
      }
      if (req.body?.accepted !== true)
        return res.status(400).json({ error: 'Необходимо принять оферту и политику' });
      const settings = await supabaseFetch('payment_settings?select=enabled&id=eq.true&limit=1');
      if (!settings[0]?.enabled || !hasYookassa())
        return res.status(503).json({ error: 'Оплата пока не подключена' });
      let calculated =
        productKind === 'program_license'
          ? {
              license: { iterations: licenseIterations, total: LICENSE_PRICES[licenseIterations] },
              total: LICENSE_PRICES[licenseIterations],
            }
          : cellKinds.includes(productKind)
            ? {
                cellPrint: {
                  durationDays: cellDays,
                  deviceLimit,
                  program: ['cell_print_program', 'cell_print_bundle'].includes(productKind),
                  bonusDays: productKind === 'cell_print_bundle' ? 3 : 0,
                },
                total:
                  (['cell_print_program', 'cell_print_bundle'].includes(productKind) ? 150 : 0) +
                  (productKind === 'cell_print_program'
                    ? 0
                    : CELL_PRINT_PRICES[cellDays][deviceLimit]),
              }
            : await pricing(stickerPacks);
      if (cellKinds.includes(productKind) && promoCode) {
        const scope =
          productKind === 'cell_print_program'
            ? 'program'
            : productKind === 'cell_print_license'
              ? 'license'
              : 'all';
        const promos = await supabaseFetch(
          `cell_print_promocodes?code=eq.${encodeURIComponent(promoCode)}&active=eq.true&select=discount_percent,scope,expires_at&limit=1`,
        );
        const promo = promos[0];
        if (
          !promo ||
          (promo.scope !== 'all' && promo.scope !== scope) ||
          (promo.expires_at && new Date(promo.expires_at) <= new Date())
        ) {
          const error = new Error('Промокод недействителен или уже использован');
          error.status = 400;
          throw error;
        }
        calculated.discountPercent = Number(promo.discount_percent);
        calculated.total = Math.round(calculated.total * (100 - calculated.discountPercent)) / 100;
      }
      const grossAmount = calculated.total;
      if (calculated.total < 0) return res.status(400).json({ error: 'Некорректная сумма' });
      const token = crypto.randomBytes(32).toString('base64url'),
        idempotence = crypto.randomUUID();
      const orderPayload = {
        public_token: token,
        range_quantity: productKind === 'stickers' ? stickerPacks[0] || 0 : 0,
        custom_quantity: productKind === 'stickers' ? stickerPacks[1] || 0 : 0,
        amount: calculated.total,
        gross_amount: grossAmount,
        pricing_snapshot: calculated,
        idempotence_key: idempotence,
        product_kind: productKind,
        user_id: user?.id || null,
        email: user?.email?.endsWith('@users.invalid') ? null : user?.email || null,
        provider_status: 'pending',
        fulfillment_status: 'pending',
      };
      if (productKind === 'program_license') orderPayload.license_iterations = licenseIterations;
      if (cellKinds.includes(productKind)) {
        orderPayload.cell_print_duration_days =
          cellDays + (productKind === 'cell_print_bundle' ? 3 : 0);
        orderPayload.cell_print_device_limit = deviceLimit;
        if (promoCode) orderPayload.promo_code = promoCode;
      }
      if(renewalTargetKey)orderPayload.renewal_target_key=renewalTargetKey;
      const inserted = await supabaseFetch('payment_orders', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(orderPayload),
      });
      let order = inserted[0];
      if (cellKinds.includes(productKind) && promoCode) {
        const scope =
          productKind === 'cell_print_program'
            ? 'program'
            : productKind === 'cell_print_license'
              ? 'license'
              : 'all';
        await supabaseFetch('rpc/reserve_cell_print_promo', {
          method: 'POST',
          body: JSON.stringify({ p_order_id: order.id, p_code: promoCode, p_scope: scope }),
        });
      }
      const requestedCredit = Math.max(
        0,
        Math.min(Number.MAX_SAFE_INTEGER, Number(req.body?.referralCreditKopecks || 0)),
      );
      if (user && requestedCredit > 0) {
        await supabaseFetch('rpc/apply_referral_credit', {
          method: 'POST',
          body: JSON.stringify({
            p_user_id: user.id,
            p_order_id: order.id,
            p_requested_kopecks: Math.floor(requestedCredit),
          }),
        });
        order = await getOrderBy('id', order.id);
      }
      calculated.total = Number(order.amount);
      if (calculated.total === 0) {
        await completeOrder(order, { status: 'succeeded', paid: true });
        return res
          .status(201)
          .json({ confirmationUrl: `${resultPath}?token=${encodeURIComponent(token)}`, token });
      }
      try {
        const description =
          productKind === 'program_license'
            ? `${renewalTargetKey ? 'Пополнение' : 'Ключ'} программы: ${licenseIterations} итераций, заказ ${order.id}`
            : cellKinds.includes(productKind)
              ? `${renewalTargetKey ? 'Продление' : 'Печать ячеек'}: ${cellDays} дней, ${deviceLimit} устройств, заказ ${order.id}`
              : `${renewalTargetKey ? 'Пополнение кода' : 'Пакет генераций'}: ${calculated.units} шт., заказ ${order.id}`;
        // YooKassa всегда возвращает на обычный HTTPS URL. Прямой t.me здесь
        // ломает возврат из некоторых банковских приложений и WebView Telegram.
        const telegramMarker = returnTarget === 'telegram' ? '&from=telegram' : '';
        const returnUrl = `${publicOrigin(req)}${resultPath}?token=${encodeURIComponent(token)}${telegramMarker}`;
        const payment = await yookassa('payments', {
          method: 'POST',
          headers: { 'Idempotence-Key': idempotence },
          body: JSON.stringify({
            amount: { value: calculated.total.toFixed(2), currency: 'RUB' },
            capture: true,
            confirmation: { type: 'redirect', return_url: returnUrl },
            description,
            metadata: { order_id: order.id, product_kind: productKind },
          }),
        });
        await supabaseFetch(`payment_orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            yookassa_payment_id: payment.id,
            status: payment.status,
            provider_status: payment.status,
            confirmation_url: payment.confirmation?.confirmation_url,
            updated_at: new Date().toISOString(),
          }),
        });
        return res
          .status(201)
          .json({ confirmationUrl: payment.confirmation?.confirmation_url, token });
      } catch (error) {
        await supabaseFetch(`payment_orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }),
        });
        throw error;
      }
    }
    if (action === 'promo' && req.method === 'POST') {
      if (
        !(await enforceRateLimit(req, res, {
          scope: 'program-promo',
          limit: 8,
          windowSeconds: 900,
        }))
      )
        return;
      if (req.body?.accepted !== true)
        return res.status(400).json({ error: 'Необходимо принять оферту и политику' });
      const promoCode = String(req.body?.promoCode || '')
        .trim()
        .toUpperCase();
      if (!/^[A-Z0-9_-]{3,32}$/.test(promoCode))
        return res.status(400).json({ error: 'Промокод недействителен или уже использован' });
      const token = crypto.randomBytes(32).toString('base64url');
      try {
        await supabaseFetch('rpc/redeem_program_promocode', {
          method: 'POST',
          body: JSON.stringify({ p_code: promoCode, p_public_token: token }),
        });
      } catch (error) {
        if (error.status === 400)
          return res.status(400).json({ error: 'Промокод недействителен или уже использован' });
        throw error;
      }
      return res
        .status(201)
        .json({ downloadUrl: `/api/payments/download?token=${encodeURIComponent(token)}` });
    }
    if (action === 'status' && req.method === 'GET') {
      const token = String(req.query.token || '');
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
        return res.status(400).json({ error: 'Некорректная ссылка заказа' });
      let order = await getOrderBy('public_token', token);
      if (!order) return res.status(404).json({ error: 'Заказ не найден' });
      if (order.yookassa_payment_id && order.fulfillment_status !== 'fulfilled') {
        const payment =
          order.provider_status === 'succeeded'
            ? { status: 'succeeded', paid: true }
            : await yookassa(`payments/${encodeURIComponent(order.yookassa_payment_id)}`);
        await supabaseFetch(`payment_orders?id=eq.${order.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            provider_status: payment.status,
            ...(payment.status === 'succeeded' ? {} : { status: payment.status }),
            updated_at: new Date().toISOString(),
          }),
        });
        order = await completeOrder(order, payment);
      }
      return res.json(publicOrder(order));
    }
    if (action === 'download' && req.method === 'GET') {
      const token = String(req.query.token || '');
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return res.status(400).end();
      let order = await getOrderBy('public_token', token);
      if (
        !order ||
        !['program', 'cell_print_program', 'cell_print_bundle'].includes(order.product_kind)
      )
        return res.status(404).end();
      if (order.fulfillment_status !== 'fulfilled' && order.yookassa_payment_id) {
        const payment = await yookassa(`payments/${encodeURIComponent(order.yookassa_payment_id)}`);
        order = await completeOrder(order, payment);
      }
      if (
        order.status !== 'succeeded' ||
        ['refunded', 'manual_review'].includes(order.refund_status)
      )
        return res.status(403).end();
      const isCell = order.product_kind.startsWith('cell_print_');
      const installer = path.join(
        __dirname,
        '_private',
        isCell ? 'cell-print-installer.exe' : 'program-installer.exe',
      );
      const stat = fs.statSync(installer);
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${isCell ? 'cell-print-1.2.1.exe' : 'program-windows-1.3.2.exe'}"`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return fs.createReadStream(installer).pipe(res);
    }
    // Скачивание «Подбора кодов» стало бесплатным: платными остались итерации,
    // без которых программа всё равно не ищет. Токеновый action=download выше
    // не трогаем — по нему качают ранее оплаченные заказы и промокоды.
    if (action === 'download-program' && req.method === 'GET') {
      const installer = path.join(__dirname, '_private', 'program-installer.exe');
      const stat = fs.statSync(installer);
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', 'attachment; filename="program-windows-1.3.2.exe"');
      res.setHeader('Cache-Control', 'no-store');
      return fs.createReadStream(installer).pipe(res);
    }
    if (action === 'download-cell-print' && req.method === 'GET') {
      const installer = path.join(__dirname, '_private', 'cell-print-installer.exe');
      const stat = fs.statSync(installer);
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', 'attachment; filename="cell-print-1.2.1.exe"');
      res.setHeader('Cache-Control', 'no-store');
      return fs.createReadStream(installer).pipe(res);
    }
    if (action === 'webhook' && req.method === 'POST') {
      if (String(req.body?.event || '').startsWith('refund.')) {
        const refundId = String(req.body?.object?.id || '');
        if (!refundId) return res.status(400).end();
        const refund = await yookassa(`refunds/${encodeURIComponent(refundId)}`);
        if (refund.status !== 'succeeded') return res.status(200).end();
        const refundedOrder = await getOrderBy(
          'yookassa_payment_id',
          String(refund.payment_id || ''),
        );
        if (!refundedOrder) return res.status(200).end();
        const kopecks = Math.round(Number(refund.amount?.value || 0) * 100);
        await supabaseFetch('rpc/reverse_referral_reward', {
          method: 'POST',
          body: JSON.stringify({
            p_order_id: refundedOrder.id,
            p_refund_kopecks: kopecks,
            p_event_key: `refund:${refundId}`,
          }),
        });
        await supabaseFetch('rpc/process_order_refund', {
          method: 'POST',
          body: JSON.stringify({
            p_order_id: refundedOrder.id,
            p_refund_kopecks: kopecks,
            p_event_key: `refund:${refundId}`,
          }),
        });
        return res.status(200).end();
      }
      const paymentId = String(req.body?.object?.id || '');
      if (!paymentId) return res.status(400).end();
      const payment = await yookassa(`payments/${encodeURIComponent(paymentId)}`);
      const order = await getOrderBy('yookassa_payment_id', paymentId);
      if (!order) return res.status(200).end();
      await supabaseFetch(`payment_orders?id=eq.${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider_status: payment.status,
          ...(payment.status === 'succeeded' ? {} : { status: payment.status }),
          updated_at: new Date().toISOString(),
        }),
      });
      await completeOrder(order, payment);
      return res.status(200).end();
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error.message, error.details || '');
    // Код успели отключить или отвязать между созданием заказа и оплатой: без этой
    // ветки человек видит голый 502 и не понимает, что чинить.
    if (String(JSON.stringify(error.details || '')).includes('Renewal target is unavailable'))
      return res
        .status(409)
        .json({
          error: 'Код для пополнения недоступен: проверьте, что он активен и принадлежит вам',
        });
    return res
      .status(error.status && error.status < 500 ? error.status : 502)
      .json({ error: error.message || 'Ошибка оплаты' });
  }
};
