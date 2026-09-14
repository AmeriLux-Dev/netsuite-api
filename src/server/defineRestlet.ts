import type { ApiEnvelope, Endpoints } from '../index.js';
import { invokeEndpoint } from './endpoint.js';

/**
 * Exposes a controller's endpoints as a Restlet: `export const post = defineRestlet('user', userEndpoints);`.
 * Every call is a POST whose JSON body names the endpoint, so `post` is the only entry point a
 * controller exports.
 */

export type RestletEntryPoint = (requestBody: unknown) => ApiEnvelope<unknown>;

export function defineRestlet(controllerName: string, endpoints: Endpoints): RestletEntryPoint {
    return (requestBody) => invokeEndpoint(controllerName, endpoints, requestBody);
}
