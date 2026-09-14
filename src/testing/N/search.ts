import { vi, type Mock } from 'vitest';

export const create: Mock = vi.fn(() => ({
    run: () => ({ getRange: () => [], each: () => undefined }),
}));
export const load: Mock = vi.fn();
export const lookupFields: Mock = vi.fn();
export const Operator = { IS: 'is', ANYOF: 'anyof', CONTAINS: 'contains' };
export const Type = {};
