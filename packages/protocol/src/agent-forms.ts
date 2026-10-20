/** Additive backend/API form contract. Existing Web question controls are not
 * extended; adapters retain legacy questions only when conversion is lossless. */
export type AgentFormValue = string | number | boolean | string[];
export interface AgentFormCondition { key: string; op: 'eq' | 'neq'; value: string | number | boolean }
export interface AgentFormField {
  key: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
  title?: string; description?: string; required?: boolean; hidden?: boolean; when?: AgentFormCondition[];
  options?: { value: string; label: string; description?: string }[]; custom?: boolean;
  default?: AgentFormValue; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; pattern?: string; format?: 'email' | 'uri' | 'date' | 'date-time'; placeholder?: string;
  /** Opaque native action identity. URLs or authentication secrets do not enter history. */
  actionId?: string;
}
export interface AgentForm { version: 1; fields: AgentFormField[] }
