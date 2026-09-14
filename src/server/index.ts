/**
 * The server side of the API: declare a controller's endpoints, expose them as a Restlet or a
 * Suitelet, reject a call with an ApiError, call another Suitelet controller from server code, and
 * find a File Cabinet file by name. Runs inside NetSuite only; the modules here import N/*.
 */
export { ApiError } from './apiError.js';
export { defineEndpoints, invokeEndpoint, parseEndpointRequest, readEndpointCall } from './endpoint.js';
export type { EndpointCall } from './endpoint.js';
export { defineRestlet } from './defineRestlet.js';
export type { RestletEntryPoint } from './defineRestlet.js';
export { defineSuitelet } from './defineSuitelet.js';
export type { SuiteletEntryPoint } from './defineSuitelet.js';
export { callSuiteletEndpoint, createSuiteletClient } from './suiteletClient.js';
export type { SuiteletClient } from './suiteletClient.js';
export { findFileId, findFolderId, getFileUrlByName } from './fileCabinet.js';
export type { FileCabinetLocation } from './fileCabinet.js';
export { ENDPOINT_PARAMETER } from '../index.js';
export type { ApiEnvelope, ApiErrorBody, Endpoint, Endpoints, EndpointRequest, EndpointResponse, ScriptKind, ScriptRef } from '../index.js';
