import * as https from 'N/https';
import { ENDPOINT_PARAMETER, type ApiEnvelope, type EndpointRequest, type EndpointResponse, type Endpoints, type ScriptRef } from '../index.js';
import { ApiError } from './apiError.js';

/**
 * Calls another controller of the application from server code, the way the browser client does
 * from the browser: by its scripts entry and the type of its endpoints, one endpoint at a time,
 * synchronously. Only a Suitelet is reachable this way (https.requestSuitelet rides the caller's
 * session). The usual reason to call one is that it is deployed to run as a role the caller lacks.
 * A repository builds the client, so the service never knows the answer came from another script.
 */

/** One function per endpoint, typed by the controller's handlers: `userRolesApi.byEmployee({ employeeId })`. */
export type SuiteletClient<TEndpoints extends Endpoints> = {
    readonly [TName in keyof TEndpoints]: (request: EndpointRequest<TEndpoints[TName]>) => EndpointResponse<TEndpoints[TName]>;
};

function parseEnvelope<TData>(scriptRef: ScriptRef, endpointName: string, body: string): ApiEnvelope<TData> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        parsed = undefined;
    }
    if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed as ApiEnvelope<TData>;
    throw new ApiError(502, `${scriptRef.scriptId} did not answer with the API envelope.`, { script: scriptRef.scriptId, endpoint: endpointName, body: body.slice(0, 500) });
}

/**
 * Calls one endpoint of a Suitelet controller: a POST whose JSON body carries the request and the
 * endpoint name. A transport failure is a 502; an error envelope keeps the status the Suitelet
 * answered with.
 */
export function callSuiteletEndpoint<TData>(scriptRef: ScriptRef, endpointName: string, request: object = {}): TData {
    if (scriptRef.kind !== 'suitelet') {
        throw new Error(`${scriptRef.scriptId} is a ${scriptRef.kind}; server code reaches Suitelets only.`);
    }
    const response = https.requestSuitelet({
        scriptId: scriptRef.scriptId,
        deploymentId: scriptRef.deployId,
        method: https.Method.POST,
        body: JSON.stringify({ ...request, [ENDPOINT_PARAMETER]: endpointName }),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    if (response.code !== 200) {
        throw new ApiError(502, `${scriptRef.scriptId} answered HTTP ${response.code}.`, { script: scriptRef.scriptId, endpoint: endpointName });
    }
    const envelope = parseEnvelope<TData>(scriptRef, endpointName, response.body);
    if (envelope.error !== null || envelope.status >= 400) {
        throw new ApiError(envelope.status, envelope.error ?? `Request failed (${envelope.status})`, { script: scriptRef.scriptId, endpoint: endpointName });
    }
    return envelope.data as TData;
}

/**
 * Builds the typed client for a Suitelet controller from its scripts entry: `createSuiteletClient<UserRolesEndpoints>(scripts.userRoles)`.
 * The endpoint names come from the type alone; the property accessed is the endpoint named on the wire.
 */
export function createSuiteletClient<TEndpoints extends Endpoints>(scriptRef: ScriptRef): SuiteletClient<TEndpoints> {
    return new Proxy({} as SuiteletClient<TEndpoints>, {
        get(_target, endpointName) {
            if (typeof endpointName !== 'string') return undefined;
            return (request: unknown) => callSuiteletEndpoint(scriptRef, endpointName, (request ?? {}) as object);
        },
    });
}
