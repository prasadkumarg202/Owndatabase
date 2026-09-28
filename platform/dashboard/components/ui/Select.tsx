'use client';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: ({ value: string; label: string } | string)[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, options, className, id, ...rest }, ref) {
  const selectId = id ?? (label ? `s-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined);
  return (
    <div className="space-y-1">
      {label && <label htmlFor={selectId} className="block text-xs font-medium text-gray-700">{label}</label>}
      <select
        ref={ref}
        id={selectId}
        className={cn('w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500', className)}
        {...rest}
      >
        {options.map((o) => typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
});

export default Select;
