import * as log from 'N/log';
import { ENDPOINT_PARAMETER, type ApiEnvelope, type Endpoints } from '../index.js';
import { ApiError } from './apiError.js';
import { isRawResponse, type RawResponseOptions } from './rawResponse.js';

/**
 * Endpoints are the transport-agnostic unit of an API controller: named, each a synchronous function
 * from a request to a response, declared together in the controller file with the request and
 * response shapes they speak. The handler signatures are the contract: a client is built from
 * `typeof <name>Endpoints` and calls each endpoint by name. Every call is a POST whose body names the
 * endpoint. The controller file wraps the map as a Restlet (`defineRestlet`) or a Suitelet
 * (`defineSuitelet`); switching transport is a change to that one statement and its SDF object, never
 * to the endpoints.
 */

/**
 * Declares a controller's endpoints. Annotate each handler's parameter with its request type and its
 * return value with its response type; both reach the clients through the type, and the client
 * generator reads them from the annotations.
 */
export function defineEndpoints<TEndpoints extends Endpoints>(endpoints: TEndpoints): TEndpoints {
    return endpoints;
}

/** NetSuite hands a body as either an object or a JSON string. */
export function parseEndpointRequest(rawRequest: unknown): unknown {
    if (typeof rawRequest !== 'string') return rawRequest ?? {};
    const trimmed = rawRequest.trim();
    if (trimmed === '') return {};
    try {
        return JSON.parse(trimmed);
    } catch {
        throw ApiError.badRequest('Request body is not valid JSON.');
    }
}

export interface EndpointCall {
    /** The endpoint named by the request, or undefined when the property is missing. */
    name: string | undefined;
    /** Everything else in the body: the endpoint's own input. */
    request: Record<string, unknown>;
}

/** Splits the endpoint name off the parsed body. */
export function readEndpointCall(parsedRequest: unknown): EndpointCall {
    if (!parsedRequest || typeof parsedRequest !== 'object' || Array.isArray(parsedRequest)) {
        throw ApiError.badRequest('The request must be an object.');
    }
    const { [ENDPOINT_PARAMETER]: name, ...request } = parsedRequest as Record<string, unknown>;
    return { name: typeof name === 'string' && name !== '' ? name : undefined, request };
}

/** The call as the authorize hook sees it, once the endpoint is known to exist. */
export interface EndpointCallContext {
    controller: string;
    endpoint: string;
    request: Record<string, unknown>;
}

/**
 * Runs before every handler of a controller. Throw an ApiError to reject the call with its status
 * (`ApiError.forbidden()` for a role the session lacks); return to let it through. The hook decides
 * from the endpoint name and the request, and from whatever N/runtime says about the caller.
 */
export type AuthorizeEndpoint = (call: EndpointCallContext) => void;

/** What a controller may add to its define call, after the endpoints. */
export interface ControllerOptions {
    authorize?: AuthorizeEndpoint;
}

export interface InvokeEndpointOptions extends ControllerOptions {
    /** True for a Suitelet, which can write a raw response; a Restlet cannot, so a raw answer is a 500 there. */
    allowRawResponse?: boolean;
}

/** The envelope to send, or the raw answer to write instead. */
export interface EndpointOutcome {
    envelope: ApiEnvelope<unknown>;
    raw?: RawResponseOptions;
}

function describeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) return { message: error.message, stack: error.stack };
    return { message: String(error) };
}

function findEndpoint(controllerName: string, endpoints: Endpoints, call: EndpointCall): (request: never) => unknown {
    if (call.name === undefined) {
        throw ApiError.badRequest(`The ${ENDPOINT_PARAMETER} property is required.`, { controller: controllerName });
    }
    if (!Object.prototype.hasOwnProperty.call(endpoints, call.name)) {
        throw ApiError.notFound(`${controllerName} has no endpoint named ${call.name}.`, { controller: controllerName, endpoint: call.name });
    }
    return endpoints[call.name];
}

/**
 * Runs the endpoint the body names and produces the outcome: 200 with data (or a raw answer), an
 * ApiError's own status and message (400 without an endpoint name, 404 for an unknown one, whatever
 * the authorize hook threw), or 500 with the details logged. Audits the outcome and timing either
 * way. Log titles are constant phrases; the controller, endpoint and ids live in the details object.
 */
export function invokeEndpoint(controllerName: string, endpoints: Endpoints, rawRequest: unknown, options: InvokeEndpointOptions = {}): EndpointOutcome {
    const started = Date.now();
    let status = 200;
    let endpointName: string | undefined;
    try {
        const call = readEndpointCall(parseEndpointRequest(rawRequest));
        endpointName = call.name;
        const endpoint = findEndpoint(controllerName, endpoints, call);
        options.authorize?.({ controller: controllerName, endpoint: call.name as string, request: call.request });
        const data = endpoint(call.request as never);
        if (isRawResponse(data)) {
            if (!options.allowRawResponse) throw new Error(`${controllerName}.${endpointName} answered a raw response; only a Suitelet can write one.`);
            return { envelope: { status, error: null, data: null }, raw: data.options };
        }
        return { envelope: { status, error: null, data: data ?? null } };
    } catch (error) {
        if (error instanceof ApiError) {
            status = error.status;
            log.debug('endpoint rejected', { controller: controllerName, endpoint: endpointName, status, message: error.message, details: error.details });
            return { envelope: error.details === undefined ? { status, error: error.message, data: null } : { status, error: error.message, data: null, details: error.details } };
        }
        status = 500;
        log.error('endpoint failed', { controller: controllerName, endpoint: endpointName, ...describeError(error) });
        return { envelope: { status, error: 'Internal Server Error', data: null } };
    } finally {
        log.audit('endpoint completed', { controller: controllerName, endpoint: endpointName, status, durationMs: Date.now() - started });
    }
}
