import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRef } from '../../src/index.js';
import { ApiClientError, NO_RESPONSE_STATUS, buildApiUrl, callEndpoint, callRawEndpoint, configureApiClient } from '../../src/client/index.js';
import type { ApiErrorHandler } from '../../src/client/index.js';

const userScript: ScriptRef = { kind: 'restlet', scriptId: 'customscript_test_user', deployId: 'customdeploy_test_user' };

function mockFetchResponse(status: number, body: unknown, contentType = 'application/json') {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const fetchMock = vi.fn(async () => new Response(text, { status, headers: { 'Content-Type': contentType } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function lastRequest(fetchMock: ReturnType<typeof mockFetchResponse>) {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init };
}

afterEach(() => {
    vi.unstubAllGlobals();
    configureApiClient({});
});

describe('buildApiUrl', () => {
    it('carries the script and deploy ids', () => {
        const url = buildApiUrl(userScript);
        expect(url).toContain(`script=${userScript.scriptId}`);
        expect(url).toContain(`deploy=${userScript.deployId}`);
    });

    it("routes by the script kind to NetSuite's own paths by default", () => {
        const asSuitelet: ScriptRef = { ...userScript, kind: 'suitelet' };
        expect(buildApiUrl(userScript)).toMatch(/^\/app\/site\/hosting\/restlet\.nl\?/);
        expect(buildApiUrl(asSuitelet)).toMatch(/^\/app\/site\/hosting\/scriptlet\.nl\?/);
    });

    it('uses the configured base paths, keeping the default for a kind left out', () => {
        configureApiClient({ basePaths: { restlet: '/api/restlet' } });
        expect(buildApiUrl(userScript)).toMatch(/^\/api\/restlet\?/);
        expect(buildApiUrl({ ...userScript, kind: 'suitelet' })).toMatch(/^\/app\/site\/hosting\/scriptlet\.nl\?/);
    });
});

describe('callEndpoint', () => {
    it('posts a JSON body carrying the request and the endpoint name, and unwraps the envelope data', async () => {
        const fetchMock = mockFetchResponse(200, { status: 200, error: null, data: { roles: [] } });
        await expect(callEndpoint(userScript, 'list', { search: 'acme' })).resolves.toEqual({ roles: [] });
        const { url, init } = lastRequest(fetchMock);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ search: 'acme', endpoint: 'list' });
        expect(url).not.toContain('endpoint=');
    });

    it('sends only the endpoint name for an endpoint that takes no request, as the generated client calls it', async () => {
        const fetchMock = mockFetchResponse(200, { status: 200, error: null, data: { up: true } });
        await expect(callEndpoint(userScript, 'status', {})).resolves.toEqual({ up: true });
        expect(JSON.parse(lastRequest(fetchMock).init.body as string)).toEqual({ endpoint: 'status' });
    });

    it('forwards the abort signal', async () => {
        const fetchMock = mockFetchResponse(200, { status: 200, error: null, data: null });
        const signal = new AbortController().signal;
        await callEndpoint(userScript, 'create', { name: 'x' }, { signal });
        expect(lastRequest(fetchMock).init.signal).toBe(signal);
    });

    it('throws ApiClientError with the envelope status when the envelope carries an error', async () => {
        mockFetchResponse(200, { status: 404, error: 'Customer not found', data: null });
        await expect(callEndpoint(userScript, 'byId', { id: 9 })).rejects.toMatchObject({ name: 'ApiClientError', status: 404, message: 'Customer not found' });
    });

    it('carries the envelope details on the error, for the caller to act on', async () => {
        mockFetchResponse(200, { status: 400, error: 'Check the form.', data: null, details: { email: 'not an address' } });
        await expect(callEndpoint(userScript, 'create', { email: 'x' })).rejects.toMatchObject({ status: 400, details: { email: 'not an address' } });
    });

    it('throws ApiClientError when the response is not an envelope', async () => {
        mockFetchResponse(500, '<html>login</html>');
        const failure = await callEndpoint(userScript, 'list').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiClientError);
        expect((failure as ApiClientError).status).toBe(500);
    });
});

describe('callRawEndpoint', () => {
    it('resolves the document to a Blob, posting the request and the endpoint name like any other call', async () => {
        const fetchMock = mockFetchResponse(200, 'month,2026-09', 'text/csv');
        const blob: Blob = await callRawEndpoint({ ...userScript, kind: 'suitelet' }, 'csv', { month: '2026-09' });
        expect(await blob.text()).toBe('month,2026-09');
        expect(JSON.parse(lastRequest(fetchMock).init.body as string)).toEqual({ month: '2026-09', endpoint: 'csv' });
    });

    it('throws the envelope error when the raw endpoint rejects the call', async () => {
        mockFetchResponse(200, { status: 403, error: 'Not permitted', data: null });
        await expect(callRawEndpoint(userScript, 'csv')).rejects.toMatchObject({ name: 'ApiClientError', status: 403, message: 'Not permitted' });
    });

    it('throws when the answer is JSON where a document was expected, or a failed status without an envelope', async () => {
        mockFetchResponse(200, { status: 200, error: null, data: { rows: [] } });
        await expect(callRawEndpoint(userScript, 'csv')).rejects.toMatchObject({ status: 200, message: expect.stringContaining('answered JSON') });
        mockFetchResponse(502, '<html>gateway</html>', 'text/html');
        await expect(callRawEndpoint(userScript, 'csv')).rejects.toMatchObject({ status: 502 });
    });
});

describe('the configured error handler', () => {
    function handler() {
        const onError = vi.fn<ApiErrorHandler>();
        configureApiClient({ onError });
        return onError;
    }

    it('is told about a failed call, with the call\'s context, before the call rejects', async () => {
        const onError = handler();
        mockFetchResponse(200, { status: 404, error: 'Customer not found', data: null });
        await expect(callEndpoint(userScript, 'byId', { id: 9 })).rejects.toMatchObject({ status: 404 });
        expect(onError).toHaveBeenCalledTimes(1);
        const [error, context] = onError.mock.calls[0];
        expect(error).toBeInstanceOf(ApiClientError);
        expect(error.message).toBe('Customer not found');
        expect(context).toEqual({ scriptRef: userScript, endpoint: 'byId', request: { id: 9 } });
    });

    it('is told about a raw endpoint that fails', async () => {
        const onError = handler();
        mockFetchResponse(200, { status: 403, error: 'Not permitted', data: null });
        await expect(callRawEndpoint(userScript, 'csv', { month: '2026-09' })).rejects.toMatchObject({ status: 403 });
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }), { scriptRef: userScript, endpoint: 'csv', request: { month: '2026-09' } });
    });

    it('is left out when the call passes handleError: false, which still rejects', async () => {
        const onError = handler();
        mockFetchResponse(200, { status: 400, error: 'employeeId must be a positive whole number.', data: null });
        await expect(callEndpoint(userScript, 'byEmployee', { employeeId: 0 }, { handleError: false })).rejects.toMatchObject({ status: 400 });
        expect(onError).not.toHaveBeenCalled();
    });

    it('never hears about an aborted call, which rejects with the abort itself', async () => {
        const onError = handler();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }));
        await expect(callEndpoint(userScript, 'list')).rejects.toMatchObject({ name: 'AbortError' });
        expect(onError).not.toHaveBeenCalled();
    });

    it('sees a call that got no answer as an ApiClientError with the no-response status', async () => {
        const onError = handler();
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        const failure = await callEndpoint(userScript, 'list').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiClientError);
        expect(failure).toMatchObject({ status: NO_RESPONSE_STATUS, message: 'Could not reach customscript_test_user.list: Failed to fetch' });
        expect((failure as ApiClientError).details).toBeInstanceOf(TypeError);
        expect(onError).toHaveBeenCalledWith(failure, { scriptRef: userScript, endpoint: 'list', request: {} });
    });

    it('is forgotten by a configureApiClient call that leaves it out', async () => {
        const onError = handler();
        configureApiClient({ basePaths: { restlet: '/api/restlet' } });
        mockFetchResponse(200, { status: 404, error: 'gone', data: null });
        await expect(callEndpoint(userScript, 'byId', { id: 1 })).rejects.toMatchObject({ status: 404 });
        expect(onError).not.toHaveBeenCalled();
    });
});
