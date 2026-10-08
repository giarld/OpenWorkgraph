import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { RUNTIME_NAME_MAX_LENGTH, type Connection, type ConnectionRegistry } from '../adapter/connections';
import { createPairingIdentity, type PairingIdentity } from '../adapter/client-pairing';
import { messageOf } from './contracts';
import { WelcomeCommand } from './WelcomeCommand';

export function WelcomeRuntimePairing({ registry, onStart, onBusy, onComplete }: {
  registry: ConnectionRegistry;
  onStart: () => void;
  onBusy: (busy: boolean) => void;
  onComplete: (serviceId: string) => void;
}) {
  const { t } = useI18n();
  const pairing = useRef<{ identity?: PairingIdentity; controller?: AbortController } | undefined>(undefined);
  const [address, setAddress] = useState('http://127.0.0.1:14317');
  const [clientCode, setClientCode] = useState('');
  const [connection, setConnection] = useState<Connection>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const nameForm = useRef<HTMLFormElement>(null);
  const commandStep = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pairing.current = {};
    return () => { pairing.current?.controller?.abort(); pairing.current?.identity?.dispose(); pairing.current = undefined; };
  }, [registry]);
  useEffect(() => {
    const target = connection ? nameForm.current : clientCode ? commandStep.current : null;
    const viewport = target?.closest<HTMLElement>('.welcome-tutorial');
    if (!target || !viewport) return;
    if (connection) nameInput.current?.focus({ preventScroll: true });
    // Scroll only the tutorial, preserving the outer three-page position.
    viewport.scrollTo({
      top: viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }, [clientCode, connection]);
  const command = 'npx openworkgraph@latest pair --client-code ' + clientCode;
  async function run(operation: (value: { identity?: PairingIdentity; controller?: AbortController }) => Promise<void>) {
    const value = pairing.current;
    if (!value || busy) return;
    setBusy(true); onBusy(true); onStart(); setError('');
    try { await operation(value); }
    catch (failure) { if (pairing.current === value) setError(messageOf(failure)); }
    finally { if (pairing.current === value) { setBusy(false); onBusy(false); } }
  }
  if (connection) return <form ref={nameForm} className="welcome-pairing" onSubmit={event => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      registry.renameRuntime(connection.serviceId, name, connection.session.id);
      onComplete(connection.serviceId);
    } catch (failure) { setError(messageOf(failure)); }
  }}>
    <h3>{t('Name your Workspace')}</h3>
    <p>{t('Connected successfully. Choose a name, then continue to Agent settings.')}</p>
    <label>{t('Workspace name')}<input ref={nameInput} required maxLength={RUNTIME_NAME_MAX_LENGTH} value={name} onChange={event => setName(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" disabled={!name.trim()}>{t('Confirm name and continue')}</button>
  </form>;
  return <div className="welcome-pairing">
    <p>{t('Once your Workspace is running, enter its address below. For another device, use its network address instead of localhost.')}</p>
    <label>{t('Workspace address')}<input type="url" required disabled={busy} value={address} onChange={event => {
      pairing.current?.controller?.abort(); pairing.current?.identity?.dispose(); pairing.current = {};
      setAddress(event.target.value); setClientCode(''); setError('');
    }} /></label>
    <button type="button" className="primary-button" disabled={busy || !address.trim()} onClick={() => void run(async value => {
      setClientCode('');
      value.controller?.abort();
      value.identity?.dispose(); value.identity = undefined;
      const identity = await createPairingIdentity(location.origin);
      if (pairing.current !== value) { identity.dispose(); return; }
      value.identity = identity;
      const controller = new AbortController();
      value.controller = controller;
      try {
        const ticket = await registry.requestClientPairing(address, identity);
        if (pairing.current !== value) return;
        setClientCode(ticket.code);
        const result = await registry.waitForClientPairing(ticket, t('Desktop browser'), identity, undefined, controller.signal);
        identity.dispose(); value.identity = undefined;
        if (pairing.current === value) setConnection(result);
      } catch (failure) { identity.dispose(); value.identity = undefined; throw failure; }
    })}>{busy ? t('Connecting…') : clientCode ? t('Regenerate pairing command') : t('Pair Workspace')}</button>
    {clientCode && <div ref={commandStep} className="welcome-pairing">
      <p>{t('Run this command on the Workspace device and approve the client. This page will connect automatically after the private handshake completes.')}</p>
      <WelcomeCommand key={clientCode} command={command} label={t('Pairing command')} copyLabel={t('Copy pairing command')} />
      <small>{t('The client code is valid for 5 minutes. Keep this page open; refreshing or regenerating requires authorization again.')}</small>
      <p role="status">{t('Waiting for Workspace approval…')}</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
