import { Alert, Button, Card } from '../ui';

export function CabinetLoading(){return <Card><div role="status">Загружаем данные кабинета…</div></Card>}
export function CabinetError({error,retry}:{error:unknown;retry:()=>void}){return <Alert tone="error"><div className="row"><span>{error instanceof Error?error.message:'Не удалось загрузить данные'}</span><Button variant="secondary" size="sm" onClick={retry}>Повторить</Button></div></Alert>}
