/**
 * The browser side of the API: a typed client per controller, built from the endpoint types the
 * generator writes into the project's client module. Runs in the browser only; nothing here imports N/*.
 */
export { ApiClientError, NETSUITE_API_BASE_PATHS, buildApiUrl, callEndpoint, callRawEndpoint, configureApiClient, createApiClient } from './apiClient.js';
export type { ApiBasePaths, ApiCallOptions, ApiClient, ApiClientConfiguration, ApiClientOptions, ClientResponse } from './apiClient.js';
export { ENDPOINT_PARAMETER } from '../index.js';
export type { ApiEnvelope, ApiErrorBody, Endpoint, Endpoints, EndpointRequest, EndpointResponse, RawResponse, ScriptDeclaration, ScriptKind, ScriptRef } from '../index.js';
