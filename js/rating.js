(function() {
  'use strict';

  const PAGE_SIZE = 10;
  const section = document.getElementById('rating-section');
  const pointSelect = document.getElementById('rating-point-select');
  const refreshPointsBtn = document.getElementById('rating-refresh-points');
  const loadBtn = document.getElementById('rating-load-btn');
  const moreBtn = document.getElementById('rating-more-btn');
  const errorEl = document.getElementById('rating-error');
  const summary = document.getElementById('rating-summary');
  const currentRating = document.getElementById('rating-current');
  const regionRating = document.getElementById('rating-region');
  const totalReviews = document.getElementById('rating-total');
  const list = document.getElementById('rating-list');
  const empty = document.getElementById('rating-empty');

  let points = [];
  let offset = 0;
  let total = 0;
  let reviewLoading = false;

  function decodeWbClientId(ratingId) {
    const match = String(ratingId || '').match(/^([0-9a-f]{8})-/i);
    if (!match) throw new Error('Некорректный ID оценки WB');
    return Number.parseInt(match[1], 16);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getErrorMessage(data, fallback) {
    return data?.message || data?.error || data?.details || fallback;
  }

  async function ratingRequest(url, options = {}) {
    const token = window.WBAuth?.getAccessToken();
    if (!token) throw new Error('Сначала войдите в аккаунт WB');

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) window.WBAuth?.logout();
      throw new Error(getErrorMessage(data, `Ошибка HTTP ${response.status}`));
    }
    return data;
  }

  function setLoading(button, state, text) {
    button.disabled = state;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = state ? text : button.dataset.label;
  }

  function selectedPoint() {
    const id = Number(pointSelect.value);
    return points.find((point) => Number(point.external_id) === id) || null;
  }

  function renderPoints() {
    pointSelect.innerHTML = '';
    if (!points.length) {
      pointSelect.innerHTML = '<option value="">Доступные ПВЗ не найдены</option>';
      loadBtn.disabled = true;
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Выберите ПВЗ';
    placeholder.selected = true;
    pointSelect.appendChild(placeholder);

    points.forEach((point) => {
      const option = document.createElement('option');
      option.value = String(point.external_id);
      option.textContent = `${point.address || 'ПВЗ'} · ID ${point.external_id}`;
      pointSelect.appendChild(option);
    });
    loadBtn.disabled = true;
  }

  async function loadPoints() {
    errorEl.textContent = '';
    points = [];
    pointSelect.innerHTML = '<option value="">Загрузка списка ПВЗ…</option>';
    list.innerHTML = '';
    summary.hidden = true;
    empty.hidden = true;
    moreBtn.hidden = true;
    setLoading(refreshPointsBtn, true, 'Загрузка…');
    loadBtn.disabled = true;
    try {
      const result = await ratingRequest('/api/rating?action=points', {
        method: 'POST',
        body: JSON.stringify({
          pickup_point_ids: [],
          limit: 11,
          offset: 0,
          only_disputable: false,
        }),
      });
      points = Array.isArray(result?.data) ? result.data : [];
      renderPoints();
    } catch (error) {
      points = [];
      renderPoints();
      errorEl.textContent = error.message;
    } finally {
      setLoading(refreshPointsBtn, false, '');
      loadBtn.disabled = !pointSelect.value;
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Дата не указана';
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  }

  function renderReview(review) {
    let clientId;
    try {
      clientId = decodeWbClientId(review.id);
    } catch {
      clientId = '—';
    }

    const article = document.createElement('article');
    article.className = 'rating-review';
    article.innerHTML = `
      <div class="rating-review-top">
        <span class="rating-date">${escapeHtml(formatDate(review.rate_dt))}</span>
        <span class="rating-stars">★ ${escapeHtml(review.stars ?? '—')}</span>
      </div>
      <p class="rating-comment ${review.comment ? '' : 'rating-comment-muted'}">
        ${escapeHtml(review.comment || 'Комментарий не оставлен')}
      </p>
      <div class="rating-meta">
        <span>Вес оценки: ${escapeHtml(review.weight ?? '—')}</span>
        ${review.user_name ? `<span>${escapeHtml(review.user_name)}</span>` : ''}
        ${review.reasons_text?.length
          ? `<span>${escapeHtml(review.reasons_text.join(', '))}</span>`
          : ''}
      </div>
      <div class="rating-review-footer">
        <span class="rating-date">ID оценки: ${escapeHtml(review.id || '—')}</span>
        <span class="rating-client-id">
          ID клиента: ${escapeHtml(clientId)}
          <button
            class="rating-copy-btn"
            type="button"
            data-client-id="${escapeHtml(clientId)}"
            ${clientId === '—' ? 'disabled' : ''}
          >Копировать</button>
        </span>
      </div>
    `;
    list.appendChild(article);
  }

  function updateSummary(point) {
    currentRating.textContent = point?.rating ?? '—';
    regionRating.textContent = point?.region_rating ?? '—';
    totalReviews.textContent = String(total);
    summary.hidden = false;
  }

  async function loadReviews(reset) {
    if (reviewLoading || !pointSelect.value) return;
    reviewLoading = true;
    if (reset) {
      offset = 0;
      total = 0;
      list.innerHTML = '';
      empty.hidden = true;
      moreBtn.hidden = true;
    }

    errorEl.textContent = '';
    const button = reset ? loadBtn : moreBtn;
    setLoading(button, true, 'Загрузка…');
    try {
      const params = new URLSearchParams({
        action: 'reviews',
        point_id: pointSelect.value,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const result = await ratingRequest(`/api/rating?${params}`, { method: 'GET' });
      const reviews = Array.isArray(result?.data) ? result.data : [];
      total = Number(result?.total) || reviews.length;
      reviews.forEach(renderReview);
      offset += reviews.length;
      updateSummary(selectedPoint());
      empty.hidden = total !== 0;
      moreBtn.hidden = offset >= total || reviews.length === 0;
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      setLoading(button, false, '');
      reviewLoading = false;
    }
  }

  async function copyClientId(button) {
    const value = button.dataset.clientId;
    if (!value || value === '—') return;
    try {
      await navigator.clipboard.writeText(value);
      const oldText = button.textContent;
      button.textContent = 'Скопировано';
      setTimeout(() => { button.textContent = oldText; }, 1400);
    } catch {
      errorEl.textContent = 'Не удалось скопировать ID';
    }
  }

  function syncAuthState() {
    const loggedIn = Boolean(window.WBAuth?.isLoggedIn());
    section.hidden = !loggedIn;
    if (loggedIn && !points.length) loadPoints();
    if (!loggedIn) {
      points = [];
      list.innerHTML = '';
      summary.hidden = true;
      moreBtn.hidden = true;
    }
  }

  refreshPointsBtn.addEventListener('click', loadPoints);
  loadBtn.addEventListener('click', () => loadReviews(true));
  moreBtn.addEventListener('click', () => loadReviews(false));
  pointSelect.addEventListener('change', () => {
    loadBtn.disabled = !pointSelect.value;
    list.innerHTML = '';
    summary.hidden = true;
    moreBtn.hidden = true;
    empty.hidden = true;
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.rating-copy-btn');
    if (button) copyClientId(button);
  });
  window.addEventListener('wb-auth-change', syncAuthState);

  window.WBRating = { decodeWbClientId, loadPoints, loadReviews };
  syncAuthState();
})();
