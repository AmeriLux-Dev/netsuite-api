import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as query from 'N/query';
import * as record from 'N/record';
import * as task from 'N/task';
import { ApiError, createJobRunStore } from '../../src/server/index.js';
import type { JobRef, JobRunsConfig } from '../../src/server/index.js';

// The N/* stubs this package ships, named once: vi.mocked types them as the mocks they are.
const createRecord = vi.mocked(record.create);
const loadRecord = vi.mocked(record.load);
const deleteRecord = vi.mocked(record.delete);
const runSuiteQL = vi.mocked(query.runSuiteQL);
const createTask = vi.mocked(task.create);
const checkStatus = vi.mocked(task.checkStatus);

/** A run record as this application deployed it: the shape the generator writes into the scripts map. */
const jobRuns: JobRunsConfig = {
    recordType: 'customrecord_demo_job_run',
    fields: {
        job: 'custrecord_demo_jr_job',
        status: 'custrecord_demo_jr_status',
        stage: 'custrecord_demo_jr_stage',
        percentComplete: 'custrecord_demo_jr_percent',
        input: 'custrecord_demo_jr_input',
        result: 'custrecord_demo_jr_result',
        errors: 'custrecord_demo_jr_errors',
        taskId: 'custrecord_demo_jr_task',
        deployment: 'custrecord_demo_jr_deploy',
        startedBy: 'custrecord_demo_jr_by',
        startedAt: 'custrecord_demo_jr_start',
        finishedAt: 'custrecord_demo_jr_end',
    },
    extraFields: { customerId: { id: 'custrecord_demo_jr_customer', type: 'integer' } },
};

const closeStaleOrders: JobRef = {
    kind: 'mapreduce',
    name: 'closeStaleOrders',
    scriptId: 'customscript_demo_close_stale_mr',
    deployments: ['customdeploy_demo_close_stale_mr', 'customdeploy_demo_close_stale_mr_2'],
    runParameter: 'custscript_demo_close_stale_run',
};

/** The rows in the account, by internal id: every record.create and record.load in a test goes through this. */
const rows = new Map<string, Record<string, unknown>>();
let nextId = 1;

function fakeRecord(id: string) {
    const values = rows.get(id) as Record<string, unknown>;
    return {
        getValue: ({ fieldId }: { fieldId: string }) => values[fieldId] ?? '',
        setValue: ({ fieldId, value }: { fieldId: string; value: unknown }) => {
            values[fieldId] = value;
        },
        save: () => id,
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    nextId = 1;
    createRecord.mockImplementation(((() => {
        const id = String(nextId++);
        rows.set(id, {});
        return fakeRecord(id);
    })) as never);
    loadRecord.mockImplementation((({ id }: { id: string | number }) => {
        if (!rows.has(String(id))) throw new Error('That record does not exist.');
        return fakeRecord(String(id));
    }) as never);
    deleteRecord.mockImplementation((({ id }: { id: string | number }) => {
        rows.delete(String(id));
    }) as never);
    runSuiteQL.mockReturnValue({ asMappedResults: () => [] } as never);
    checkStatus.mockReturnValue({ status: 'PROCESSING', stage: 'MAP', getPercentageCompleted: () => 40 } as never);
});

describe('start', () => {
    it('writes the run, submits it with the run id as the script parameter, and answers the run id', () => {
        const submit = vi.fn(() => 'TASK_7');
        createTask.mockReturnValue({ submit } as never);
        const store = createJobRunStore(jobRuns);

        const runId = store.start(closeStaleOrders, { olderThanDays: 30 }, { extra: { customerId: 42 } });

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(createTask).toHaveBeenCalledWith({
            taskType: 'MAP_REDUCE',
            scriptId: closeStaleOrders.scriptId,
            deploymentId: 'customdeploy_demo_close_stale_mr',
            params: { custscript_demo_close_stale_run: runId },
        });
        const row = rows.get(runId) as Record<string, unknown>;
        expect(row.custrecord_demo_jr_job).toBe('closeStaleOrders');
        expect(row.custrecord_demo_jr_input).toBe('{"olderThanDays":30}');
        expect(row.custrecord_demo_jr_task).toBe('TASK_7');
        expect(row.custrecord_demo_jr_customer).toBe(42);
    });

    it('moves to the next deployment when one is already running', () => {
        const submit = vi.fn(() => 'TASK_8');
        createTask
            .mockImplementationOnce((() => ({
                submit: () => {
                    throw new Error('MAP_REDUCE_ALREADY_RUNNING');
                },
            })) as never)
            .mockImplementationOnce((() => ({ submit })) as never);
        const store = createJobRunStore(jobRuns);

        const runId = store.start(closeStaleOrders, {});

        expect(submit).toHaveBeenCalledTimes(1);
        expect((rows.get(runId) as Record<string, unknown>).custrecord_demo_jr_deploy).toBe('customdeploy_demo_close_stale_mr_2');
    });

    it('answers 409 and leaves no run behind when every deployment is busy', () => {
        createTask.mockImplementation((() => ({
            submit: () => {
                throw new Error('MAP_REDUCE_ALREADY_RUNNING');
            },
        })) as never);
        const store = createJobRunStore(jobRuns);

        expect(() => store.start(closeStaleOrders, {})).toThrow(ApiError);
        try {
            store.start(closeStaleOrders, {});
        } catch (error) {
            expect((error as ApiError).status).toBe(409);
        }
        expect(rows.size).toBe(0);
    });

    it('rejects a field the run record does not have', () => {
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_9') } as never);
        const store = createJobRunStore(jobRuns);

        expect(() => store.start(closeStaleOrders, {}, { extra: { nothingLikeIt: 1 } })).toThrow(/no field 'nothingLikeIt'/);
    });
});

describe('read', () => {
    it('answers null for a run that is gone', () => {
        expect(createJobRunStore(jobRuns).read('404')).toBeNull();
    });

    it('takes the stage and the progress from the task while the run is working', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_1') } as never);
        const runId = store.start(closeStaleOrders, {});

        const run = store.read(runId);

        expect(run).toMatchObject({ id: runId, job: 'closeStaleOrders', status: 'running', stage: 'map', percentComplete: 40, taskId: 'TASK_1' });
    });

    it('calls a run failed when NetSuite stopped the task', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_2') } as never);
        const runId = store.start(closeStaleOrders, {});
        checkStatus.mockReturnValue({ status: 'FAILED', stage: 'MAP', getPercentageCompleted: () => 20 } as never);

        const run = store.read(runId);

        expect(run?.status).toBe('failed');
        expect(run?.errors).toEqual([{ stage: 'input', message: 'NetSuite stopped the task before it finished.' }]);
    });

    it('calls a run failed when the task finished without writing a result', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_3') } as never);
        const runId = store.start(closeStaleOrders, {});
        checkStatus.mockReturnValue({ status: 'COMPLETE', stage: 'SUMMARIZE', getPercentageCompleted: () => 100 } as never);

        const run = store.read(runId);

        expect(run?.status).toBe('failed');
        expect(run?.errors[0].message).toMatch(/without writing a result/);
    });

    it('reads back what summarize wrote, and stops asking about the task', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_4') } as never);
        const runId = store.start(closeStaleOrders, {}, { extra: { customerId: 7 } });
        store.finish(runId, { status: 'complete', result: { closed: 3 }, errors: [{ stage: 'map', key: '12', message: 'locked' }] });
        checkStatus.mockClear();

        const run = store.read<{ closed: number }, { customerId: number }>(runId);

        expect(checkStatus).not.toHaveBeenCalled();
        expect(run).toMatchObject({ status: 'complete', percentComplete: 100, result: { closed: 3 }, extra: { customerId: 7 } });
        expect(run?.errors).toHaveLength(1);
        expect(run?.finishedAt).not.toBeNull();
    });
});

describe('the stages side', () => {
    it('opens a run of its own for a scheduled start and finds it again by deployment', () => {
        const store = createJobRunStore(jobRuns);

        const runId = store.claimRun({ job: 'closeStaleOrders', deployment: 'customdeploy_demo_close_stale_mr' });

        expect(store.readInput(runId)).toEqual({});
        expect((rows.get(runId) as Record<string, unknown>).custrecord_demo_jr_status).toBe('running');
        runSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: runId }] } as never);
        expect(store.findRunningRunId('closeStaleOrders', 'customdeploy_demo_close_stale_mr')).toBe(runId);
    });

    it('keeps the run the parameter named, rather than opening another', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_5') } as never);
        const runId = store.start(closeStaleOrders, { olderThanDays: 5 });

        expect(store.claimRun({ job: 'closeStaleOrders', runId, deployment: 'customdeploy_demo_close_stale_mr' })).toBe(runId);
        expect(rows.size).toBe(1);
        expect(store.readInput(runId)).toEqual({ olderThanDays: 5 });
    });

    it('marks a run failed with the error a stage threw', () => {
        const store = createJobRunStore(jobRuns);
        const runId = store.claimRun({ job: 'closeStaleOrders', deployment: 'customdeploy_demo_close_stale_mr' });

        store.fail(runId, { stage: 'input', message: 'the query would not run' });

        expect(store.read(runId)).toMatchObject({ status: 'failed', errors: [{ stage: 'input', message: 'the query would not run' }] });
    });

    it('finds the runs to clean up by age', () => {
        runSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: 11 }, { id: 12 }] } as never);

        expect(createJobRunStore(jobRuns).findExpired(7)).toEqual(['11', '12']);
        expect(runSuiteQL).toHaveBeenCalledWith({ query: expect.stringContaining('customrecord_demo_job_run'), params: [7] });
    });
});
