import { vi, type Mock } from 'vitest';

export const get: Mock = vi.fn();
export const post: Mock = vi.fn();
export const put: Mock = vi.fn();
export const request: Mock = vi.fn();
export const requestRestlet: Mock = vi.fn();
export const requestSuitelet: Mock = vi.fn();
const deleteRequest: Mock = vi.fn();
export { deleteRequest as delete };
export const Method = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE' };
