import { Fragment } from 'react';
import type { SkillReference } from '../../../packages/protocol/src/skills';
import { promptMentionTokens, promptMentionIconPath } from './prompt-mentions';

/** Read-only prompts share the editor's mention grammar and chip appearance. */
export function PromptText({ text, skillReferences = [], skillNames = [] }: {
  text: string;
  skillReferences?: readonly SkillReference[];
  skillNames?: readonly string[];
}) {
  let cursor = 0;
  const content = promptMentionTokens(text, true, skillReferences, skillNames).map(token => {
    const before = text.slice(cursor, token.start);
    cursor = token.end;
    return <Fragment key={token.start}>{before}<span className="prompt-mention-token" data-mention={token.raw} data-kind={token.kind} title={token.path ?? token.name} aria-label={token.name}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={promptMentionIconPath(token.kind)}/></svg>{token.name}
    </span></Fragment>;
  });
  return <>{content}{text.slice(cursor)}</>;
}
