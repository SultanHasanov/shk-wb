import { useState } from 'react';
import { Copy, Download, KeyRound, RefreshCw, Unlink } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Progress, Table, useToast } from '../../ui';
import { CabinetError, CabinetLoading } from '../../components/CabinetState';
import { dateTime, type CellPrintAsset, type UserAsset, useCabinet, useCabinetMutation } from '../../api/cabinet';
import { CELL_PRINT_DOWNLOAD_URL, PROGRAM_DOWNLOAD_URL } from '../../lib/downloads';
import { useDocumentMeta } from '../../lib/seo';
import { LicenseCheckoutModal, type LicenseCheckout } from './LicenseCheckoutModal';

function assetStatus(asset: UserAsset) {
  if (!asset.active) return { label: 'Отключён', tone: 'error' as const };
  if (asset.type === 'cell_print' && asset.expiresAt && new Date(asset.expiresAt) < new Date()) {
    return { label: 'Истёк', tone: 'error' as const };
  }
  return { label: 'Активен', tone: 'success' as const };
}

const marketplaceLabel = (scope?: CellPrintAsset['marketplaceScope']) => ({
  wb: 'Wildberries',
  ozon: 'Ozon',
  both: 'Wildberries + Ozon',
  legacy_unassigned: 'Wildberries',
}[scope ?? 'legacy_unassigned']);

function DetachDeviceButton({ id, onDone }: { id: number; onDone: () => void }) {
  const mutation = useCabinetMutation<void>(`/api/cabinet/devices/${id}`, 'DELETE');
  return <Button variant="ghost" size="sm" loading={mutation.isPending} onClick={() => mutation.mutate(undefined, { onSuccess: onDone })}><Unlink size={15} />Отвязать</Button>;
}

export function KeysPage() {
  useDocumentMeta('Ключи и доступы — кабинет');
  const query = useCabinet();
  const toast = useToast();
  const [devices, setDevices] = useState<CellPrintAsset | null>(null);
  const [claim, setClaim] = useState('');
  const [checkout, setCheckout] = useState<LicenseCheckout | null>(null);
  const claimMutation = useCabinetMutation<{ kind: 'program' | 'cell_print'; value: string }>('/api/cabinet/assets/claim');

  if (query.isPending) return <div className="page"><CabinetLoading /></div>;
  if (query.isError) return <div className="page"><CabinetError error={query.error} retry={() => query.refetch()} /></div>;

  const assets = query.data.assets.filter(asset => asset.type !== 'sticker');
  const submitClaim = (kind: 'program' | 'cell_print') => claimMutation.mutate({ kind, value: claim }, { onSuccess: () => { setClaim(''); toast('Ключ добавлен', 'success'); } });

  return <div className="page">
    <header className="page-head"><h1>Ключи и доступы</h1><p>Покупайте программы и ключи, пополняйте итерации и продлевайте срок лицензий.</p></header>

    <div className="grid grid-2">
      <Card accent><div className="stack">
        <div className="row"><h2 style={{ margin: 0 }}>Подбор кодов</h2><Badge tone="success">Скачивание бесплатно</Badge></div>
        <p className="muted" style={{ margin: 0 }}>Программа скачивается бесплатно. Итерации успешного подбора добавляются отдельными пакетами.</p>
        <div className="row">
          <a href={PROGRAM_DOWNLOAD_URL}><Button><Download size={16} />Скачать программу</Button></a>
          <Button variant="secondary" onClick={() => setCheckout({ kind: 'program_license' })}><KeyRound size={16} />Купить новый ключ</Button>
        </div>
      </div></Card>

      <Card accent><div className="stack">
        <div className="row"><h2 style={{ margin: 0 }}>Печать ячеек</h2><Badge tone="success">Скачивание бесплатно</Badge></div>
        <p className="muted" style={{ margin: 0 }}>Выберите срок и число компьютеров. Лицензия начинает действовать при первой активации.</p>
        <div className="row">
          <a href={CELL_PRINT_DOWNLOAD_URL}><Button><Download size={16} />Скачать программу</Button></a>
          <Button variant="secondary" onClick={() => setCheckout({ kind: 'cell_print_license' })}><KeyRound size={16} />Купить новый ключ</Button>
        </div>
      </div></Card>
    </div>

    <Card className="section"><div className="row">
      <Field label="Добавить ранее купленный ключ"><Input value={claim} onChange={event => setClaim(event.target.value.toUpperCase())} placeholder="CP-… или WBPK-…" /></Field>
      <Button variant="secondary" disabled={!claim} onClick={() => submitClaim(claim.startsWith('CP-') ? 'cell_print' : 'program')}>Добавить</Button>
    </div>{claimMutation.isError && <p className="error">{claimMutation.error.message}</p>}</Card>

    <div className="stack-lg section">{assets.length ? assets.map(asset => {
      const status = assetStatus(asset);
      const used = asset.type === 'program' ? asset.used : asset.devices.length;
      const total = asset.type === 'program' ? asset.total : asset.deviceLimit;
      return <Card key={`${asset.type}:${asset.key}`}>
        <div className="row"><strong className="mono">{asset.key}</strong><Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(asset.key); toast('Ключ скопирован', 'success'); }}><Copy size={15} />Копировать</Button><Badge>{asset.label}</Badge>{asset.type === 'cell_print' && <Badge>{marketplaceLabel(asset.marketplaceScope)}</Badge>}<Badge tone={status.tone}>{status.label}</Badge></div>
        <div className="grid grid-3 section">
          <div><strong>{asset.type === 'cell_print' ? `${asset.durationDays} дней` : 'Без срока'}</strong><div className="muted">срок ключа</div></div>
          <div><strong>{asset.type === 'cell_print' ? asset.expiresAt ? dateTime(asset.expiresAt) : 'После первой активации' : `${Math.max(0, asset.total - asset.used)} итераций`}</strong><div className="muted">остаток / окончание</div></div>
          <Progress value={used} max={Math.max(1, total)} label={<><span>{asset.type === 'program' ? 'Использовано' : 'Устройства'}</span><strong>{used} из {total}</strong></>} />
        </div>
        <div className="row">
          {asset.type === 'cell_print' && <Button variant="secondary" onClick={() => setDevices(asset)}>Устройства</Button>}
          {asset.active && asset.type === 'program' && <Button onClick={() => setCheckout({ kind: 'program_license', targetKey: asset.key })}><RefreshCw size={16} />Пополнить итерации</Button>}
          {asset.active && asset.type === 'cell_print' && <Button onClick={() => setCheckout({ kind: 'cell_print_license', targetKey: asset.key, deviceLimit: asset.deviceLimit, activeDevices: asset.devices.length, marketplaceScope: asset.marketplaceScope === 'ozon' || asset.marketplaceScope === 'both' ? asset.marketplaceScope : 'wb' })}><RefreshCw size={16} />Продлить</Button>}
        </div>
      </Card>;
    }) : <Card><EmptyState icon={<KeyRound />} title="Ключей пока нет" text="Купите новый ключ или добавьте ранее приобретённый." /></Card>}</div>

    <Modal open={Boolean(devices)} onOpenChange={open => !open && setDevices(null)} title="Устройства ключа">
      {devices?.devices.length ? <Table><thead><tr><th>Устройство</th><th>Последняя активность</th><th /></tr></thead><tbody>{devices.devices.map(device => <tr key={device.id}><td>{device.name}</td><td>{dateTime(device.lastSeenAt)}</td><td><DetachDeviceButton id={device.id} onDone={() => setDevices(null)} /></td></tr>)}</tbody></Table> : <EmptyState title="Устройств нет" text="Они появятся после активации программы." />}
    </Modal>

    {checkout && <LicenseCheckoutModal key={`${checkout.kind}:${'targetKey' in checkout ? checkout.targetKey ?? 'new' : 'software'}`} checkout={checkout} availableKopecks={query.data.referral.availableKopecks} onClose={() => setCheckout(null)} />}
  </div>;
}
