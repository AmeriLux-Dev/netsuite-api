import { ENDPOINT_PARAMETER, type ApiEnvelope, type EndpointRequest, type EndpointResponse, type Endpoints, type RawResponse, type ScriptKind, type ScriptRef } from '../index.js';

/**
 * Calls an API controller by its script and deployment ids, one endpoint at a time. The entry's
 * `kind` decides the URL, so a controller can move between Restlet and Suitelet without touching
 * the caller. In the deployed app the call rides the NetSuite session on the same origin; a
 * development server that proxies to a sandbox sets its own base paths with configureApiClient.
 */

export interface ApiCallOptions {
    signal?: AbortSignal;
}

export class ApiClientError extends Error {
    constructor(readonly status: number, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'ApiClientError';
    }
}

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
}

let configuredBasePaths: ApiBasePaths = NETSUITE_API_BASE_PATHS;

/**
 * Sets where calls go. Call it once at startup, before the first call; a client built earlier picks
 * the change up because the URL is built per call. Without a call, NetSuite's own paths apply.
 */
export function configureApiClient(configuration: ApiClientConfiguration): void {
    configuredBasePaths = { ...NETSUITE_API_BASE_PATHS, ...configuration.basePaths };
}

export function buildApiUrl(scriptRef: ScriptRef): string {
    const parameters = new URLSearchParams({ script: scriptRef.scriptId, deploy: scriptRef.deployId });
    return `${configuredBasePaths[scriptRef.kind]}?${parameters.toString()}`;
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
export async function callEndpoint<TData>(scriptRef: ScriptRef, endpointName: string, request: object = {}, options: ApiCallOptions = {}): Promise<TData> {
    const response = await postEndpoint(scriptRef, endpointName, request, options);
    const text = await response.text();
    const envelope = parseEnvelope<TData>(text);
    if (!envelope) {
        throw new ApiClientError(response.status, `Unexpected response from ${scriptRef.scriptId} (${response.status})`, text.slice(0, 500));
    }
    if (envelope.error !== null || envelope.status >= 400) {
        throw new ApiClientError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`);
    }
    return envelope.data as TData;
}

/**
 * Calls an endpoint that answers with a document instead of the envelope (a Suitelet handler returning
 * rawResponse) and resolves to its body as a Blob. A failure still arrives as an envelope, and is
 * thrown as an ApiClientError with its status.
 */
export async function callRawEndpoint(scriptRef: ScriptRef, endpointName: string, request: object = {}, options: ApiCallOptions = {}): Promise<Blob> {
    const response = await postEndpoint(scriptRef, endpointName, request, options);
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!response.ok || contentType.includes('application/json')) {
        const text = await response.text();
        const envelope = parseEnvelope<unknown>(text);
        if (envelope && (envelope.error !== null || envelope.status >= 400)) throw new ApiClientError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`);
        if (!response.ok) throw new ApiClientError(response.status, `Unexpected response from ${scriptRef.scriptId} (${response.status})`, text.slice(0, 500));
        throw new ApiClientError(response.status, `${scriptRef.scriptId}.${endpointName} answered JSON where a document was expected.`, text.slice(0, 500));
    }
    return response.blob();
}

/** What the client resolves to for an endpoint's response type: a Blob for a raw answer, the data otherwise. */
export type ClientResponse<TResponse> = TResponse extends RawResponse ? Blob : TResponse;

/**
 * One function per endpoint, typed by the controller's handlers: `userApi.roles()`,
 * `ordersApi.byId({ id })`, `exportsApi.csv({ month })` resolving to a Blob. The request comes first,
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
 * Builds the typed client for a controller from its script: `createApiClient<UserEndpoints>({ kind, scriptId, deployId })`.
 * The endpoint names come from the type alone; the property accessed is the endpoint named on the wire.
 * The generated client module of a project calls this once per browser-facing controller.
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
