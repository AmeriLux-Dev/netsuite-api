import { vi, type Mock } from 'vitest';

export const create: Mock = vi.fn(() => ({ submit: vi.fn(() => 'TASK_ID') }));
/** A job run reads this to tell a task still working from one NetSuite gave up on; a test decides which by returning a status here. */
export const checkStatus: Mock = vi.fn(() => ({ status: 'PROCESSING', stage: 'MAP', getPercentageCompleted: () => 0 }));
export const TaskType = { MAP_REDUCE: 'MAP_REDUCE', SCHEDULED_SCRIPT: 'SCHEDULED_SCRIPT' };
export const TaskStatus = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', COMPLETE: 'COMPLETE', FAILED: 'FAILED' };
export const MapReduceStage = { GET_INPUT: 'GET_INPUT', MAP: 'MAP', SHUFFLE: 'SHUFFLE', REDUCE: 'REDUCE', SUMMARIZE: 'SUMMARIZE' };
