/** A stand-in for a third-party design system the app does not own: MUI-style callbacks, `onChange(event, value)`. */
export interface ThirdSelectProps {
  label?: string;
  value?: string;
  data: readonly { value: string; label: string }[];
  onChange?: (event: { type: 'change' }, value: string) => unknown;
}

export function ThirdSelect({ label, value, data, onChange }: ThirdSelectProps) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange?.({ type: 'change' }, e.target.value)}>
      {data.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export interface ThirdButtonProps {
  children?: string;
  onClick?: (event: { type: 'click' }) => unknown;
}

export function ThirdButton({ children, onClick }: ThirdButtonProps) {
  return (
    <button type="button" onClick={() => onClick?.({ type: 'click' })}>
      {children}
    </button>
  );
}
