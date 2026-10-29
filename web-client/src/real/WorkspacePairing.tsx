import { useEffect, useRef, useState } from 'react';
import { ConnectionRegistry, RUNTIME_NAME_MAX_LENGTH } from '../adapter/connections';
import { createPairingIdentity, type PairingIdentity } from '../adapter/client-pairing';
import { useI18n } from '../i18n/I18nProvider';
import { messageOf } from './contracts';

export function WorkspacePairing({
  registry,
  onPaired,
  onError,
  onDirtyChange,
}: {
  registry: ConnectionRegistry;
  onPaired: (id: string) => void;
  onError: (e: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const [address, setAddress] = useState("http://127.0.0.1:14317");
  const [name, setName] = useState<string>();
  const [runtimeName, setRuntimeName] = useState('');
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<PairingIdentity>();
  const [clientCode, setClientCode] = useState('');
  const identityRef = useRef<PairingIdentity | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  const [pairError, setPairError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const clientTicket = useRef(0);
  const attempt = useRef(0);
  useEffect(() => { onDirtyChange?.(address !== 'http://127.0.0.1:14317' || !!name || !!runtimeName || !!identity); }, [address, name, runtimeName, identity, onDirtyChange]);
  useEffect(
    () => () => {
      attempt.current++;
      clientTicket.current++;
      controllerRef.current?.abort();
      identityRef.current?.dispose();
    },
    [],
  );
  return (
    <div className="runtime-pairing">
      <p className="runtime-intro">{t('Connect a Workspace to manage projects and Work Graphs in this browser.')}</p>
      <section className="runtime-step" aria-labelledby="pairing-authorize-title">
      <h4 id="pairing-authorize-title"><span className="runtime-step-number">1</span>{t('Enter the address and authorize')}</h4>
      <p>{t('Enter the address of the Workspace device, then generate a client code.')}</p>
        <label>
          {t('Workspace address')}
          <input
            form="runtime-pairing-form"
            type="url"
            required
            disabled={generating || busy}
            value={address}
            onChange={(e) => {
              attempt.current++;
              if (e.target.value !== address) {
                clientTicket.current++; controllerRef.current?.abort(); controllerRef.current = undefined; identityRef.current?.dispose(); identityRef.current = undefined;
                setIdentity(undefined); setClientCode(''); setCopyStatus('');
              }
              setAddress(e.target.value);
              setBusy(false);
            }}
          />
        </label>
        <label>
          {t('Workspace name')}
          <input disabled={generating || busy} maxLength={RUNTIME_NAME_MAX_LENGTH} value={runtimeName} placeholder={address} onChange={(e) => setRuntimeName(e.target.value)} />
        </label>
        <label>
          {t('Browser name')}
          <input required disabled={generating || busy} value={name ?? t('Desktop browser')} onChange={(e) => setName(e.target.value)} />
        </label>

      <button className="runtime-primary" type="button" disabled={generating || busy} onClick={() => {
        const ticket = ++clientTicket.current;
        attempt.current++;
        controllerRef.current?.abort();
        identityRef.current?.dispose();
        identityRef.current = undefined;
        setIdentity(undefined); setClientCode(''); setPairError(''); setCopyStatus(''); setGenerating(true);
        void createPairingIdentity(location.origin).then(async value => {
          try {
            const request = await registry.requestClientPairing(address, value);
            if (ticket !== clientTicket.current) { value.dispose(); return; }
            const controller = new AbortController();
            controllerRef.current = controller;
            identityRef.current = value; setIdentity(value); setClientCode(request.code); setGenerating(false); setBusy(true);
            const connection = await registry.waitForClientPairing(request, name ?? t('Desktop browser'), value, runtimeName.trim() || undefined, controller.signal);
            if (ticket !== clientTicket.current) return;
            value.dispose(); identityRef.current = undefined; setIdentity(undefined); setBusy(false);
            onPaired(connection.serviceId);
          } catch (error) { value.dispose(); throw error; }
        }).catch(error => { if (ticket === clientTicket.current) { setPairError(messageOf(error)); onError(error); } })
          .finally(() => { if (ticket === clientTicket.current) { setGenerating(false); setBusy(false); } });
      }}>{generating ? t('Generating…') : busy ? t('Waiting for Workspace approval…') : identity ? t('Regenerate client code') : t('Generate client code')}</button>
      {identity && <>
        <label>{t('Client code')}<input readOnly value={clientCode} onFocus={e => e.currentTarget.select()} spellCheck={false} className="pairing-short-code" /></label>
        <button type="button" onClick={() => {
          const ticket = clientTicket.current;
          if (!navigator.clipboard?.writeText) { setCopyStatus('Select the client code above and copy it manually.'); return; }
          void navigator.clipboard.writeText(clientCode).then(() => { if (ticket === clientTicket.current) setCopyStatus('Client code copied.'); })
            .catch(() => { if (ticket === clientTicket.current) setCopyStatus('Copy is unavailable. Select the client code and copy it manually.'); });
        }}>{t('Copy client code')}</button>
        <p role="status">{copyStatus ? t(copyStatus) : ''}</p>
        <small>{t('Current origin: {origin}', { origin: location.origin })}</small>
        <details><summary>{t('View public key fingerprint')}</summary><small>{t('Public key fingerprint SHA-256: {fingerprint}', { fingerprint: identity.fingerprint })}</small></details>
        <p>{t('Run this on the Workspace device (no need to enter the origin manually):')}</p>
        <code>npx openworkgraph@latest pair --client-code {clientCode}</code>
        <p>{t('The client code is valid for 5 minutes. Keep this page open; refreshing or regenerating requires authorization again.')}</p>
        {busy && <p role="status">{t('Waiting for Workspace approval…')}</p>}
      </>}
      </section>
      {pairError && <p role="status">{t('Pairing was not completed. Check the notification and try again.')}</p>}
      <details className="runtime-help"><summary>{t('Connection and access information')}</summary>
        <p>{t('After pairing, this browser has full management access: it can manage projects and Work Graphs, run tasks, manage assets, revoke browser sessions, and manage operation backups.')}</p>
        <p>{t('HTTP is supported and HTTPS is not required. HTTP does not encrypt sessions or business data, so use it only on trusted networks. Legacy pairing codes can still be redeemed.')}</p>
        <p>
          {t('The address belongs to the Workspace device; do not use the other device’s localhost across devices. If Chrome or Edge requests local network access, authorize it according to your deployment policy.')}
        </p>
      </details>
    </div>
  );
}
