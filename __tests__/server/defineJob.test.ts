import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as query from 'N/query';
import * as record from 'N/record';
import * as runtime from 'N/runtime';
import { defineJob } from '../../src/server/index.js';
import type { JobRunsConfig, JobSummary } from '../../src/server/index.js';
import { getInputDataContextFor, mapContextFor, reduceContextFor, summarizeContextFor } from '../../src/testing/jobs.js';

// The N/* stubs this package ships, named once: vi.mocked types them as the mocks they are.
const createRecord = vi.mocked(record.create);
const loadRecord = vi.mocked(record.load);
const runSuiteQL = vi.mocked(query.runSuiteQL);
const getCurrentScript = vi.mocked(runtime.getCurrentScript);
const getCurrentUser = vi.mocked(runtime.getCurrentUser);

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
    extraFields: {},
};

interface StaleOrder {
    id: number;
    customer: string;
}

interface CloseStaleInput {
    olderThanDays: number;
}

interface CloseStaleResult {
    closed: number;
    customers: string[];
}

const rows = new Map<string, Record<string, unknown>>();
const closedOrders: number[] = [];
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

/** The job under test: two stages and a summarize, the shape the template's snippet writes. */
function buildJob(overrides: { getInputData?: (input: CloseStaleInput) => StaleOrder[] } = {}) {
    return defineJob(
        {
            name: 'closeStaleOrders',
            scriptId: 'customscript_demo_close_stale_mr',
            deployments: ['customdeploy_demo_close_stale_mr'],
            runParameter: 'custscript_demo_close_stale_run',
            parameters: { batchSize: { id: 'custscript_demo_close_stale_batch', type: 'integer' } },
            runs: jobRuns,
        },
        {
            getInputData:
                overrides.getInputData ??
                ((input: CloseStaleInput, job): StaleOrder[] => [
                    { id: 1 + input.olderThanDays, customer: 'Acme' },
                    { id: job.parameters.batchSize, customer: 'Globex' },
                ]),
            map: (order: StaleOrder, job): void => {
                closedOrders.push(order.id);
                job.write(order.customer, order.id);
            },
            reduce: (customer: string, orderIds: number[], job): void => {
                job.write(customer, orderIds.length);
            },
            summarize: (summary: JobSummary<number>, job): CloseStaleResult => ({
                closed: summary.output.reduce((total, entry) => total + entry.value, 0),
                customers: [...summary.output.map((entry) => entry.key), `run:${job.runId}`],
            }),
        },
    );
}

function currentScript(parameters: Record<string, unknown>) {
    return {
        id: 'customscript_demo_close_stale_mr',
        deploymentId: 'customdeploy_demo_close_stale_mr',
        getParameter: ({ name }: { name: string }) => parameters[name] ?? '',
        getRemainingUsage: () => 1000,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    closedOrders.length = 0;
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
    runSuiteQL.mockReturnValue({ asMappedResults: () => [] } as never);
    getCurrentScript.mockReturnValue(currentScript({ custscript_demo_close_stale_run: '1', custscript_demo_close_stale_batch: 5 }) as never);
    getCurrentUser.mockReturnValue({ id: 9, name: 'Test User', role: 3, email: 'test@example.com' } as never);
    // The run the page started, with the input it was started with.
    rows.set('1', { custrecord_demo_jr_job: 'closeStaleOrders', custrecord_demo_jr_status: 'pending', custrecord_demo_jr_input: JSON.stringify({ olderThanDays: 30 } satisfies CloseStaleInput) });
    nextId = 2;
});

describe('getInputData', () => {
    it('hands the stage the input the run was started with, and the parameters typed', () => {
        const items = buildJob().getInputData(getInputDataContextFor()) as StaleOrder[];

        expect(items).toEqual([
            { id: 31, customer: 'Acme' },
            { id: 5, customer: 'Globex' },
        ]);
    });

    it('marks the run running before it asks for the work', () => {
        buildJob().getInputData(getInputDataContextFor());

        expect(rows.get('1')).toMatchObject({ custrecord_demo_jr_status: 'running', custrecord_demo_jr_stage: 'input', custrecord_demo_jr_deploy: 'customdeploy_demo_close_stale_mr' });
    });

    it('opens a run of its own when nothing passed one in, which is how a scheduled run is tracked', () => {
        getCurrentScript.mockReturnValue(currentScript({ custscript_demo_close_stale_batch: 2 }) as never);

        buildJob().getInputData(getInputDataContextFor());

        expect(rows.get('2')).toMatchObject({ custrecord_demo_jr_job: 'closeStaleOrders', custrecord_demo_jr_status: 'running' });
    });

    it('marks the run failed and rethrows when the stage throws', () => {
        const job = buildJob({
            getInputData: () => {
                throw new Error('the query would not run');
            },
        });

        expect(() => job.getInputData(getInputDataContextFor())).toThrow('the query would not run');
        expect(rows.get('1')).toMatchObject({ custrecord_demo_jr_status: 'failed' });
        expect(JSON.parse(String(rows.get('1')?.custrecord_demo_jr_errors))).toEqual([{ stage: 'input', message: 'the query would not run' }]);
    });
});

describe('map and reduce', () => {
    it('parses the item and carries what the stage writes to the next one', () => {
        const context = mapContextFor({ value: { id: 42, customer: 'Acme' } satisfies StaleOrder });

        buildJob().map(context);

        expect(closedOrders).toEqual([42]);
        expect(context.written).toEqual([{ key: 'Acme', value: 42 }]);
    });

    it('parses every value of a key for the reduce stage', () => {
        const context = reduceContextFor({ key: 'Acme', values: [1, 2, 3] });

        buildJob().reduce(context);

        expect(context.written).toEqual([{ key: 'Acme', value: 3 }]);
    });

    it('does not write the run for one item that failed; NetSuite collects those and summarize writes them', () => {
        const job = defineJob(
            { name: 'closeStaleOrders', scriptId: 'customscript_demo_close_stale_mr', deployments: ['customdeploy_demo_close_stale_mr'], runParameter: 'custscript_demo_close_stale_run', runs: jobRuns },
            {
                getInputData: (): StaleOrder[] => [],
                map: (): void => {
                    throw new Error('record was locked');
                },
                summarize: (): null => null,
            },
        );

        expect(() => job.map(mapContextFor({ value: { id: 1, customer: 'Acme' } }))).toThrow('record was locked');
        expect(rows.get('1')?.custrecord_demo_jr_status).toBe('pending');
    });

    it('says so plainly when a stage is exported but not declared', () => {
        const job = defineJob(
            { name: 'closeStaleOrders', scriptId: 'customscript_demo_close_stale_mr', deployments: ['customdeploy_demo_close_stale_mr'], runParameter: 'custscript_demo_close_stale_run', runs: jobRuns },
            { getInputData: (): StaleOrder[] => [], map: (): void => undefined, summarize: (): null => null },
        );

        expect(() => job.reduce(reduceContextFor({ key: 'Acme', values: [1] }))).toThrow(/declares no reduce stage/);
    });
});

describe('summarize', () => {
    it('writes what it returned to the run, with every error NetSuite collected', () => {
        buildJob().summarize(
            summarizeContextFor({
                output: [
                    { key: 'Acme', value: 2 },
                    { key: 'Globex', value: 1 },
                ],
                mapErrors: [{ key: '77', error: 'record was locked' }],
            }),
        );

        const row = rows.get('1') as Record<string, unknown>;
        expect(row.custrecord_demo_jr_status).toBe('complete');
        expect(JSON.parse(String(row.custrecord_demo_jr_result))).toEqual({ closed: 3, customers: ['Acme', 'Globex', 'run:1'] });
        expect(JSON.parse(String(row.custrecord_demo_jr_errors))).toEqual([{ stage: 'map', key: '77', message: 'record was locked' }]);
        expect(row.custrecord_demo_jr_percent).toBe(100);
    });

    it('calls the run failed when the input stage itself failed', () => {
        buildJob().summarize(summarizeContextFor({ inputError: 'the query would not run' }));

        expect(rows.get('1')?.custrecord_demo_jr_status).toBe('failed');
        expect(JSON.parse(String(rows.get('1')?.custrecord_demo_jr_errors))).toEqual([{ stage: 'input', message: 'the query would not run' }]);
    });

    it('closes the run with no result for a job that declares no summarize of its own', () => {
        const job = defineJob(
            { name: 'closeStaleOrders', scriptId: 'customscript_demo_close_stale_mr', deployments: ['customdeploy_demo_close_stale_mr'], runParameter: 'custscript_demo_close_stale_run', runs: jobRuns },
            { getInputData: (): StaleOrder[] => [], map: (): void => undefined },
        );

        job.summarize(summarizeContextFor());

        expect(rows.get('1')).toMatchObject({ custrecord_demo_jr_status: 'complete', custrecord_demo_jr_result: 'null' });
    });

    it('finds the run by its deployment when no parameter carried it', () => {
        getCurrentScript.mockReturnValue(currentScript({ custscript_demo_close_stale_batch: 5 }) as never);
        rows.set('7', { custrecord_demo_jr_job: 'closeStaleOrders', custrecord_demo_jr_status: 'running', custrecord_demo_jr_input: '{}' });
        runSuiteQL.mockReturnValue({ asMappedResults: () => [{ id: 7 }] } as never);

        buildJob().summarize(summarizeContextFor({ output: [{ key: 'Acme', value: 4 }] }));

        expect(rows.get('7')).toMatchObject({ custrecord_demo_jr_status: 'complete' });
        expect(rows.get('1')?.custrecord_demo_jr_status).toBe('pending');
    });
});
