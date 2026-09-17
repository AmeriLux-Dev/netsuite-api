import type { EntryPoints } from 'N/types';

/**
 * The contexts NetSuite hands a Map/Reduce script, as plain objects a test can build. A job's stages
 * are called through its entry points, so a test calls the entry point with one of these and reads
 * what it wrote: `map(mapContextFor({ value: order }))`, then `written` for what reached the next
 * stage. Nothing here imports vitest, so it is safe in a vitest config's module graph as well.
 */

/** One key and value as a stage wrote it, already parsed back from the JSON the stage carried it as. */
export interface CapturedJobValue<TValue = unknown> {
    key: string;
    value: TValue;
}

export interface MapContextFake extends EntryPoints.MapReduce.mapContext {
    /** Everything the stage wrote, in order. */
    written: CapturedJobValue[];
}

export interface ReduceContextFake extends EntryPoints.MapReduce.reduceContext {
    written: CapturedJobValue[];
}

function emptyErrorIterator(): EntryPoints.MapReduce.MapReduceErrorIteratorContainer {
    return { iterator: () => ({ each: () => undefined }) };
}

function errorIterator(errors: { key: string; error: string }[]): EntryPoints.MapReduce.MapReduceErrorIteratorContainer {
    return {
        iterator: () => ({
            each: (callback: (key: string, error: string, executionNo: number) => boolean) => {
                for (const entry of errors) if (!callback(entry.key, entry.error, 1)) break;
            },
        }),
    };
}

function captureWrites(written: CapturedJobValue[]) {
    return (keyOrOptions: string | object, value?: string | object): void => {
        const pair = typeof keyOrOptions === 'string' ? { key: keyOrOptions, value } : (keyOrOptions as CapturedJobValue);
        written.push({ key: String(pair.key), value: typeof pair.value === 'string' ? JSON.parse(pair.value) : pair.value });
    };
}

/** The getInputData context. The input itself comes from the run record, so a test stubs the store, not this. */
export function getInputDataContextFor(options: { isRestarted?: boolean } = {}): EntryPoints.MapReduce.getInputDataContext {
    return { isRestarted: options.isRestarted ?? false, ObjectRef: { id: '', type: '' } };
}

/** The map context for one item; `value` is given as the item itself, the way getInputData returned it. */
export function mapContextFor(options: { value: unknown; key?: string; isRestarted?: boolean }): MapContextFake {
    const written: CapturedJobValue[] = [];
    return {
        isRestarted: options.isRestarted ?? false,
        executionNo: 1,
        errors: emptyErrorIterator(),
        key: options.key ?? '0',
        value: JSON.stringify(options.value),
        write: captureWrites(written) as EntryPoints.MapReduce.mapContext['write'],
        written,
    };
}

/** The reduce context for one key; `values` are given as the values themselves, the way the map stage wrote them. */
export function reduceContextFor(options: { key: string; values: unknown[]; isRestarted?: boolean }): ReduceContextFake {
    const written: CapturedJobValue[] = [];
    return {
        isRestarted: options.isRestarted ?? false,
        executionNo: 1,
        errors: emptyErrorIterator(),
        key: options.key,
        values: options.values.map((value) => JSON.stringify(value)),
        write: captureWrites(written) as EntryPoints.MapReduce.reduceContext['write'],
        written,
    };
}

/** The summarize context: what the reduce stage left, and whatever failed on the way. */
export function summarizeContextFor(
    options: {
        output?: CapturedJobValue[];
        inputError?: string;
        mapErrors?: { key: string; error: string }[];
        reduceErrors?: { key: string; error: string }[];
        seconds?: number;
        usage?: number;
    } = {},
): EntryPoints.MapReduce.summarizeContext {
    const output = options.output ?? [];
    const stageSummary = (errors: { key: string; error: string }[]) => ({
        dateCreated: new Date(),
        seconds: options.seconds ?? 0,
        usage: options.usage ?? 0,
        concurrency: 1,
        yields: 0,
        keys: { iterator: () => ({ each: () => undefined }) },
        errors: errors.length > 0 ? errorIterator(errors) : emptyErrorIterator(),
    });
    return {
        isRestarted: false,
        dateCreated: new Date(),
        seconds: options.seconds ?? 0,
        usage: options.usage ?? 0,
        concurrency: 1,
        yields: 0,
        inputSummary: { dateCreated: new Date(), error: options.inputError ?? '', seconds: options.seconds ?? 0, usage: options.usage ?? 0 },
        mapSummary: stageSummary(options.mapErrors ?? []),
        reduceSummary: stageSummary(options.reduceErrors ?? []),
        output: {
            iterator: () => ({
                each: (callback: (key: string, value: string) => boolean) => {
                    for (const entry of output) if (!callback(entry.key, JSON.stringify(entry.value))) break;
                },
            }),
        },
    };
}
