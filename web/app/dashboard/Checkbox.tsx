import { useEffect, useId, useRef } from 'react';

/**
 * Checkbox with a draw-on checkmark, press feedback and an indeterminate state.
 *
 * Follows the beui.dev motion checkbox contract, implemented against this
 * repo's tokens rather than its dependencies: the checkmark draws by
 * transitioning stroke-dashoffset and the press spring is an overshoot easing,
 * so it needs no animation library. Same reasoning as StreamingAgentMarkdown.
 *
 * The native input stays in the DOM and owns state, focus and the mixed
 * (indeterminate) announcement. The visible box is decoration.
 */
export function Checkbox({
  checked, onCheckedChange, disabled, indeterminate, label, className, id, title,
  'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  label?: string;
  className?: string;
  id?: string;
  title?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  // indeterminate is a DOM property, not an attribute: React cannot set it.
  useEffect(() => { if (input.current) input.current.indeterminate = Boolean(indeterminate); }, [indeterminate]);

  return <label
    className={`ui-checkbox${className ? ` ${className}` : ''}`}
    htmlFor={inputId}
    data-checked={checked}
    data-indeterminate={Boolean(indeterminate)}
    data-disabled={Boolean(disabled)}
    title={title}
  >
    <input
      ref={input}
      id={inputId}
      type='checkbox'
      checked={checked}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={ariaDescribedBy}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
    <span className='ui-checkbox-box' aria-hidden='true'>
      <svg viewBox='0 0 16 16' fill='none'>
        <path className='ui-checkbox-tick' d='M3.5 8.4 6.4 11.2 12.5 5' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
        <path className='ui-checkbox-dash' d='M4 8h8' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
      </svg>
    </span>
    {label ? <b>{label}</b> : null}
  </label>;
}
