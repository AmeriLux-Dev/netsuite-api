import { vi, type Mock } from 'vitest';

export const load: Mock = vi.fn();
export const create: Mock = vi.fn();
export const copy: Mock = vi.fn();
export const transform: Mock = vi.fn();
export const submitFields: Mock = vi.fn();
export const attach: Mock = vi.fn();
export const detach: Mock = vi.fn();
const deleteRecord: Mock = vi.fn();
export { deleteRecord as delete };
export const Type = { CUSTOMER: 'customer', FOLDER: 'folder' };
