import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as query from 'N/query';
import * as record from 'N/record';
import * as runtime from 'N/runtime';
import * as task from 'N/task';
import { ApiError, createJobRunStore } from '../../src/server/index.js';
import type { JobRef, JobRunsConfig } from '../../src/server/index.js';
import { summarizeContextFor } from '../../src/testing/jobs.js';

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
        stagePercentComplete: 'custrecord_demo_jr_percent',
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

/** A job as netsuite.ts writes it down, which is the only place its ids live. */
const closeStaleOrders: JobRef = {
    name: 'closeStaleOrders',
    scriptId: 'customscript_demo_close_stale_mr',
    deployments: ['customdeploy_demo_close_stale_mr', 'customdeploy_demo_close_stale_mr_2'],
    runParameter: 'custscript_demo_close_stale_run',
};

/**
 * The script a stage is running as: the deployment it is on, and the run id it was passed, which a
 * scheduled run does not have. This is all a stage knows about its run before it asks the store.
 */
function runningOn(deployment: string, runId?: string): void {
    vi.mocked(runtime.getCurrentScript).mockReturnValue({
        id: 'customscript_demo_close_stale_mr',
        deploymentId: deployment,
        getParameter: ({ name }: { name: string }) => (name === 'custscript_demo_close_stale_run' ? (runId ?? '') : ''),
        getRemainingUsage: () => 1000,
    } as never);
}

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
    checkStatus.mockReturnValue({
        status: 'PROCESSING',
        stage: 'MAP',
        getPercentageCompleted: () => 40,
        getTotalMapCount: () => 20000,
        getPendingMapCount: () => 11588,
    } as never);
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

        expect(run).toMatchObject({
            id: runId,
            job: 'closeStaleOrders',
            status: 'running',
            stage: 'map',
            stagePercentComplete: 40,
            itemsProcessed: 8412,
            itemsTotal: 20000,
            taskId: 'TASK_1',
        });
    });

    it('counts the reduce stage once the task is reducing', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_5') } as never);
        const runId = store.start(closeStaleOrders, {});
        checkStatus.mockReturnValue({
            status: 'PROCESSING',
            stage: 'REDUCE',
            getPercentageCompleted: () => 25,
            getTotalMapCount: () => 20000,
            getPendingMapCount: () => 0,
            getTotalReduceCount: () => 400,
            getPendingReduceCount: () => 300,
        } as never);

        const run = store.read(runId);

        // The reduce stage's own rows, not the map stage's: a count belongs to the stage being worked.
        expect(run).toMatchObject({ stage: 'reduce', stagePercentComplete: 25, itemsProcessed: 100, itemsTotal: 400 });
    });

    it('reads the counts off the task, which needs the task to read them on', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_11') } as never);
        const runId = store.start(closeStaleOrders, {});
        // NetSuite's own status object counts through itself, so a getter taken off it and called alone throws.
        const taskStatus = {
            status: 'PROCESSING',
            stage: 'MAP',
            rows: 500,
            getPercentageCompleted: () => 50,
            getTotalMapCount() {
                return this.rows;
            },
            getPendingMapCount() {
                return this.rows / 5;
            },
        };
        checkStatus.mockReturnValue(taskStatus as never);

        const run = store.read(runId);

        expect(run).toMatchObject({ itemsProcessed: 400, itemsTotal: 500 });
    });

    it('leaves the counts empty in a stage that has none', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_6') } as never);
        const runId = store.start(closeStaleOrders, {});
        checkStatus.mockReturnValue({ status: 'PROCESSING', stage: 'GET_INPUT', getPercentageCompleted: () => 0 } as never);

        const run = store.read(runId);

        expect(run).toMatchObject({ stage: 'input', itemsProcessed: null, itemsTotal: null });
    });

    it('leaves the counts empty when NetSuite no longer knows the task', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_10') } as never);
        const runId = store.start(closeStaleOrders, {});
        checkStatus.mockImplementation((() => {
            throw new Error('That task id is unknown.');
        }) as never);

        const run = store.read(runId);

        // Nothing to refine the record with, so it answers the record as it stands and no counts.
        expect(run).toMatchObject({ status: 'pending', itemsProcessed: null, itemsTotal: null });
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
        runningOn('customdeploy_demo_close_stale_mr', runId);
        store.closeRun(closeStaleOrders, summarizeContextFor({ mapErrors: [{ key: '12', error: 'locked' }] }), { closed: 3 });
        checkStatus.mockClear();

        const run = store.read<{ closed: number }, { customerId: number }>(runId);

        expect(checkStatus).not.toHaveBeenCalled();
        expect(run).toMatchObject({ status: 'complete', stagePercentComplete: 100, itemsProcessed: null, itemsTotal: null, result: { closed: 3 }, extra: { customerId: 7 } });
        expect(run?.errors).toHaveLength(1);
        expect(run?.finishedAt).not.toBeNull();
    });
});

describe('findRuns', () => {
    it('answers the caller its own runs of one job, newest first, without loading a record', () => {
        runSuiteQL.mockReturnValue({
            asMappedResults: () => [
                { id: 9, job: 'closeStaleOrders', status: 'running', stage: 'map', startedby: 7 },
                { id: 4, job: 'closeStaleOrders', status: 'complete', stage: 'summarize', startedby: 7 },
            ],
        } as never);

        const runs = createJobRunStore(jobRuns).findRuns({ job: 'closeStaleOrders', startedBy: 7, limit: 5 });

        expect(runs).toEqual([
            { id: '9', job: 'closeStaleOrders', status: 'running', stage: 'map', startedBy: 7 },
            { id: '4', job: 'closeStaleOrders', status: 'complete', stage: 'summarize', startedBy: 7 },
        ]);
        expect(loadRecord).not.toHaveBeenCalled();
        const sent = runSuiteQL.mock.calls[0][0] as { query: string; params: unknown[] };
        expect(sent.params).toEqual(['closeStaleOrders', 7]);
        expect(sent.query).toContain('FETCH FIRST 5 ROWS ONLY');
        expect(sent.query).toContain('ORDER BY id DESC');
    });

    it('narrows to the runs that have not ended, for "is one already going?"', () => {
        runSuiteQL.mockReturnValue({ asMappedResults: () => [] } as never);

        createJobRunStore(jobRuns).findRuns({ job: 'closeStaleOrders', unfinishedOnly: true });

        const sent = runSuiteQL.mock.calls[0][0] as { query: string; params: unknown[] };
        expect(sent.query).toContain("IN ('pending', 'running')");
        expect(sent.params).toEqual(['closeStaleOrders']);
    });

    it('lists every job and caps how many it answers', () => {
        runSuiteQL.mockReturnValue({ asMappedResults: () => [] } as never);

        createJobRunStore(jobRuns).findRuns({ limit: 5000 });

        const sent = runSuiteQL.mock.calls[0][0] as { query: string; params: unknown[] };
        expect(sent.query).not.toContain('WHERE');
        expect(sent.query).toContain('FETCH FIRST 100 ROWS ONLY');
        expect(sent.params).toEqual([]);
    });
});

describe('the calls a stage makes', () => {
    it('opens the run the script parameter names and answers what it was started with', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_5') } as never);
        const runId = store.start(closeStaleOrders, { olderThanDays: 5 });
        runningOn('customdeploy_demo_close_stale_mr', runId);

        const input = store.openRun<{ olderThanDays: number }>(closeStaleOrders);

        expect(input).toEqual({ olderThanDays: 5 });
        expect(rows.size).toBe(1);
        expect((rows.get(runId) as Record<string, unknown>).custrecord_demo_jr_status).toBe('running');
        expect((rows.get(runId) as Record<string, unknown>).custrecord_demo_jr_deploy).toBe('customdeploy_demo_close_stale_mr');
    });

    it('opens a run of its own for a scheduled start, which has no parameter to read', () => {
        const store = createJobRunStore(jobRuns);
        runningOn('customdeploy_demo_close_stale_mr');

        expect(store.openRun(closeStaleOrders)).toEqual({});
        expect(rows.size).toBe(1);
        const [runId] = [...rows.keys()];
        expect((rows.get(runId) as Record<string, unknown>).custrecord_demo_jr_job).toBe('closeStaleOrders');
    });

    it('finds the run a later stage belongs to by the deployment it is running on', () => {
        const store = createJobRunStore(jobRuns);
        runningOn('customdeploy_demo_close_stale_mr');
        store.openRun(closeStaleOrders);
        const [runId] = [...rows.keys()];
        runSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: runId }] } as never);

        expect(store.currentRunId(closeStaleOrders)).toBe(runId);
        const sent = runSuiteQL.mock.calls[0][0] as { params: unknown[] };
        expect(sent.params).toEqual(['closeStaleOrders', 'customdeploy_demo_close_stale_mr']);
    });

    it('closes the run with the result summarize built and everything NetSuite collected', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_6') } as never);
        const runId = store.start(closeStaleOrders, {}, { extra: { customerId: 7 } });
        runningOn('customdeploy_demo_close_stale_mr', runId);

        store.closeRun(closeStaleOrders, summarizeContextFor({ mapErrors: [{ key: '12', error: 'locked' }], seconds: 12 }), { closed: 3 });

        checkStatus.mockClear();
        const run = store.read<{ closed: number }, { customerId: number }>(runId);
        expect(checkStatus).not.toHaveBeenCalled();
        expect(run).toMatchObject({ status: 'complete', stagePercentComplete: 100, result: { closed: 3 }, extra: { customerId: 7 } });
        expect(run?.errors).toEqual([{ stage: 'map', key: '12', message: 'locked' }]);
        expect(run?.finishedAt).not.toBeNull();
    });

    it('closes a run whose input stage failed as failed, with what NetSuite said', () => {
        const store = createJobRunStore(jobRuns);
        createTask.mockReturnValue({ submit: vi.fn(() => 'TASK_7') } as never);
        const runId = store.start(closeStaleOrders, {});
        runningOn('customdeploy_demo_close_stale_mr', runId);

        store.closeRun(closeStaleOrders, summarizeContextFor({ inputError: 'the query would not run' }), null);

        expect(store.read(runId)).toMatchObject({ status: 'failed', errors: [{ stage: 'input', message: 'the query would not run' }] });
    });

    it('finds the runs to clean up by age', () => {
        runSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: 11 }, { id: 12 }] } as never);

        expect(createJobRunStore(jobRuns).findExpired(7)).toEqual(['11', '12']);
        expect(runSuiteQL).toHaveBeenCalledWith({ query: expect.stringContaining('customrecord_demo_job_run'), params: [7] });
    });
});
