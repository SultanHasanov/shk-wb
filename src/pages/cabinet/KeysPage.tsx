import { useState } from 'react';
import { Copy, Download, KeyRound, RefreshCw, Unlink } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Progress, Table, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, type CellPrintAsset, type UserAsset, useCabinet, useCabinetMutation } from '../../api/cabinet';
import { CELL_PRINT_DOWNLOAD_URL, PROGRAM_DOWNLOAD_URL } from '../../lib/downloads';
import { useDocumentMeta } from '../../lib/seo';
import { LicenseCheckoutModal, type LicenseCheckout } from './LicenseCheckoutModal';
import { type T, useT } from '../../i18n';

function assetStatus(asset: UserAsset, t: T) {
  if (!asset.active) return { label: t('Отключён', 'Өшірілген'), tone: 'error' as const };
  if (asset.type === 'cell_print' && asset.expiresAt && new Date(asset.expiresAt) < new Date()) {
    return { label: t('Истёк', 'Мерзімі өтті'), tone: 'error' as const };
  }
  return { label: t('Активен', 'Белсенді'), tone: 'success' as const };
}

const marketplaceLabel = (scope?: CellPrintAsset['marketplaceScope']) => ({
  wb: 'Wildberries',
  ozon: 'Ozon',
  both: 'Wildberries + Ozon',
  legacy_unassigned: 'Wildberries',
}[scope ?? 'legacy_unassigned']);

function DetachDeviceButton({ id, onDone }: { id: number; onDone: () => void }) {
  const mutation = useCabinetMutation<void>(`/api/cabinet/devices/${id}`, 'DELETE');
  const t = useT();
  return <Button variant="ghost" size="sm" loading={mutation.isPending} onClick={() => mutation.mutate(undefined, { onSuccess: onDone })}><Unlink size={15} />{t('Отвязать', 'Ажырату')}</Button>;
}

export function KeysPage() {
  const t = useT();
  useDocumentMeta(t('Ключи и доступы — кабинет', 'Кілттер мен қолжетімділік — кабинет'));
  const query = useCabinet();
  const toast = useToast();
  const [devices, setDevices] = useState<CellPrintAsset | null>(null);
  const [claim, setClaim] = useState('');
  const [checkout, setCheckout] = useState<LicenseCheckout | null>(null);
  const claimMutation = useCabinetMutation<{ kind: 'program' | 'cell_print'; value: string }>('/api/cabinet/assets/claim');

  if (query.isPending) return <div className="page"><CabinetLoading /></div>;
  if (query.isError) return <div className="page"><CabinetError error={query.error} retry={() => query.refetch()} /></div>;

  const assets = query.data.assets.filter(asset => asset.type !== 'sticker');
  const submitClaim = (kind: 'program' | 'cell_print') => claimMutation.mutate({ kind, value: claim }, { onSuccess: () => { setClaim(''); toast(t('Ключ добавлен', 'Кілт қосылды'), 'success'); } });

  return <div className="page">
    <header className="page-head"><h1>{t('Ключи и доступы', 'Кілттер мен қолжетімділік')}</h1><p>{t('Покупайте программы и ключи, пополняйте итерации и продлевайте срок лицензий.', 'Бағдарламалар мен кілттерді сатып алыңыз, итерацияларды толықтырып, лицензия мерзімін ұзартыңыз.')}</p></header>

    <div className="grid grid-2">
      <Card accent><div className="stack">
        <div className="row"><h2 style={{ margin: 0 }}>{t('Пакеты подборов', 'Іріктеу пакеттері')}</h2><Badge tone="success">{t('Скачивание бесплатно', 'Жүктеу тегін')}</Badge></div>
        <p className="muted" style={{ margin: 0 }}>{t('Подборы кода сверх месячного лимита подписки «Помощник ПВЗ». Пакет не сгорает, подбор списывается только за найденный код.', '«ПВЗ көмекшісі» жазылымының айлық лимитінен тыс код іріктеулері. Пакеттің мерзімі өтпейді, іріктеу тек табылған код үшін есептеледі.')}</p>
        <div className="row">
          <a href={PROGRAM_DOWNLOAD_URL}><Button><Download size={16} />{t('Скачать программу', 'Бағдарламаны жүктеп алу')}</Button></a>
          <Button variant="secondary" onClick={() => setCheckout({ kind: 'program_license' })}><KeyRound size={16} />{t('Купить пакет', 'Пакет сатып алу')}</Button>
        </div>
      </div></Card>

      <Card accent><div className="stack">
        <div className="row"><h2 style={{ margin: 0 }}>{t('Печать ячеек', 'Ұяшық басып шығару')}</h2><Badge tone="success">{t('Скачивание бесплатно', 'Жүктеу тегін')}</Badge></div>
        <p className="muted" style={{ margin: 0 }}>{t('Выберите срок и число компьютеров. Лицензия начинает действовать при первой активации.', 'Мерзім мен компьютерлер санын таңдаңыз. Лицензия алғашқы белсендіруден бастап жарамды.')}</p>
        <div className="row">
          <a href={CELL_PRINT_DOWNLOAD_URL}><Button><Download size={16} />{t('Скачать программу', 'Бағдарламаны жүктеп алу')}</Button></a>
          <Button variant="secondary" onClick={() => setCheckout({ kind: 'cell_print_license' })}><KeyRound size={16} />{t('Купить пакет', 'Пакет сатып алу')}</Button>
        </div>
      </div></Card>
    </div>

    <Card className="section"><div className="row">
      <Field label={t('Добавить ранее купленный ключ', 'Бұрын сатып алынған кілтті қосу')}><Input value={claim} onChange={event => setClaim(event.target.value.toUpperCase())} placeholder="CP-… или WBPK-…" /></Field>
      <Button variant="secondary" disabled={!claim} onClick={() => submitClaim(claim.startsWith('CP-') ? 'cell_print' : 'program')}>{t('Добавить', 'Қосу')}</Button>
    </div>{claimMutation.isError && <p className="error">{claimMutation.error.message}</p>}</Card>

    <div className="stack-lg section">{assets.length ? assets.map(asset => {
      const status = assetStatus(asset, t);
      const used = asset.type === 'program' ? asset.used : asset.devices.length;
      const total = asset.type === 'program' ? asset.total : asset.deviceLimit;
      return <Card key={`${asset.type}:${asset.key}`}>
        <div className="row"><strong className="mono">{asset.key}</strong><Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(asset.key); toast(t('Ключ скопирован', 'Кілт көшірілді'), 'success'); }}><Copy size={15} />{t('Копировать', 'Көшіру')}</Button><Badge>{asset.label}</Badge>{asset.type === 'cell_print' && <Badge>{marketplaceLabel(asset.marketplaceScope)}</Badge>}<Badge tone={status.tone}>{status.label}</Badge></div>
        <div className="grid grid-3 section">
          <div><strong>{asset.type === 'cell_print' ? t(`${asset.durationDays} дней`, `${asset.durationDays} күн`) : t('Без срока', 'Мерзімсіз')}</strong><div className="muted">{t('срок ключа', 'кілт мерзімі')}</div></div>
          <div><strong>{asset.type === 'cell_print' ? asset.expiresAt ? dateTime(asset.expiresAt) : t('После первой активации', 'Алғашқы белсендіруден кейін') : t(`${Math.max(0, asset.total - asset.used)} итераций`, `${Math.max(0, asset.total - asset.used)} итерация`)}</strong><div className="muted">{t('остаток / окончание', 'қалдық / аяқталуы')}</div></div>
          <Progress value={used} max={Math.max(1, total)} label={<><span>{asset.type === 'program' ? t('Использовано', 'Пайдаланылды') : t('Устройства', 'Құрылғылар')}</span><strong>{t(`${used} из ${total}`, `${total} ішінен ${used}`)}</strong></>} />
        </div>
        <div className="row">
          {asset.type === 'cell_print' && <Button variant="secondary" onClick={() => setDevices(asset)}>{t('Устройства', 'Құрылғылар')}</Button>}
          {asset.active && asset.type === 'program' && <Button onClick={() => setCheckout({ kind: 'program_license', targetKey: asset.key })}><RefreshCw size={16} />{t('Пополнить итерации', 'Итерацияларды толықтыру')}</Button>}
          {asset.active && asset.type === 'cell_print' && <Button onClick={() => setCheckout({ kind: 'cell_print_license', targetKey: asset.key, deviceLimit: asset.deviceLimit, activeDevices: asset.devices.length, marketplaceScope: asset.marketplaceScope === 'ozon' || asset.marketplaceScope === 'both' ? asset.marketplaceScope : 'wb' })}><RefreshCw size={16} />{t('Продлить', 'Ұзарту')}</Button>}
        </div>
      </Card>;
    }) : <Card><EmptyState icon={<KeyRound />} title={t('Ключей пока нет', 'Әзірге кілттер жоқ')} text={t('Купите новый ключ или добавьте ранее приобретённый.', 'Жаңа кілт сатып алыңыз немесе бұрын алынғанын қосыңыз.')} /></Card>}</div>

    <Modal open={Boolean(devices)} onOpenChange={open => !open && setDevices(null)} title={t('Устройства ключа', 'Кілт құрылғылары')}>
      {devices?.devices.length ? <Table><thead><tr><th>{t('Устройство', 'Құрылғы')}</th><th>{t('Последняя активность', 'Соңғы белсенділік')}</th><th /></tr></thead><tbody>{devices.devices.map(device => <tr key={device.id}><td>{device.name}</td><td>{dateTime(device.lastSeenAt)}</td><td><DetachDeviceButton id={device.id} onDone={() => setDevices(null)} /></td></tr>)}</tbody></Table> : <EmptyState title={t('Устройств нет', 'Құрылғылар жоқ')} text={t('Они появятся после активации программы.', 'Олар бағдарлама белсендірілгеннен кейін пайда болады.')} />}
    </Modal>

    {checkout && <LicenseCheckoutModal key={`${checkout.kind}:${'targetKey' in checkout ? checkout.targetKey ?? 'new' : 'software'}`} checkout={checkout} availableKopecks={query.data.referral.availableKopecks} onClose={() => setCheckout(null)} />}
  </div>;
}
