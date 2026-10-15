import { Bot } from 'lucide-react';
import type { AgentDescriptor } from '../../../packages/protocol/src/agents';

/** The protocol supplies a finite text mark, never an image URL or SVG payload. */
export function AgentMark({ descriptor }: { descriptor: AgentDescriptor }) {
  const logo = descriptor.logo;
  return logo && typeof logo.symbol === 'string' && logo.symbol.length <= 8 && /^#[0-9a-f]{6}$/i.test(logo.color)
    ? <span className="agent-brand-mark" aria-hidden="true" style={{ borderColor: logo.color }}>{logo.symbol}</span>
    : <Bot size={18} aria-hidden="true"/>;
}
