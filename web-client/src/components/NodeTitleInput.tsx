import { useRef, useState, type InputHTMLAttributes } from 'react';
import { limitNodeTitle } from '../../../packages/protocol/src/node-title';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onValueChange(value: string): void;
};

/** Keep IME preedit local and submit only the completed, bounded title. */
export function NodeTitleInput({ value, onValueChange, ...props }: Props) {
  const [composition, setComposition] = useState<string>();
  const composing = useRef(false);
  return <input {...props} value={composition ?? value}
    onCompositionStart={event => { composing.current = true; setComposition(event.currentTarget.value); }}
    onCompositionEnd={event => { composing.current = false; setComposition(undefined); onValueChange(limitNodeTitle(event.currentTarget.value)); }}
    onChange={event => {
      if (composing.current || (event.nativeEvent as InputEvent).isComposing) setComposition(event.currentTarget.value);
      else onValueChange(limitNodeTitle(event.currentTarget.value));
    }}
  />;
}
