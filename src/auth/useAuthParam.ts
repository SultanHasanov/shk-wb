import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type AuthMode, useStores } from '../stores/root-store';

const MODES: AuthMode[] = ['login', 'register', 'forgot'];

/**
 * `?auth=login|register|forgot` на публичной странице открывает модалку входа (старые адреса /login и /register
 * редиректят сюда, сервер возвращает с ошибкой OAuth как `?auth=login&oauth=error&reason=…`).
 * Параметры сразу стираются из адреса, остальной query и state сохраняются.
 */
export function useAuthParam() {
  const { ui } = useStores();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get('auth') as AuthMode | null;
    if (!mode || !MODES.includes(mode)) return;
    const oauthError = params.get('oauth') === 'error' ? params.get('reason') || 'failed' : undefined;
    const from = (location.state as { from?: string } | null)?.from;
    ui.openAuth(mode, { from, oauthError });
    for (const key of ['auth', 'oauth', 'reason']) params.delete(key);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, state: location.state });
  }, [location.hash, location.pathname, location.search, location.state, navigate, ui]);
}
