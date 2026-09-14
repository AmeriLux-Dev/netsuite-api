import { vi, type Mock } from 'vitest';

export const create: Mock = vi.fn(() => ({ submit: vi.fn(() => 'TASK_ID') }));
export const checkStatus: Mock = vi.fn();
export const TaskType = { MAP_REDUCE: 'MAP_REDUCE', SCHEDULED_SCRIPT: 'SCHEDULED_SCRIPT' };
