import { describe, expect, it, vi } from 'vitest';
import { createJobStages } from '../../src/server/index.js';
import type { JobRef, JobRunStore } from '../../src/server/index.js';
import { mapContextFor, reduceContextFor, summarizeContextFor } from '../../src/testing/jobs.js';

/** A job as netsuite.ts writes it down, which is all a stage is given about the run it belongs to. */
const closeStaleOrders: JobRef = {
    name: 'closeStaleOrders',
    scriptId: 'customscript_demo_close_stale_mr',
    deployments: ['customdeploy_demo_close_stale_mr'],
    runParameter: 'custscript_demo_close_stale_run',
};

interface StaleOrder {
    id: number;
    owner: string;
}

interface CloseOutcome {
    orderId: number;
    closed: boolean;
}

/** The run record, stubbed: these tests are about what the builders do around a stage, not about the record. */
function storeFor(overrides: Partial<JobRunStore> = {}) {
    const store = {
        openRun: vi.fn(() => ({}) as never),
        currentRunId: vi.fn(() => '42'),
        closeRun: vi.fn(),
        start: vi.fn(),
        read: vi.fn(),
        findRuns: vi.fn(),
        findExpired: vi.fn(),
        remove: vi.fn(),
        ...overrides,
    } as unknown as JobRunStore;
    return { store, stages: createJobStages(store) };
}

describe('jobGetInputData', () => {
    it('opens the run and hands the stage what it was started with', () => {
        const { store, stages } = storeFor({ openRun: vi.fn(() => ({ olderThanDays: 30 }) as never) });
        const getInputData = stages.jobGetInputData<{ olderThanDays: number }, StaleOrder>(closeStaleOrders, (input) => [{ id: input.olderThanDays, owner: 'ada' }]);

        const items = getInputData({ isRestarted: false, ObjectRef: { id: '', type: '' } });

        expect(store.openRun).toHaveBeenCalledWith(closeStaleOrders);
        expect(items).toEqual([{ id: 30, owner: 'ada' }]);
    });

    it('asks for the run id only when the stage reaches for it', () => {
        const { store, stages } = storeFor();
        const runIds: string[] = [];
        const getInputData = stages.jobGetInputData<void, StaleOrder>(closeStaleOrders, (_input, job) => {
            runIds.push(job.runId, job.runId);
            return [];
        });

        getInputData({ isRestarted: false, ObjectRef: { id: '', type: '' } });

        expect(runIds).toEqual(['42', '42']);
        // Twice in the stage, once of the record: a stage that never asks costs nothing.
        expect(store.currentRunId).toHaveBeenCalledTimes(1);
    });
});

describe('jobMap and jobReduce', () => {
    it('hands the map stage its item parsed, and carries what it writes as JSON', () => {
        const { stages } = storeFor();
        const map = stages.jobMap<StaleOrder, CloseOutcome>(closeStaleOrders, (order, job) => {
            job.write(order.owner, { orderId: order.id, closed: true });
        });
        const context = mapContextFor({ value: { id: 7, owner: 'ada' } });

        map(context);

        expect(context.written).toEqual([{ key: 'ada', value: { orderId: 7, closed: true } }]);
    });

    it('hands the reduce stage every value of one key, parsed', () => {
        const { stages } = storeFor();
        const reduce = stages.jobReduce<CloseOutcome, number>(closeStaleOrders, (key, values, job) => {
            job.write(key, values.filter((value) => value.closed).length);
        });
        const context = reduceContextFor({ key: 'ada', values: [{ orderId: 7, closed: true }, { orderId: 8, closed: false }] });

        reduce(context);

        expect(context.written).toEqual([{ key: 'ada', value: 1 }]);
    });
});

describe('jobSummarize', () => {
    it('gathers what the run wrote, and closes the run with what the stage answers', () => {
        const { store, stages } = storeFor();
        const summarize = stages.jobSummarize<number, { closed: number; owners: string[] }>(closeStaleOrders, (summary) => ({
            closed: summary.output.reduce((total, entry) => total + entry.value, 0),
            owners: summary.output.map((entry) => entry.key),
        }));
        const context = summarizeContextFor({ output: [{ key: 'ada', value: 2 }, { key: 'grace', value: 3 }], seconds: 12 });

        summarize(context);

        expect(store.closeRun).toHaveBeenCalledWith(closeStaleOrders, context, { closed: 5, owners: ['ada', 'grace'] });
    });

    it('gives the stage everything NetSuite collected, so a run can answer for what failed', () => {
        const { stages } = storeFor();
        const seen: unknown[] = [];
        const summarize = stages.jobSummarize<number, null>(closeStaleOrders, (summary) => {
            seen.push(summary.errors, summary.seconds);
            return null;
        });

        summarize(summarizeContextFor({ mapErrors: [{ key: '12', error: 'locked' }], inputError: 'the query would not run', seconds: 4 }));

        expect(seen[0]).toEqual([
            { stage: 'input', message: 'the query would not run' },
            { stage: 'map', key: '12', message: 'locked' },
        ]);
        expect(seen[1]).toBe(4);
    });

    it('closes the run of a job that leaves nothing behind with null', () => {
        const { store, stages } = storeFor();
        const summarize = stages.jobSummarize<number, null>(closeStaleOrders, () => null);

        summarize(summarizeContextFor());

        expect(store.closeRun).toHaveBeenCalledWith(closeStaleOrders, expect.anything(), null);
    });
});
