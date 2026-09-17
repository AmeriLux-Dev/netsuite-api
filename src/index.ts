/**
 * The wire: what a controller answers with, how a call names its endpoint, and how a script is
 * reached. Both sides import this module; nothing in it touches NetSuite or the browser.
 */

/**
 * Every controller answers with this envelope; `data` is null whenever `error` is set. `details` is
 * whatever the handler gave its ApiError (a per-field validation map, the offending id), sent so the
 * caller can act on it; a 500 carries none, its cause stays in the log.
 */
export interface ApiEnvelope<TData> {
    status: number;
    error: string | null;
    data: TData | null;
    details?: unknown;
}

/** The body of a failed call, as thrown by the client's ApiClientError. */
export interface ApiErrorBody {
    status: number;
    error: string;
    details?: unknown;
}

/**
 * Every call is a POST whose JSON body carries the request plus this property, naming which endpoint
 * of the controller the call is for.
 */
export const ENDPOINT_PARAMETER = 'endpoint';

/**
 * An endpoint as the controller declares it: a synchronous function from a request to a response.
 * The parameter type is the request shape and the return type the response shape; a handler with no
 * parameter takes no request. The clients derive their call signatures from these types.
 */
export type Endpoint = (request: never) => unknown;

/** A controller's endpoints by name: `typeof userEndpoints`, the type the clients are built from. */
export type Endpoints = Record<string, Endpoint>;

/** The request type of an endpoint, or void when its handler takes no parameter. */
export type EndpointRequest<TEndpoint extends Endpoint> = Parameters<TEndpoint> extends [] ? void : Parameters<TEndpoint>[0];

/** The response type of an endpoint: what its handler returns. */
export type EndpointResponse<TEndpoint extends Endpoint> = ReturnType<TEndpoint>;

/**
 * What a Suitelet endpoint returns to answer with something other than the JSON envelope: a file
 * download, a CSV, a rendered PDF. The server builds one with rawResponse(); the browser client
 * resolves such an endpoint to a Blob. A Restlet cannot answer with one. A handler that answers this
 * way writes `RawResponse` as its return type, exactly, so the generator can tell the client.
 */
export interface RawResponse {
    readonly isRawResponse: true;
}

/** How a script is reached over HTTP; the client builds the URL from it. */
export type ScriptKind = 'restlet' | 'suitelet';

/**
 * What a controller declares about the script that serves it, passed to defineRestlet or
 * defineSuitelet. Nothing here creates or deploys anything: the controller builds, tests and bundles
 * before a script record exists. The ids are how a client reaches the controller once it is deployed,
 * so they are set to whatever the script record and its deployment are called in NetSuite (and in
 * the SDF object under netsuite/Objects); the generator wires every client to them as long as they
 * match.
 */
export interface ScriptDeclaration {
    /** The controller's name, as the logs and the generated clients call it: `user` for userController.ts. */
    name: string;
    /**
     * The script record's id, `customscript_<prefix>_<name>`. Change it freely to match the record in
     * NetSuite; the generated clients follow.
     */
    scriptId: string;
    /** The deployment's id, `customdeploy_<prefix>_<name>`, with the same freedom as scriptId. */
    deployId: string;
    /**
     * False when only server code calls the script (a Suitelet deployed to run as another role, called
     * through the Suitelet client). The generator then emits the controller's types but no browser
     * client. Defaults to true.
     */
    browser?: boolean;
}

/** One deployed script as a client reaches it: the declaration plus how it is served. */
export interface ScriptRef {
    kind: ScriptKind;
    scriptId: string;
    deployId: string;
    browser?: boolean;
}

/**
 * Jobs: the Map/Reduce side of the wire. A job answers nothing, so its run is the thing both sides
 * talk about: server code starts one and gets a run id, and the browser asks what that run is doing.
 * A run lives in a record of the application's own (`customrecord_<prefix>_job_run`, whose ids the
 * generator reads from netsuite-api.config.json), so a job that dies before it writes anything is
 * still a run that failed, not a page waiting forever.
 */

/** How NetSuite stores a script parameter or a run field, and the type the stages and the page see. */
export type NetsuiteValueType = 'text' | 'integer' | 'decimal' | 'checkbox' | 'date' | 'select';

/** One script parameter of a job: its id in NetSuite and what NetSuite stores in it. */
export interface JobParameterDeclaration {
    id: string;
    type: NetsuiteValueType;
}

/** The value of one parameter as the stages see it. A date arrives as the ISO string, never a Date: a stage is not the wire, but a run record is read by both sides. */
export type JobParameterValue<TType extends NetsuiteValueType> = TType extends 'integer' | 'decimal' ? number : TType extends 'checkbox' ? boolean : string;

/** Every parameter a job declares, by the name the stages use. */
export type JobParameterValues<TParameters extends Record<string, JobParameterDeclaration>> = {
    readonly [TName in keyof TParameters]: JobParameterValue<TParameters[TName]['type']>;
};

/** Where a run is: NetSuite's own stage names, as the run record and the page speak them. */
export type JobRunStage = 'input' | 'map' | 'shuffle' | 'reduce' | 'summarize';

/**
 * A run's state. `pending` is submitted but not started, `running` is anything between, and
 * `complete` means summarize wrote the result. `failed` is either a stage that threw or a task
 * NetSuite gave up on, which is why a run is read through checkStatus as well as its record.
 */
export type JobRunStatus = 'pending' | 'running' | 'complete' | 'failed';

/** One thing that went wrong in a run: a stage's own throw, or a key NetSuite could not finish. */
export interface JobRunError {
    stage: JobRunStage;
    /** The key the map or reduce stage was working on, when the failure belongs to one. */
    key?: string;
    message: string;
}

/**
 * A run as anyone asking about it sees it: the record's own fields refined by what NetSuite says
 * about the task. Every time is an ISO string, so this shape crosses to the browser unchanged.
 */
export interface JobRun<TResult = unknown, TExtra extends Record<string, unknown> = Record<string, never>> {
    /** The run record's internal id: what startJob answers and a page polls with. */
    id: string;
    /** The job's name, as its declaration gives it. */
    job: string;
    status: JobRunStatus;
    /** The stage the task is in, or null before it starts and after it ends. */
    stage: JobRunStage | null;
    /**
     * How far the stage being processed has got, 0 to 100, as NetSuite reports it. It counts up inside a
     * stage and starts again at the next one, so it is progress rather than a fraction of the whole run;
     * a finished run reads 100. For something to put next to a progress bar, prefer the item counts.
     */
    stagePercentComplete: number;
    /** Rows the stage being processed has finished, or null when the task can no longer say. */
    itemsProcessed: number | null;
    /** Rows the stage being processed was given, or null when the task can no longer say: a run that has ended, or an id NetSuite has purged. */
    itemsTotal: number | null;
    /** The employee who started it, or null for a scheduled run. */
    startedBy: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** The NetSuite task id, kept so a run can be asked about after the fact. */
    taskId: string | null;
    /** What summarize returned, once it has. */
    result: TResult | null;
    errors: JobRunError[];
    /** The fields this application added to the run record, as netsuite-api.config.json declares them. */
    extra: TExtra;
}

/**
 * A run as a list shows it: the fields a query can read, so finding a run costs one query rather than a
 * record load each. It carries no input, result or errors — a page finds a run here and then asks about
 * it by id, which is also the only reading that consults the task, so a `running` row in a list is
 * "last we knew", not a promise.
 */
export interface JobRunListEntry {
    id: string;
    job: string;
    status: JobRunStatus;
    stage: JobRunStage | null;
    stagePercentComplete: number;
    startedBy: number | null;
}

/** Which runs to list. Every field narrows; the newest are answered first. */
export interface JobRunQuery {
    job?: string;
    /** The employee who started them: how a page finds its own caller's runs again. */
    startedBy?: number;
    /** Only runs that have not ended, for "is one of these already going?". */
    unfinishedOnly?: boolean;
    /** How many, newest first. Defaults to 10, capped at 100. */
    limit?: number;
}

/** One deployed job as server code starts it: `scripts.<job>` in the generated scripts map. */
export interface JobRef {
    kind: 'mapreduce';
    /** The job's name, as its declaration gives it and the run record records it. */
    name: string;
    scriptId: string;
    /**
     * Every deployment the job may run on, in the order they are tried. NetSuite runs one instance of
     * a deployment at a time, so this list is how many runs of the job can overlap.
     */
    deployments: readonly string[];
    /** The script parameter the run id is passed in; every stage reads the run back from it. */
    runParameter: string;
    /** The job's own script parameters, by the name the stages use. */
    parameters?: Readonly<Record<string, string>>;
}

/** One field an application added to its run record, as netsuite-api.config.json declares it. */
export interface JobRunExtraField {
    id: string;
    type: NetsuiteValueType;
}

/**
 * The run record as this application deployed it, written by the generator from the `jobRuns` block
 * of netsuite-api.config.json. The field names are the package's; their ids are the application's,
 * because the record carries the application's prefix.
 */
export interface JobRunsConfig {
    recordType: string;
    fields: {
        job: string;
        status: string;
        stage: string;
        stagePercentComplete: string;
        input: string;
        result: string;
        errors: string;
        taskId: string;
        deployment: string;
        startedBy: string;
        startedAt: string;
        finishedAt: string;
    };
    /** Fields this application added, by the name the code uses for them. */
    extraFields: Readonly<Record<string, JobRunExtraField>>;
}
