import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminApi, adminKeys, type AdminAppCodeViaBot } from '../../api/admin';

/**
 * Действия страниц админки, которым нужна причина для журнала (контракт 0.4, 8.8),
 * а у общих хуков из src/api/admin.ts тела для неё нет: DELETE ресурса уходит без
 * тела, флаг «код клиента через бот» — голым boolean. Здесь те же запросы, но с
 * `reason` в теле; сервер читает её из `req.body.reason`.
 */
const RESOURCE = '/api/admin/data?resource=';

/** Удаление записи типового ресурса (ключ, промокод, объявление, код, активация) с причиной. */
export function useRemoveWithReason(resource: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number | string; reason: string }) =>
      adminApi(`${RESOURCE}${resource}&id=${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.resource(resource) }),
  });
}

/** Флаг «код клиента только через бот» — опасное действие, поэтому с причиной. */
export function useSetCodeViaBotWithReason() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ enabled, reason }: { enabled: boolean; reason: string }) =>
      adminApi<AdminAppCodeViaBot>(`${RESOURCE}appCodeViaBot`, {
        method: 'POST',
        body: JSON.stringify({ enabled, reason }),
      }),
    onSuccess: data => queryClient.setQueryData(['admin', 'app-code-via-bot'], data),
  });
}
