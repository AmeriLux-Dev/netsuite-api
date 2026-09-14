import type { EntryPoints } from 'N/types';
import type { ApiEnvelope, Endpoints, ScriptDeclaration } from '../index.js';
import { invokeEndpoint, type ControllerOptions } from './endpoint.js';
import { writeRawResponse } from './rawResponse.js';

/**
 * Exposes a controller's endpoints as a JSON Suitelet:
 *
 *     export const onRequest = defineSuitelet({ name: 'userRoles', scriptId: '...', deployId: '...', browser: false }, userRolesEndpoints);
 *
 * A POST's JSON body names the endpoint; any other method is answered 405. The response is the same
 * envelope a Restlet returns, so a caller does not care which transport answered, except for an
 * endpoint that returns rawResponse(...): a Suitelet writes that as it is, headers and body or file.
 * The declaration names the script the controller is deployed as; the generator reads it from this
 * call. The options carry the authorize hook, run before every handler.
 */

export type SuiteletEntryPoint = (context: EntryPoints.Suitelet.onRequestContext) => void;

function writeEnvelope(context: EntryPoints.Suitelet.onRequestContext, envelope: ApiEnvelope<unknown>): void {
    context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
    context.response.write({ output: JSON.stringify(envelope) });
}

export function defineSuitelet(script: ScriptDeclaration, endpoints: Endpoints, options: ControllerOptions = {}): SuiteletEntryPoint {
    return (context) => {
        const method = context.request.method.toUpperCase();
        if (method !== 'POST') {
            writeEnvelope(context, { status: 405, error: `${script.name} answers POST, not ${method}.`, data: null });
            return;
        }
        const outcome = invokeEndpoint(script.name, endpoints, context.request.body, { ...options, allowRawResponse: true });
        if (outcome.raw) writeRawResponse(context.response, outcome.raw);
        else writeEnvelope(context, outcome.envelope);
    };
}
