import { Alert, Button, Card } from '../ui';
import { useT } from '../i18n';

export function CabinetLoading(){const t=useT();return <Card><div role="status">{t('Загружаем данные кабинета…','Кабинет деректерін жүктеп жатырмыз…')}</div></Card>}
export function CabinetError({error,retry}:{error:unknown;retry:()=>void}){const t=useT();return <Alert tone="error"><div className="row"><span>{error instanceof Error?error.message:t('Не удалось загрузить данные','Деректерді жүктеу мүмкін болмады')}</span><Button variant="secondary" size="sm" onClick={retry}>{t('Повторить','Қайталау')}</Button></div></Alert>}
