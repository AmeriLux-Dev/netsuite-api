import { vi, type Mock } from 'vitest';

export const runSuiteQL: Mock = vi.fn(() => ({ asMappedResults: () => [], results: [] }));
export const runSuiteQLPaged: Mock = vi.fn();
export const create: Mock = vi.fn();
export const load: Mock = vi.fn();
export const Operator = {};
export const Type = {};
