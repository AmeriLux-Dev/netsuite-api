import * as log from 'N/log';
import * as query from 'N/query';
import * as record from 'N/record';
import * as runtime from 'N/runtime';
import * as task from 'N/task';
import type { JobRef, JobRun, JobRunError, JobRunStage, JobRunStatus, JobRunsConfig, NetsuiteValueType } from '../index.js';
import { ApiError } from './apiError.js';

/**
 * The run record: everything a job run is, outside the job. A Map/Reduce script answers nothing and
 * cannot be waited on, so starting one writes a record first and passes its id in as the script
 * parameter; the stages read their input back from it and summarize writes the result to it. Reading
 * a run asks NetSuite about the task as well, which is what tells a run that died apart from one
 * still working: a record left at `running` under a task NetSuite has finished or given up on is a
 * failure, not something to keep polling.
 *
 * The record is the application's own (`customrecord_<prefix>_job_run`), so the ids come in as the
 * generated `jobRuns` config rather than being written here. A repository builds the store once and
 * the jobs build their own from the same config; nothing is global.
 */

/** What startJob may add to the run beyond the input: the application's own fields on the run record. */
export interface StartJobOptions {
    /** Values for the fields declared in `jobRuns.extraFields`, by name. */
    extra?: Record<string, unknown>;
}

/** What a stage's wrapper needs to find or open a run; not used by application code. */
export interface ClaimRunDetails {
    job: string;
    /** The run id the script parameter carried, or undefined for a scheduled run, which opens its own. */
    runId?: string;
    deployment: string;
}

/** How a run ended, as summarize leaves it. */
export interface FinishRunOutcome {
    status: Extract<JobRunStatus, 'complete' | 'failed'>;
    result: unknown;
    errors: JobRunError[];
}

export interface JobRunStore {
    /**
     * Starts a job: writes the run, then submits the task to the first deployment that takes it. The
     * run id is what a page polls with. Throws a 409 when every deployment is already running, and
     * leaves no run behind when it does, because nothing started.
     */
    start(job: JobRef, input?: unknown, options?: StartJobOptions): string;
    /** The run as anyone asking sees it: the record refined by what NetSuite says about the task. Null when the record is gone (cleaned up, or never existed). */
    read<TResult = unknown, TExtra extends Record<string, unknown> = Record<string, never>>(runId: string): JobRun<TResult, TExtra> | null;
    /** Run ids older than the given number of days, for the cleanup job. */
    findExpired(olderThanDays: number): string[];
    remove(runId: string): void;
    /** Opens the run a stage belongs to, creating one for a scheduled run. Called by the job wrapper. */
    claimRun(details: ClaimRunDetails): string;
    /** The input the run was started with; `{}` for a scheduled run. Called by the job wrapper. */
    readInput<TInput>(runId: string): TInput;
    /** The run id of whatever is running on this deployment, for the stages after getInputData. Called by the job wrapper. */
    findRunningRunId(job: string, deployment: string): string | undefined;
    /** Writes the result and the errors, and closes the run. Called by the job wrapper. */
    finish(runId: string, outcome: FinishRunOutcome): void;
    /** Marks the run failed with one error, for a stage that threw. Called by the job wrapper. */
    fail(runId: string, error: JobRunError): void;
}

const STAGE_BY_TASK_STAGE: Record<string, JobRunStage> = {
    GET_INPUT: 'input',
    MAP: 'map',
    SHUFFLE: 'shuffle',
    REDUCE: 'reduce',
    SUMMARIZE: 'summarize',
};

/** NetSuite hands a field back as whatever it stores; the declared type says what the code asked for. */
function readTypedValue(raw: unknown, type: NetsuiteValueType): unknown {
    if (raw === null || raw === undefined || raw === '') return null;
    if (type === 'integer' || type === 'decimal') {
        const parsed = Number(raw);
        return Number.isNaN(parsed) ? null : parsed;
    }
    if (type === 'checkbox') return raw === true || raw === 'T' || raw === 'true';
    if (raw instanceof Date) return raw.toISOString();
    return String(raw);
}

function writeTypedValue(value: unknown, type: NetsuiteValueType): record.FieldValue {
    if (value === null || value === undefined) return '';
    if (type === 'integer' || type === 'decimal') return Number(value);
    if (type === 'checkbox') return Boolean(value);
    if (type === 'date') return value instanceof Date ? value : String(value);
    return String(value);
}

function parseJsonField(raw: unknown, fallback: unknown): unknown {
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function readDateField(raw: unknown): string | null {
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === 'string' && raw !== '') return raw;
    return null;
}

/**
 * The store for one application's run record. Build it once where it is used: a repository for the
 * application's own calls, and the job wrapper for the stages.
 */
export function createJobRunStore(config: JobRunsConfig): JobRunStore {
    const { recordType, fields, extraFields } = config;

    function loadRun(runId: string): record.Record | undefined {
        try {
            return record.load({ type: recordType, id: runId });
        } catch (error) {
            log.debug('job run missing', { record: recordType, runId, message: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    function writeFields(runId: string, values: Record<string, record.FieldValue>): void {
        const runRecord = loadRun(runId);
        if (!runRecord) return;
        for (const [fieldId, value] of Object.entries(values)) runRecord.setValue({ fieldId, value });
        runRecord.save({ ignoreMandatoryFields: true });
    }

    function createRun(job: string, input: unknown, extra: Record<string, unknown> | undefined, startedBy: number | null): string {
        const runRecord = record.create({ type: recordType });
        runRecord.setValue({ fieldId: 'name', value: job });
        runRecord.setValue({ fieldId: fields.job, value: job });
        runRecord.setValue({ fieldId: fields.status, value: 'pending' satisfies JobRunStatus });
        runRecord.setValue({ fieldId: fields.input, value: JSON.stringify(input ?? {}) });
        if (startedBy !== null) runRecord.setValue({ fieldId: fields.startedBy, value: startedBy });
        for (const [name, value] of Object.entries(extra ?? {})) {
            const field = extraFields[name];
            if (!field) throw new Error(`The run record has no field '${name}'; declare it in the jobRuns block of netsuite-api.config.json.`);
            runRecord.setValue({ fieldId: field.id, value: writeTypedValue(value, field.type) });
        }
        return String(runRecord.save({ ignoreMandatoryFields: true }));
    }

    /** The task as NetSuite sees it, or undefined when it can no longer say (an id it has purged). */
    function checkTask(taskId: string): { status?: string; stage?: string; percentComplete: number } | undefined {
        try {
            const status = task.checkStatus({ taskId }) as unknown as {
                status?: string;
                stage?: string;
                getPercentageCompleted?: () => number;
            };
            return {
                status: status.status ?? undefined,
                stage: status.stage ?? undefined,
                percentComplete: typeof status.getPercentageCompleted === 'function' ? Number(status.getPercentageCompleted()) || 0 : 0,
            };
        } catch (error) {
            log.debug('job task unknown', { taskId, message: error instanceof Error ? error.message : String(error) });
            return undefined;
        }
    }

    return {
        start(job, input, options = {}) {
            const startedBy = runtime.getCurrentUser().id;
            const runId = createRun(job.name, input, options.extra, typeof startedBy === 'number' ? startedBy : null);
            const refusals: string[] = [];
            for (const deployment of job.deployments) {
                try {
                    const submitted = task
                        .create({ taskType: task.TaskType.MAP_REDUCE, scriptId: job.scriptId, deploymentId: deployment, params: { [job.runParameter]: runId } })
                        .submit();
                    writeFields(runId, { [fields.taskId]: submitted, [fields.deployment]: deployment });
                    log.audit('job submitted', { job: job.name, runId, taskId: submitted, deployment });
                    return runId;
                } catch (error) {
                    refusals.push(`${deployment}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            // Nothing started, so nothing is left to poll: the run is removed and the caller is told to try later.
            record.delete({ type: recordType, id: runId });
            log.audit('job not started', { job: job.name, deployments: job.deployments.length, refusals });
            throw ApiError.conflict(`${job.name} is already running on every deployment it has; try again shortly.`, { job: job.name, deployments: job.deployments.length });
        },

        read: function readRun<TResult, TExtra extends Record<string, unknown>>(runId: string): JobRun<TResult, TExtra> | null {
            const runRecord = loadRun(runId);
            if (!runRecord) return null;
            const readValue = (fieldId: string) => runRecord.getValue({ fieldId });
            let status = (readValue(fields.status) || 'pending') as JobRunStatus;
            let stage = (readValue(fields.stage) || null) as JobRunStage | null;
            let percentComplete = Number(readValue(fields.percentComplete)) || 0;
            const errors = parseJsonField(readValue(fields.errors), []) as JobRunError[];
            const taskId = (readValue(fields.taskId) || null) as string | null;

            // What NetSuite says about the task decides between "still working" and "died on the way".
            if (taskId !== null && (status === 'pending' || status === 'running')) {
                const taskStatus = checkTask(taskId);
                if (taskStatus?.status === 'FAILED') {
                    status = 'failed';
                    errors.push({ stage: stage ?? 'input', message: 'NetSuite stopped the task before it finished.' });
                } else if (taskStatus?.status === 'COMPLETE') {
                    // summarize writes the result before the task completes, so a complete task over a running record means it never got there.
                    status = 'failed';
                    errors.push({ stage: stage ?? 'summarize', message: 'The task finished without writing a result; see the script execution log.' });
                } else if (taskStatus?.status === 'PROCESSING') {
                    status = 'running';
                    stage = (taskStatus.stage && STAGE_BY_TASK_STAGE[taskStatus.stage]) || stage;
                    percentComplete = taskStatus.percentComplete || percentComplete;
                }
            }

            const extra: Record<string, unknown> = {};
            for (const [name, field] of Object.entries(extraFields)) extra[name] = readTypedValue(readValue(field.id), field.type);
            const startedBy = Number(readValue(fields.startedBy));
            return {
                id: runId,
                job: String(readValue(fields.job) ?? ''),
                status,
                stage,
                percentComplete,
                startedBy: Number.isNaN(startedBy) || startedBy === 0 ? null : startedBy,
                startedAt: readDateField(readValue(fields.startedAt)),
                finishedAt: readDateField(readValue(fields.finishedAt)),
                taskId,
                result: parseJsonField(readValue(fields.result), null) as TResult | null,
                errors,
                extra: extra as TExtra,
            };
        },

        findExpired(olderThanDays) {
            const results = query
                .runSuiteQL({ query: `SELECT id FROM ${recordType} WHERE created < SYSDATE - ?`, params: [olderThanDays] })
                .asMappedResults() as { id: string | number }[];
            return results.map((row) => String(row.id));
        },

        remove(runId) {
            record.delete({ type: recordType, id: runId });
        },

        claimRun({ job, runId, deployment }) {
            const claimed = runId ?? createRun(job, {}, undefined, null);
            writeFields(claimed, {
                [fields.status]: 'running' satisfies JobRunStatus,
                [fields.stage]: 'input' satisfies JobRunStage,
                [fields.deployment]: deployment,
                [fields.startedAt]: new Date(),
            });
            return claimed;
        },

        readInput(runId) {
            const runRecord = loadRun(runId);
            if (!runRecord) return {} as never;
            return parseJsonField(runRecord.getValue({ fieldId: fields.input }), {}) as never;
        },

        findRunningRunId(job, deployment) {
            const results = query
                .runSuiteQL({
                    query: `SELECT id FROM ${recordType} WHERE ${fields.job} = ? AND ${fields.deployment} = ? AND ${fields.status} = 'running' ORDER BY id DESC`,
                    params: [job, deployment],
                })
                .asMappedResults() as { id: string | number }[];
            return results.length > 0 ? String(results[0].id) : undefined;
        },

        finish(runId, { status, result, errors }) {
            writeFields(runId, {
                [fields.status]: status,
                [fields.stage]: 'summarize' satisfies JobRunStage,
                [fields.percentComplete]: 100,
                [fields.result]: JSON.stringify(result ?? null),
                [fields.errors]: JSON.stringify(errors),
                [fields.finishedAt]: new Date(),
            });
        },

        fail(runId, error) {
            const runRecord = loadRun(runId);
            if (!runRecord) return;
            const errors = parseJsonField(runRecord.getValue({ fieldId: fields.errors }), []) as JobRunError[];
            errors.push(error);
            runRecord.setValue({ fieldId: fields.status, value: 'failed' satisfies JobRunStatus });
            runRecord.setValue({ fieldId: fields.errors, value: JSON.stringify(errors) });
            runRecord.setValue({ fieldId: fields.finishedAt, value: new Date() });
            runRecord.save({ ignoreMandatoryFields: true });
        },
    };
}
