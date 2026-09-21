import type { EntryPoints } from 'N/types';
import type { JobRef, JobRunError } from '../index.js';
import { readCollectedErrors } from './jobRuns.js';
import type { JobRunStore } from './jobRuns.js';

/**
 * The four stages of a Map/Reduce job, typed. A stage stays the entry point NetSuite calls and lives in
 * its own file; what these add is the two things every job would otherwise write out by hand — the JSON
 * between the stages, and the run:
 *
 *     export const map = jobMap<StaleOrder, CloseOutcome>(jobs.closeStaleOrders, (order, job) => {
 *         job.write(order.owner, { orderId: order.id, closed: closeOrder(order.id) });
 *     });
 *
 * The types are the stage's own claim about what it is handed and what it hands on, so `context.value`
 * arrives parsed and `job.write` carries the value as JSON without being asked. getInputData opens the
 * run and is given what it was started with; summarize's return value becomes the run's result and
 * closes the run. Between two files the claims are not compared — map saying it writes one shape and
 * summarize expecting another is two statements about a value neither file shares — so name the shape
 * where it is written and import it where it is read.
 *
 * A stage that wants NetSuite's context itself writes the plain entry point instead and calls the run
 * through the repository (`openJobRun`, `closeJobRun`); both are jobs, and the generator reads either.
 */

/** What a stage is told about the run it belongs to. */
export interface JobStageContext {
    /** The run this stage belongs to, as the page polls it; an empty string when there is no run to be found. */
    readonly runId: string;
}

/** A stage that hands values to the stage after it. */
export interface JobWriteContext<TValue> extends JobStageContext {
    /** Hands one value on under a key; it travels as JSON and arrives typed. */
    write(key: string, value: TValue): void;
}

/** What the run produced, as summarize is given it. */
export interface JobSummary<TOutput> {
    /** Every key and value the reduce stage wrote, or the map stage's when the job has no reduce. */
    output: { key: string; value: TOutput }[];
    /** Everything NetSuite collected anywhere in the run; these are written onto the run whatever summarize returns. */
    errors: JobRunError[];
    seconds: number;
    usage: number;
    concurrency: number;
    yields: number;
}

/** The four stage builders, each answering the entry point NetSuite calls. */
export interface JobStageBuilders {
    /**
     * The work a run is made of. The run is opened first, so the stage is given what the run was started
     * with — a run started on a schedule carries none, and the stage takes `void`.
     */
    jobGetInputData<TInput, TItem>(
        job: JobRef,
        stage: (input: TInput, context: JobStageContext) => TItem[] | Record<string, TItem>,
    ): (scriptContext: EntryPoints.MapReduce.getInputDataContext) => TItem[] | Record<string, TItem>;
    /** One item of the work. What it writes goes to the reduce stage, or to summarize when there is none. */
    jobMap<TItem, TValue>(job: JobRef, stage: (item: TItem, context: JobWriteContext<TValue>) => void): (scriptContext: EntryPoints.MapReduce.mapContext) => void;
    /** Everything the map stage wrote under one key. */
    jobReduce<TValue, TOutput>(job: JobRef, stage: (key: string, values: TValue[], context: JobWriteContext<TOutput>) => void): (scriptContext: EntryPoints.MapReduce.reduceContext) => void;
    /**
     * What the run came to. What the stage returns is written onto the run as its result and closes the
     * run, so a page polling it stops there; a run that leaves nothing behind returns null.
     */
    jobSummarize<TOutput, TResult>(job: JobRef, stage: (summary: JobSummary<TOutput>, context: JobStageContext) => TResult): (scriptContext: EntryPoints.MapReduce.summarizeContext) => void;
}

/**
 * The stage builders for one application, over its run record. Built once, where the run store is:
 *
 *     const jobRunStore = createJobRunStore(jobRuns);
 *     export const { jobGetInputData, jobMap, jobReduce, jobSummarize } = createJobStages(jobRunStore);
 */
export function createJobStages(store: JobRunStore): JobStageBuilders {
    /** The run, asked for once and only when a stage reaches for it. */
    const contextFor = (job: JobRef): JobStageContext => {
        let resolved: string | undefined;
        return {
            get runId() {
                resolved = resolved ?? store.currentRunId(job);
                return resolved;
            },
        };
    };

    const writeContextFor = <TValue>(job: JobRef, write: (options: { key: string; value: string }) => void): JobWriteContext<TValue> => {
        const context = contextFor(job);
        return {
            get runId() {
                return context.runId;
            },
            write: (key, value) => write({ key, value: JSON.stringify(value) }),
        };
    };

    return {
        jobGetInputData: function jobGetInputData<TInput, TItem>(job: JobRef, stage: (input: TInput, context: JobStageContext) => TItem[] | Record<string, TItem>) {
            return () => stage(store.openRun<TInput>(job), contextFor(job));
        },

        jobMap: function jobMap<TItem, TValue>(job: JobRef, stage: (item: TItem, context: JobWriteContext<TValue>) => void) {
            return (scriptContext: EntryPoints.MapReduce.mapContext) => {
                stage(JSON.parse(scriptContext.value) as TItem, writeContextFor<TValue>(job, (options) => scriptContext.write(options)));
            };
        },

        jobReduce: function jobReduce<TValue, TOutput>(job: JobRef, stage: (key: string, values: TValue[], context: JobWriteContext<TOutput>) => void) {
            return (scriptContext: EntryPoints.MapReduce.reduceContext) => {
                const values = scriptContext.values.map((value) => JSON.parse(value) as TValue);
                stage(scriptContext.key, values, writeContextFor<TOutput>(job, (options) => scriptContext.write(options)));
            };
        },

        jobSummarize: function jobSummarize<TOutput, TResult>(job: JobRef, stage: (summary: JobSummary<TOutput>, context: JobStageContext) => TResult) {
            return (scriptContext: EntryPoints.MapReduce.summarizeContext) => {
                const output: { key: string; value: TOutput }[] = [];
                scriptContext.output.iterator().each((key, value) => {
                    output.push({ key, value: JSON.parse(value) as TOutput });
                    return true;
                });
                const summary: JobSummary<TOutput> = {
                    output,
                    errors: readCollectedErrors(scriptContext),
                    seconds: scriptContext.seconds,
                    usage: scriptContext.usage,
                    concurrency: scriptContext.concurrency,
                    yields: scriptContext.yields,
                };
                store.closeRun(job, scriptContext, stage(summary, contextFor(job)));
            };
        },
    };
}
