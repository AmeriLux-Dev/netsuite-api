import { ENDPOINT_PARAMETER, type ApiEnvelope, type EndpointRequest, type EndpointResponse, type Endpoints, type RawResponse, type ScriptKind, type ScriptRef } from '../index.js';

/**
 * Calls an API controller by its script and deployment ids, one endpoint at a time. The entry's
 * `kind` decides the URL, so a controller can move between Restlet and Suitelet without touching
 * the caller. In the deployed app the call rides the NetSuite session on the same origin; a
 * development server that proxies to a sandbox sets its own base paths with configureApiClient.
 *
 * Every failure is one error type, ApiClientError, and is handed to the configured error handler
 * before the call rejects: the app reports failures in one place, and a hook or a page adds error
 * handling only when it wants something other than the default.
 */

export interface ApiCallOptions {
    signal?: AbortSignal;
    /**
     * Whether the configured error handler is told when this call fails. True unless set: a caller
     * that reports the failure itself (a form showing it inline) passes false. The call rejects either way.
     */
    handleError?: boolean;
}

/** The status of an ApiClientError for a call that got no answer at all: the network, not the script, failed. */
export const NO_RESPONSE_STATUS = 0;

export class ApiClientError extends Error {
    constructor(readonly status: number, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'ApiClientError';
    }
}

/** What the error handler is told about the call that failed. */
export interface ApiCallContext {
    scriptRef: ScriptRef;
    endpoint: string;
    request: unknown;
}

/** Runs for a failed call before it rejects. It reports; it does not recover, and it must not throw. */
export type ApiErrorHandler = (error: ApiClientError, context: ApiCallContext) => void;

/** The path each script kind is served from, without the script and deploy query parameters. */
export type ApiBasePaths = Record<ScriptKind, string>;

/** Where NetSuite serves Restlets and Suitelets on the account's own origin. */
export const NETSUITE_API_BASE_PATHS: ApiBasePaths = {
    restlet: '/app/site/hosting/restlet.nl',
    suitelet: '/app/site/hosting/scriptlet.nl',
};

export interface ApiClientConfiguration {
    /** Base paths to use instead of NetSuite's own, e.g. the routes of a local development proxy. */
    basePaths?: Partial<ApiBasePaths>;
    /**
     * Told about every failed call, unless the call passed `handleError: false`, before the call
     * rejects. The rejection still reaches the caller (a query sees its error state), so the handler
     * is where the app reports: a banner, a log, a redirect on 401. An aborted call is not a failure
     * and never reaches it.
     */
    onError?: ApiErrorHandler;
}

let configuredBasePaths: ApiBasePaths = NETSUITE_API_BASE_PATHS;
let configuredErrorHandler: ApiErrorHandler | undefined;

/**
 * Sets where calls go and who hears about failures. Call it once at startup, before the first call;
 * a client built earlier picks the change up because both are read per call. Without a call,
 * NetSuite's own paths apply and failures only reject.
 */
export function configureApiClient(configuration: ApiClientConfiguration): void {
    configuredBasePaths = { ...NETSUITE_API_BASE_PATHS, ...configuration.basePaths };
    configuredErrorHandler = configuration.onError;
}

export function buildApiUrl(scriptRef: ScriptRef): string {
    const parameters = new URLSearchParams({ script: scriptRef.scriptId, deploy: scriptRef.deployId });
    return `${configuredBasePaths[scriptRef.kind]}?${parameters.toString()}`;
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/**
 * Runs one call: whatever fails inside becomes an ApiClientError (a fetch that never answered gets
 * NO_RESPONSE_STATUS), goes to the configured handler unless the call opted out, and rejects. An
 * abort is the caller's own doing and passes through untouched.
 */
async function reportingFailures<TResult>(scriptRef: ScriptRef, endpointName: string, request: object, options: ApiCallOptions, call: () => Promise<TResult>): Promise<TResult> {
    try {
        return await call();
    } catch (error) {
        if (isAbort(error)) throw error;
        const failure = error instanceof ApiClientError ? error : new ApiClientError(NO_RESPONSE_STATUS, `Could not reach ${scriptRef.scriptId}.${endpointName}: ${error instanceof Error ? error.message : String(error)}`, error);
        if (options.handleError !== false) configuredErrorHandler?.(failure, { scriptRef, endpoint: endpointName, request });
        throw failure;
    }
}

/** The POST every call is: the request plus the endpoint name, as JSON. */
function postEndpoint(scriptRef: ScriptRef, endpointName: string, request: object, options: ApiCallOptions): Promise<Response> {
    return fetch(buildApiUrl(scriptRef), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...request, [ENDPOINT_PARAMETER]: endpointName }),
        signal: options.signal,
    });
}

function parseEnvelope<TData>(text: string): ApiEnvelope<TData> | undefined {
    try {
        const parsed: unknown = text ? JSON.parse(text) : undefined;
        return parsed && typeof parsed === 'object' && 'status' in parsed ? (parsed as ApiEnvelope<TData>) : undefined;
    } catch {
        return undefined;
    }
}

/** Calls one endpoint of a controller: a POST whose JSON body carries the request and the endpoint name. */
export function callEndpoint<TData>(scriptRef: ScriptRef, endpointName: string, request: object = {}, options: ApiCallOptions = {}): Promise<TData> {
    return reportingFailures(scriptRef, endpointName, request, options, async () => {
        const response = await postEndpoint(scriptRef, endpointName, request, options);
        const text = await response.text();
        const envelope = parseEnvelope<TData>(text);
        if (!envelope) {
            throw new ApiClientError(response.status, `Unexpected response from ${scriptRef.scriptId} (${response.status})`, text.slice(0, 500));
        }
        if (envelope.error !== null || envelope.status >= 400) {
            throw new ApiClientError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`, envelope.details);
        }
        return envelope.data as TData;
    });
}

/**
 * Calls an endpoint that answers with a document instead of the envelope (a Suitelet handler returning
 * rawResponse) and resolves to its body as a Blob. A failure still arrives as an envelope, and is
 * thrown as an ApiClientError with its status.
 */
export function callRawEndpoint(scriptRef: ScriptRef, endpointName: string, request: object = {}, options: ApiCallOptions = {}): Promise<Blob> {
    return reportingFailures(scriptRef, endpointName, request, options, async () => {
        const response = await postEndpoint(scriptRef, endpointName, request, options);
        const contentType = response.headers.get('Content-Type') ?? '';
        if (!response.ok || contentType.includes('application/json')) {
            const text = await response.text();
            const envelope = parseEnvelope<unknown>(text);
            if (envelope && (envelope.error !== null || envelope.status >= 400)) throw new ApiClientError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`, envelope.details);
            if (!response.ok) throw new ApiClientError(response.status, `Unexpected response from ${scriptRef.scriptId} (${response.status})`, text.slice(0, 500));
            throw new ApiClientError(response.status, `${scriptRef.scriptId}.${endpointName} answered JSON where a document was expected.`, text.slice(0, 500));
        }
        return response.blob();
    });
}

/** What the client resolves to for an endpoint's response type: a Blob for a raw answer, the data otherwise. */
export type ClientResponse<TResponse> = TResponse extends RawResponse ? Blob : TResponse;

/**
 * One function per endpoint, typed by the controller's handlers: `user.api.roles()`,
 * `orders.api.byId({ id })`, `exports.api.csv({ month })` resolving to a Blob. The request comes first,
 * the call options second.
 */
export type ApiClient<TEndpoints extends Endpoints> = {
    readonly [TName in keyof TEndpoints]: (request: EndpointRequest<TEndpoints[TName]>, options?: ApiCallOptions) => Promise<ClientResponse<EndpointResponse<TEndpoints[TName]>>>;
};

export interface ApiClientOptions {
    /** The endpoints that answer with a document: the generator lists every handler whose return type is RawResponse. */
    rawEndpoints?: readonly string[];
}

/**
 * Builds the typed client for a controller from its script: `createApiClient<Endpoints>({ kind, scriptId, deployId })`.
 * The endpoint names come from the type alone; the property accessed is the endpoint named on the wire.
 * The generated module of a browser-facing controller calls this once.
 */
export function createApiClient<TEndpoints extends Endpoints>(scriptRef: ScriptRef, clientOptions: ApiClientOptions = {}): ApiClient<TEndpoints> {
    const rawEndpoints = new Set(clientOptions.rawEndpoints ?? []);
    return new Proxy({} as ApiClient<TEndpoints>, {
        get(_target, endpointName) {
            if (typeof endpointName !== 'string') return undefined;
            const call = rawEndpoints.has(endpointName) ? callRawEndpoint : callEndpoint;
            return (request: unknown, options?: ApiCallOptions) => call(scriptRef, endpointName, (request ?? {}) as object, options);
        },
    });
}
