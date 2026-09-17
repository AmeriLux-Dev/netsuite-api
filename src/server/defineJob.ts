import * as log from 'N/log';
import * as runtime from 'N/runtime';
import type { EntryPoints } from 'N/types';
import type { JobParameterDeclaration, JobParameterValues, JobRunError, JobRunStage, JobRunsConfig, NetsuiteValueType } from '../index.js';
import { createJobRunStore } from './jobRuns.js';

/**
 * A job is a Map/Reduce script written as stages instead of entry points:
 *
 *     export const { getInputData, map, summarize } = defineJob({
 *         name: 'closeStaleOrders',
 *         scriptId: 'customscript_app_close_stale_orders_mr',
 *         deployments: ['customdeploy_app_close_stale_orders_mr', 'customdeploy_app_close_stale_orders_mr_2'],
 *         runParameter: 'custscript_app_close_stale_run',
 *         runs: jobRuns,
 *     }, {
 *         getInputData: (input: CloseStaleRequest): StaleOrder[] => listStaleOrders(input.olderThanDays),
 *         map: (order: StaleOrder, job) => { job.write(String(order.id), closeOrder(order.id)); },
 *         summarize: (summary): CloseStaleResult => ({ closed: summary.output.length }),
 *     });
 *
 * What the wrapper adds is the run: the values between stages are typed and parsed, getInputData's
 * input comes from the run record rather than a parameter the stage has to decode, summarize's
 * return value becomes the run's result, and the errors NetSuite collected are written onto the run
 * with it. A stage that throws marks the run failed and rethrows, so the failure is in the execution
 * log where NetSuite puts it and on the run where the page is looking.
 *
 * Export the stages the job has. Every job exports summarize even when it has no summarize stage of
 * its own, because that is where the run is closed. A stage exported but not declared throws when
 * NetSuite calls it, rather than quietly passing values through.
 */

/** A job's script: what the generator reads, and what the run record's rows point back at. */
export interface JobDeclaration<TParameters extends Record<string, JobParameterDeclaration> = Record<string, never>> {
    /** The job's name, as the run record records it and the scripts map keys it: the file name. */
    name: string;
    /** The script record's id, `customscript_<prefix>_<name>_mr`. */
    scriptId: string;
    /**
     * Every deployment of the script, in the order startJob tries them. NetSuite runs one instance of
     * a deployment at a time, so the length of this list is how many runs can overlap; a job started
     * from a page answers 409 when they are all busy.
     */
    deployments: string[];
    /** The script parameter carrying the run id, `custscript_<prefix>_<name>_run`. */
    runParameter: string;
    /** The job's own script parameters, by the name the stages use. */
    parameters?: TParameters;
    /** The application's run record, from the generated scripts map: `runs: jobRuns`. */
    runs: JobRunsConfig;
}

/** What every stage is given besides its own values. */
export interface JobContext<TParameters extends Record<string, JobParameterDeclaration>> {
    /** The run this stage belongs to, as the page polls it. */
    readonly runId: string;
    /** The script parameters the declaration names, typed. */
    readonly parameters: JobParameterValues<TParameters>;
}

/** A stage that writes values for the stage after it. */
export interface JobWriteContext<TParameters extends Record<string, JobParameterDeclaration>, TValue> extends JobContext<TParameters> {
    /** Hands one value to the next stage under a key; the value is carried as JSON and comes back typed. */
    write(key: string, value: TValue): void;
}

/** What the run produced, as summarize sees it. */
export interface JobSummary<TOutput> {
    /** Every key and value the reduce stage wrote, or the map stage's when the job has no reduce. */
    output: { key: string; value: TOutput }[];
    /** Everything that failed anywhere in the run; these are written onto the run whatever summarize returns. */
    errors: JobRunError[];
    seconds: number;
    usage: number;
    concurrency: number;
    yields: number;
}

/**
 * The stages of a job. getInputData's first parameter is the run's input and summarize's return type
 * is the run's result: the generator reads both from those annotations, the way it reads an endpoint's
 * request and response. The items getInputData returns are typed from there on.
 *
 * The values between map, reduce and summarize are carried as JSON, so each stage says what it
 * expects: a reduce stage writes `values: number[]` and a summarize stage `summary: JobSummary<Total>`,
 * and the wrapper hands them back as annotated. The stages are written as methods for that reason.
 */
export interface JobStages<
    TInput,
    TItem,
    TValue = unknown,
    TOutput = unknown,
    TResult = null,
    TParameters extends Record<string, JobParameterDeclaration> = Record<string, never>,
> {
    getInputData(input: TInput, job: JobContext<TParameters>): TItem[] | Record<string, TItem>;
    map?(item: TItem, job: JobWriteContext<TParameters, TValue>): void;
    reduce?(key: string, values: TValue[], job: JobWriteContext<TParameters, TOutput>): void;
    summarize?(summary: JobSummary<TOutput>, job: JobContext<TParameters>): TResult;
}

/** The four NetSuite entry points, of which a job file exports the ones it has. */
export interface JobEntryPoints {
    getInputData: (context: EntryPoints.MapReduce.getInputDataContext) => unknown;
    map: (context: EntryPoints.MapReduce.mapContext) => void;
    reduce: (context: EntryPoints.MapReduce.reduceContext) => void;
    summarize: (context: EntryPoints.MapReduce.summarizeContext) => void;
}

function readParameterValue(id: string, type: NetsuiteValueType): unknown {
    const raw = runtime.getCurrentScript().getParameter({ name: id });
    if (raw === null || raw === undefined || raw === '') return type === 'checkbox' ? false : type === 'integer' || type === 'decimal' ? 0 : '';
    if (type === 'integer' || type === 'decimal') return Number(raw);
    if (type === 'checkbox') return raw === true || raw === 'T' || raw === 'true';
    if (raw instanceof Date) return raw.toISOString();
    return String(raw);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The errors NetSuite collected, in the order the run met them. */
function readCollectedErrors(summary: EntryPoints.MapReduce.summarizeContext): JobRunError[] {
    const errors: JobRunError[] = [];
    if (summary.inputSummary?.error) errors.push({ stage: 'input', message: summary.inputSummary.error });
    const collect = (stage: Extract<JobRunStage, 'map' | 'reduce'>, container?: EntryPoints.MapReduce.MapSummary | EntryPoints.MapReduce.ReduceSummary) => {
        container?.errors.iterator().each((key, error) => {
            errors.push({ stage, key, message: error });
            return true;
        });
    };
    collect('map', summary.mapSummary);
    collect('reduce', summary.reduceSummary);
    return errors;
}

export function defineJob<
    TInput,
    TItem,
    TValue = unknown,
    TOutput = unknown,
    TResult = null,
    TParameters extends Record<string, JobParameterDeclaration> = Record<string, never>,
>(declaration: JobDeclaration<TParameters>, stages: JobStages<TInput, TItem, TValue, TOutput, TResult, TParameters>): JobEntryPoints {
    const store = createJobRunStore(declaration.runs);
    const { name } = declaration;

    const readParameters = (): JobParameterValues<TParameters> => {
        const values: Record<string, unknown> = {};
        for (const [parameterName, parameter] of Object.entries(declaration.parameters ?? {})) values[parameterName] = readParameterValue(parameter.id, parameter.type);
        return values as JobParameterValues<TParameters>;
    };

    const readRunIdParameter = (): string | undefined => {
        const raw = runtime.getCurrentScript().getParameter({ name: declaration.runParameter });
        return typeof raw === 'string' && raw !== '' ? raw : undefined;
    };

    /**
     * The run a stage belongs to. getInputData has it from the parameter or opens one; the stages
     * after it read the parameter again, and a scheduled run (which has no parameter to read) is
     * found by the deployment it is running on, one run at a time being all a deployment can do.
     */
    const buildContext = (runIdSource: () => string): JobContext<TParameters> => {
        let resolvedRunId: string | undefined;
        let resolvedParameters: JobParameterValues<TParameters> | undefined;
        return {
            get runId() {
                resolvedRunId = resolvedRunId ?? runIdSource();
                return resolvedRunId;
            },
            get parameters() {
                resolvedParameters = resolvedParameters ?? readParameters();
                return resolvedParameters;
            },
        };
    };

    const lateRunId = (): string => {
        const deployment = String(runtime.getCurrentScript().deploymentId);
        return readRunIdParameter() ?? store.findRunningRunId(name, deployment) ?? '';
    };

    /** A stage's own failure: logged, written onto the run when the run is the only place it would show, and rethrown for NetSuite. */
    const runStage = <TStageResult>(stage: JobRunStage, context: JobContext<TParameters>, markRun: boolean, work: () => TStageResult): TStageResult => {
        try {
            return work();
        } catch (error) {
            const message = describeError(error);
            log.error('job stage failed', { job: name, stage, runId: context.runId, message });
            if (markRun && context.runId !== '') store.fail(context.runId, { stage, message });
            throw error;
        }
    };

    return {
        getInputData(scriptContext) {
            const deployment = String(runtime.getCurrentScript().deploymentId);
            const runId = store.claimRun({ job: name, runId: readRunIdParameter(), deployment });
            const context = buildContext(() => runId);
            log.audit('job started', { job: name, runId, deployment, restarted: scriptContext.isRestarted });
            return runStage('input', context, true, () => stages.getInputData(store.readInput<TInput>(runId), context));
        },

        map(scriptContext) {
            const context = buildContext(lateRunId);
            runStage('map', context, false, () => {
                if (!stages.map) throw new Error(`${name} declares no map stage; remove map from this file's exports.`);
                stages.map(JSON.parse(scriptContext.value) as TItem, {
                    get runId() {
                        return context.runId;
                    },
                    get parameters() {
                        return context.parameters;
                    },
                    write: (key, value) => scriptContext.write({ key, value: JSON.stringify(value) }),
                });
            });
        },

        reduce(scriptContext) {
            const context = buildContext(lateRunId);
            runStage('reduce', context, false, () => {
                if (!stages.reduce) throw new Error(`${name} declares no reduce stage; remove reduce from this file's exports.`);
                stages.reduce(
                    scriptContext.key,
                    scriptContext.values.map((value) => JSON.parse(value) as TValue),
                    {
                        get runId() {
                            return context.runId;
                        },
                        get parameters() {
                            return context.parameters;
                        },
                        write: (key, value) => scriptContext.write({ key, value: JSON.stringify(value) }),
                    },
                );
            });
        },

        summarize(scriptContext) {
            const context = buildContext(lateRunId);
            const errors = readCollectedErrors(scriptContext);
            const output: { key: string; value: TOutput }[] = [];
            scriptContext.output.iterator().each((key, value) => {
                output.push({ key, value: JSON.parse(value) as TOutput });
                return true;
            });
            const summary: JobSummary<TOutput> = {
                output,
                errors,
                seconds: scriptContext.seconds,
                usage: scriptContext.usage,
                concurrency: scriptContext.concurrency,
                yields: scriptContext.yields,
            };
            const result = runStage('summarize', context, true, () => (stages.summarize ? stages.summarize(summary, context) : null));
            const status = scriptContext.inputSummary?.error ? 'failed' : 'complete';
            if (context.runId !== '') store.finish(context.runId, { status, result, errors });
            log.audit('job finished', { job: name, runId: context.runId, status, errors: errors.length, seconds: scriptContext.seconds, usage: scriptContext.usage });
        },
    };
}
