import type { EntryPoints } from 'N/types';
import type { ApiEnvelope, Endpoints, ScriptDeclaration } from '../index.js';
import { invokeEndpoint } from './endpoint.js';

/**
 * Exposes a controller's endpoints as a JSON Suitelet:
 *
 *     export const onRequest = defineSuitelet({ name: 'userRoles', scriptId: '...', deployId: '...', browser: false }, userRolesEndpoints);
 *
 * A POST's JSON body names the endpoint; any other method is answered 405. The response is the same
 * envelope a Restlet returns, so a caller does not care which transport answered. The declaration
 * names the script the controller is deployed as; the generator reads it from this call.
 */

export type SuiteletEntryPoint = (context: EntryPoints.Suitelet.onRequestContext) => void;

export function defineSuitelet(script: ScriptDeclaration, endpoints: Endpoints): SuiteletEntryPoint {
    return (context) => {
        const method = context.request.method.toUpperCase();
        const envelope: ApiEnvelope<unknown> = method === 'POST'
            ? invokeEndpoint(script.name, endpoints, context.request.body)
            : { status: 405, error: `${script.name} answers POST, not ${method}.`, data: null };
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
        context.response.write({ output: JSON.stringify(envelope) });
    };
}
