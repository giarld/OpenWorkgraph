import { useId } from 'react';
import type { ResourceEnvelope } from '../../../packages/protocol/src/index';
import type { AgentCapabilities, AgentConfigurationField, AgentDescriptor, AgentOptionValue, AgentPlatform, AgentRunKind } from '../../../packages/protocol/src/agents';
import '../i18n/catalogs/agent-configuration';
import { translate } from '../i18n/translate';
import { useI18n } from '../i18n/I18nProvider';

type Capability = { [K in keyof AgentCapabilities]-?: AgentCapabilities[K] extends boolean ? K : never }[keyof AgentCapabilities];
export interface AgentConfigurationContext {
  platform: AgentPlatform;
  enabled?: boolean;
  requiredKind?: AgentRunKind;
  requiredInputKinds?: ResourceEnvelope['kind'][];
  requiredCapabilities?: Capability[];
}
export interface AgentConfigurationDraft { backendId: string; schemaVersion: number; options: Record<string, AgentOptionValue> }
const capabilityLabels: Record<Capability, string> = {
  cancellation: 'Cancellation', restoredRunStart: 'Start restored runs', conversationContinuation: 'Continue conversations',
  reattach: 'Reattach runs', approvals: 'Operation approvals', userInput: 'User questions', historyTools: 'History tools',
  nativeSkills: 'Native skills', configuredSkills: 'Configured skills', dynamicSkillCommands: 'Dynamic skill commands', visualize: 'Visualization',
};
const fieldAvailable = (field: AgentConfigurationField, platform: AgentPlatform) => !field.platforms || field.platforms.includes(platform);
const supportedPlatforms = (values: unknown): boolean => values === undefined || (Array.isArray(values) && values.length > 0 && values.every(value => ['darwin', 'linux', 'win32'].includes(value)));

/** The fixture accepts the finite schema contract, never arbitrary JSON-schema widgets. */
function schemaSupported(descriptor: AgentDescriptor): boolean {
  const schema = descriptor.configuration;
  if (!Number.isSafeInteger(schema.version) || schema.version < 1 || !Array.isArray(schema.fields) || schema.fields.length > 64 ||
    !supportedPlatforms(descriptor.capabilities.platforms)) return false;
  const names = new Set<string>();
  for (const field of schema.fields) {
    if (!field || typeof field.name !== 'string' || !field.name.trim() || field.name.length > 128 || names.has(field.name) ||
      typeof field.label !== 'string' || !field.label.trim() || !['text', 'boolean', 'enum', 'number'].includes(field.type) ||
      !supportedPlatforms(field.platforms)) return false;
    names.add(field.name);
    if ([field.minimum, field.maximum, field.minLength, field.maxLength].some(value => value !== undefined && !Number.isFinite(value))) return false;
    if ((field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) ||
      [field.minLength, field.maxLength].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
      (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)) return false;
    if (field.type === 'enum' && (!Array.isArray(field.values) || !field.values.length || field.values.length > 128 ||
      !field.values.every(value => typeof value === 'string' && !!value.trim()) || new Set(field.values).size !== field.values.length)) return false;
    if (field.default !== undefined && fieldError(field, field.default)) return false;
  }
  return true;
}
function fieldError(field: AgentConfigurationField, value: unknown): string | undefined {
  if (value === undefined || (value === '' && field.type !== 'boolean')) return field.required ? 'This field is required.' : undefined;
  if (field.type === 'boolean') return typeof value === 'boolean' ? undefined : 'Enter a valid value.';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (!field.integer || Number.isInteger(value)) &&
    (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum) ? undefined : 'Enter a number within the allowed range.';
  if (typeof value !== 'string') return 'Enter a valid value.';
  if (field.type === 'enum') return field.values?.includes(value) ? undefined : 'Choose one of the available options.';
  return value.length >= (field.minLength ?? 0) && value.length <= (field.maxLength ?? 16000) && (!field.required || !!value.trim()) ? undefined : 'Enter text within the allowed length.';
}
export function agentConfigurationRestriction(descriptor: AgentDescriptor, context: AgentConfigurationContext): string | undefined {
  if (!schemaSupported(descriptor)) return 'The Agent configuration schema is not supported.';
  if (context.enabled === false) return 'This Agent is disabled.';
  if (descriptor.capabilities.platforms && !descriptor.capabilities.platforms.includes(context.platform)) return 'This Agent is not available on this platform.';
  if ((context.requiredKind && !descriptor.capabilities.kinds.includes(context.requiredKind)) ||
    context.requiredInputKinds?.some(kind => !descriptor.capabilities.inputKinds.includes(kind)) ||
    context.requiredCapabilities?.some(key => descriptor.capabilities[key] !== true)) return 'This Agent does not support the required capability.';
  return undefined;
}
export function validateAgentConfiguration(descriptor: AgentDescriptor, value: Record<string, AgentOptionValue>, context: AgentConfigurationContext): { draft: AgentConfigurationDraft; errors: Record<string, string>; restriction?: string } {
  const options: Record<string, AgentOptionValue> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  const restriction = agentConfigurationRestriction(descriptor, context);
  if (!schemaSupported(descriptor)) return { draft: { backendId: descriptor.id, schemaVersion: descriptor.configuration.version, options }, errors, restriction };
  for (const field of descriptor.configuration.fields) {
    if (!fieldAvailable(field, context.platform)) continue;
    const selected = Object.hasOwn(value, field.name) ? value[field.name] : field.default;
    const error = fieldError(field, selected);
    if (error) errors[field.name] = translate(error);
    else if (selected !== undefined && !(selected === '' && field.type !== 'text')) options[field.name] = selected;
  }
  for (const name of Object.keys(value)) if (!descriptor.configuration.fields.some(field => field.name === name)) errors[name] = translate('Unknown configuration field.');
  return { draft: { backendId: descriptor.id, schemaVersion: descriptor.configuration.version, options }, errors, restriction };
}

/** Isolated public consumer. Production management integration belongs to a later phase. */
export function AgentConfigurationForm({ descriptor, value, onChange, onSubmit, disabled = false, ...context }: AgentConfigurationContext & {
  descriptor: AgentDescriptor; value: Record<string, AgentOptionValue>;
  onChange(value: Record<string, AgentOptionValue>): void; onSubmit(draft: AgentConfigurationDraft): void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const formId = useId();
  const validation = validateAgentConfiguration(descriptor, value, context);
  const blocked = disabled || !!validation.restriction;
  const fields = schemaSupported(descriptor) ? descriptor.configuration.fields : [];
  const update = (field: AgentConfigurationField, selected: AgentOptionValue | undefined) => {
    if (blocked || !fieldAvailable(field, context.platform)) return;
    const next = { ...value };
    if (selected === undefined) delete next[field.name]; else next[field.name] = selected;
    onChange(next);
  };
  return <form className="management-section" aria-label={t('Agent configuration for {name}', { name: descriptor.name })} onSubmit={event => {
    event.preventDefault();
    if (!blocked && !Object.keys(validation.errors).length) onSubmit(validation.draft);
  }}>
    <h3>{descriptor.name}</h3><p>{descriptor.description}</p>
    {validation.restriction && <p role="status">{t(validation.restriction)}</p>}
    <fieldset className="management-controls" disabled={blocked}>
      <legend>{t('Agent configuration')}</legend>
      {fields.map((field, index) => {
        const id = formId + ':' + index, available = fieldAvailable(field, context.platform);
        const selected = Object.hasOwn(value, field.name) ? value[field.name] : field.default;
        const error = validation.errors[field.name];
        const describedBy = [field.description ? id + ':help' : '', !available ? id + ':platform' : '', error ? id + ':error' : ''].filter(Boolean).join(' ') || undefined;
        const shared = { id, disabled: !available || blocked, required: !!field.required, 'aria-invalid': !!error, 'aria-describedby': describedBy };
        return <div key={field.name} className="management-field">
          <label htmlFor={id}>{field.label}</label>
          {field.type === 'boolean' ? <input {...shared} required={false} type="checkbox" checked={selected === true} onChange={event => update(field, event.target.checked)} />
            : field.type === 'enum' ? <select {...shared} value={typeof selected === 'string' ? selected : ''} onChange={event => update(field, event.target.value)}>
              <option value="">{t('Choose an option')}</option>{field.values?.map(option => <option key={option} value={option}>{option}</option>)}
            </select> : <input {...shared} type={field.type === 'number' ? 'number' : 'text'} value={selected === undefined ? '' : String(selected)}
              min={field.minimum} max={field.maximum} step={field.integer ? 1 : 'any'} minLength={field.minLength} maxLength={field.maxLength ?? (field.type === 'text' ? 16000 : undefined)}
              onChange={event => update(field, field.type === 'number' ? event.target.value === '' ? undefined : event.target.valueAsNumber : event.target.value)} />}
          {field.description && <p id={id + ':help'} className="muted">{field.description}</p>}
          {!available && <p id={id + ':platform'} role="status">{t('This option is not available on this platform.')}</p>}
          {error && <p id={id + ':error'} role="alert">{error}</p>}
        </div>;
      })}
      {Object.entries(validation.errors).filter(([name]) => !fields.some(field => field.name === name)).map(([name, error]) => <p key={name} role="alert">{name}: {error}</p>)}
      <button type="submit" className="primary-button" disabled={blocked || !!Object.keys(validation.errors).length}>{t('Save configuration')}</button>
    </fieldset>
    <fieldset className="management-controls" disabled><legend>{t('Agent capabilities')}</legend>
      {(Object.keys(capabilityLabels) as Capability[]).map(key => <label key={key}><input type="checkbox" checked={descriptor.capabilities[key]} readOnly disabled />{t(capabilityLabels[key])}</label>)}
    </fieldset>
  </form>;
}
