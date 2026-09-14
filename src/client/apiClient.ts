import { ENDPOINT_PARAMETER, type ApiEnvelope, type EndpointRequest, type EndpointResponse, type Endpoints, type ScriptKind, type ScriptRef } from '../index.js';

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

/** Calls one endpoint of a controller: a POST whose JSON body carries the request and the endpoint name. */
export async function callEndpoint<TData>(scriptRef: ScriptRef, endpointName: string, request: object = {}, options: ApiCallOptions = {}): Promise<TData> {
    const response = await fetch(buildApiUrl(scriptRef), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...request, [ENDPOINT_PARAMETER]: endpointName }),
        signal: options.signal,
    });

    let envelope: ApiEnvelope<TData> | undefined;
    const text = await response.text();
    try {
        envelope = text ? (JSON.parse(text) as ApiEnvelope<TData>) : undefined;
    } catch {
        envelope = undefined;
    }

    if (!envelope || typeof envelope !== 'object' || !('status' in envelope)) {
        throw new ApiClientError(response.status, `Unexpected response from ${scriptRef.scriptId} (${response.status})`, text.slice(0, 500));
    }
    if (envelope.error !== null || envelope.status >= 400) {
        throw new ApiClientError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`);
    }
    return envelope.data as TData;
}

/**
 * One function per endpoint, typed by the controller's handlers: `userApi.roles()`,
 * `ordersApi.byId({ id })`. The request comes first, the call options second.
 */
export type ApiClient<TEndpoints extends Endpoints> = {
    readonly [TName in keyof TEndpoints]: (request: EndpointRequest<TEndpoints[TName]>, options?: ApiCallOptions) => Promise<EndpointResponse<TEndpoints[TName]>>;
};

/**
 * Builds the typed client for a controller from its scripts entry: `createApiClient<UserEndpoints>(scripts.user)`.
 * The endpoint names come from the type alone; the property accessed is the endpoint named on the wire.
 * The generated client module of a project calls this once per browser-facing controller.
 */
export function createApiClient<TEndpoints extends Endpoints>(scriptRef: ScriptRef): ApiClient<TEndpoints> {
    return new Proxy({} as ApiClient<TEndpoints>, {
        get(_target, endpointName) {
            if (typeof endpointName !== 'string') return undefined;
            return (request: unknown, options?: ApiCallOptions) => callEndpoint(scriptRef, endpointName, (request ?? {}) as object, options);
        },
    });
}
