import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as https from 'N/https';
import type { ScriptRef } from '../../src/index.js';
import { ApiError, callSuiteletEndpoint, createSuiteletClient } from '../../src/server/index.js';

// N/https resolves to the stub the package ships; the client is tested on what it sends and how it reads the answer.
const requestSuitelet = vi.mocked(https.requestSuitelet);
const helper: ScriptRef = { kind: 'suitelet', scriptId: 'customscript_test_helper', deployId: 'customdeploy_test_helper' };

function answering(status: number, error: string | null, data: unknown, code = 200) {
    requestSuitelet.mockReturnValue({ code, body: JSON.stringify({ status, error, data }), headers: {} } as never);
}

beforeEach(() => {
    requestSuitelet.mockReset();
});

describe('callSuiteletEndpoint', () => {
    it('posts the request as a JSON body carrying the endpoint name and returns the envelope data', () => {
        answering(200, null, { roles: [] });
        const data = callSuiteletEndpoint(helper, 'byEmployee', { employeeId: 7 });
        expect(data).toEqual({ roles: [] });
        expect(requestSuitelet).toHaveBeenCalledWith(expect.objectContaining({
            scriptId: 'customscript_test_helper',
            deploymentId: 'customdeploy_test_helper',
            method: 'POST',
            body: JSON.stringify({ employeeId: 7, endpoint: 'byEmployee' }),
        }));
    });

    it('turns a transport failure or a non-envelope answer into a 502', () => {
        requestSuitelet.mockReturnValue({ code: 500, body: 'boom', headers: {} } as never);
        expect(() => callSuiteletEndpoint(helper, 'byEmployee')).toThrow(expect.objectContaining({ status: 502 }));
        requestSuitelet.mockReturnValue({ code: 200, body: '<html>login</html>', headers: {} } as never);
        expect(() => callSuiteletEndpoint(helper, 'byEmployee')).toThrow(expect.objectContaining({ status: 502 }));
    });

    it('keeps the status and message of an error envelope', () => {
        answering(400, 'employeeId must be a positive whole number.', null);
        let caught: unknown;
        try {
            callSuiteletEndpoint(helper, 'byEmployee', { employeeId: 'x' });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect(caught).toEqual(expect.objectContaining({ status: 400, message: 'employeeId must be a positive whole number.' }));
    });

    it('refuses a scripts entry that is not a Suitelet', () => {
        const restlet: ScriptRef = { kind: 'restlet', scriptId: 'customscript_test_api', deployId: 'customdeploy_test_api' };
        expect(() => callSuiteletEndpoint(restlet, 'list')).toThrow(/Suitelets only/);
        expect(requestSuitelet).not.toHaveBeenCalled();
    });
});

describe('createSuiteletClient', () => {
    // Stands in for `typeof helperEndpoints` of a controller: the handler signatures are the contract.
    type HelperEndpoints = {
        byEmployee: (request: { employeeId: number }) => { roles: string[] };
        reset: () => null;
    };

    it('exposes one function per endpoint, named by the property accessed', () => {
        const client = createSuiteletClient<HelperEndpoints>(helper);
        answering(200, null, { roles: ['Administrator'] });
        expect(client.byEmployee({ employeeId: 7 })).toEqual({ roles: ['Administrator'] });
        expect(requestSuitelet).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', body: JSON.stringify({ employeeId: 7, endpoint: 'byEmployee' }) }));
        answering(200, null, null);
        expect(client.reset()).toBeNull();
        expect(requestSuitelet).toHaveBeenLastCalledWith(expect.objectContaining({ body: JSON.stringify({ endpoint: 'reset' }) }));
    });
});
