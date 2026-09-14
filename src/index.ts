/**
 * The wire: what a controller answers with, how a call names its endpoint, and how a script is
 * reached. Both sides import this module; nothing in it touches NetSuite or the browser.
 */

/** Every controller answers with this envelope; `data` is null whenever `error` is set. */
export interface ApiEnvelope<TData> {
    status: number;
    error: string | null;
    data: TData | null;
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

/** How a script is reached over HTTP; the client builds the URL from it. */
export type ScriptKind = 'restlet' | 'suitelet';

/** One deployed script of the application, as the `scripts` map of the project declares it. */
export interface ScriptRef {
    kind: ScriptKind;
    scriptId: string;
    deployId: string;
    /**
     * False when only server code calls the script (a Suitelet deployed to run as another role, called
     * through the Suitelet client). The client generator then emits the controller's types but no client.
     * Defaults to true.
     */
    browser?: boolean;
}
