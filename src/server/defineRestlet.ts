import type { ApiEnvelope, Endpoints, ScriptDeclaration } from '../index.js';
import { invokeEndpoint } from './endpoint.js';

/**
 * Exposes a controller's endpoints as a Restlet:
 *
 *     export const post = defineRestlet({ name: 'user', scriptId: 'customscript_app_user', deployId: 'customdeploy_app_user' }, userEndpoints);
 *
 * Every call is a POST whose JSON body names the endpoint, so `post` is the only entry point a
 * controller exports. The declaration names the script the controller is deployed as; the generator
 * reads it from this call to build the clients.
 */

export type RestletEntryPoint = (requestBody: unknown) => ApiEnvelope<unknown>;

export function defineRestlet(script: ScriptDeclaration, endpoints: Endpoints): RestletEntryPoint {
    return (requestBody) => invokeEndpoint(script.name, endpoints, requestBody);
}
