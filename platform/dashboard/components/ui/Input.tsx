'use client';
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const base = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, className, id, ...rest }, ref) {
  const inputId = id ?? (label ? `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined);
  return (
    <div className="space-y-1">
      {label && <label htmlFor={inputId} className="block text-xs font-medium text-gray-700">{label}</label>}
      <input ref={ref} id={inputId} className={cn(base, error && 'border-red-400', className)} {...rest} />
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; hint?: ReactNode }
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, className, id, ...rest }, ref) {
  const inputId = id ?? (label ? `t-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined);
  return (
    <div className="space-y-1">
      {label && <label htmlFor={inputId} className="block text-xs font-medium text-gray-700">{label}</label>}
      <textarea ref={ref} id={inputId} className={cn(base, 'font-mono', className)} {...rest} />
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
});

export default Input;
