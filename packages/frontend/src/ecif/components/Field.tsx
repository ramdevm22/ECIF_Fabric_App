import type { ReactNode } from 'react';

interface Props {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  value?: string;     // pass the current value so empty mandatory fields get the red highlight
  counter?: { used: number; max: number };
  children: ReactNode;
}

/** Label + input + guidance text + error. Empty mandatory fields turn red, like the Excel sheet. */
export function Field({ label, required, hint, error, value, counter, children }: Props) {
  const missing = required && (value ?? '').trim() === '';
  const cls = ['field', missing ? 'missing' : '', error && !missing ? 'invalid' : ''].join(' ');
  return (
    <div className={cls}>
      <label>
        {label}
        {required && <span className="star"> *</span>}
      </label>
      {children}
      {hint && <div className="hint">{hint}</div>}
      {counter && (
        <div className={counter.used > counter.max ? 'hint over' : 'hint'}>
          {counter.used} / {counter.max} characters
        </div>
      )}
      {error && !missing && <div className="error">{error}</div>}
    </div>
  );
}