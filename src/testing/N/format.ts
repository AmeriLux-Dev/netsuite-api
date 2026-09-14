import { vi, type Mock } from 'vitest';

export const parse: Mock = vi.fn((options: { value: unknown }) => options.value);
export const format: Mock = vi.fn((options: { value: unknown }) => String(options.value));
export const Type = { DATE: 'date', DATETIME: 'datetime', CURRENCY: 'currency' };
