import { vi, type Mock } from 'vitest';

export const debug: Mock = vi.fn();
export const audit: Mock = vi.fn();
export const error: Mock = vi.fn();
export const emergency: Mock = vi.fn();
