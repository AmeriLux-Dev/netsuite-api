import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptRef } from '../../src/index.js';
import { ApiClientError, buildApiUrl, callEndpoint, callRawEndpoint, configureApiClient, createApiClient } from '../../src/client/index.js';
import type { RawResponse } from '../../src/client/index.js';

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

    it('throws ApiClientError when the response is not an envelope', async () => {
        mockFetchResponse(500, '<html>login</html>');
        const failure = await callEndpoint(userScript, 'list').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiClientError);
        expect((failure as ApiClientError).status).toBe(500);
    });
});

describe('createApiClient', () => {
    // Stands in for the endpoint interface the generator writes for a controller: the handler signatures are the contract.
    type PingEndpoints = {
        ping: (request: { value: number }) => { echoed: number };
        status: () => { up: boolean };
    };

    it('exposes one function per endpoint, named by the property accessed', async () => {
        const fetchMock = mockFetchResponse(200, { status: 200, error: null, data: { echoed: 1 } });
        const pingApi = createApiClient<PingEndpoints>(userScript);
        await expect(pingApi.ping({ value: 1 })).resolves.toEqual({ echoed: 1 });
        expect(JSON.parse(lastRequest(fetchMock).init.body as string)).toEqual({ value: 1, endpoint: 'ping' });
    });

    it('sends only the endpoint name for an endpoint that takes no request', async () => {
        const fetchMock = mockFetchResponse(200, { status: 200, error: null, data: { up: true } });
        const pingApi = createApiClient<PingEndpoints>(userScript);
        await expect(pingApi.status()).resolves.toEqual({ up: true });
        expect(JSON.parse(lastRequest(fetchMock).init.body as string)).toEqual({ endpoint: 'status' });
    });

    it('resolves a raw endpoint to a Blob, the way the generator wires it', async () => {
        type DocumentsEndpoints = { csv: (request: { month: string }) => RawResponse };
        const fetchMock = mockFetchResponse(200, 'month,2026-09', 'text/csv');
        const documentsApi = createApiClient<DocumentsEndpoints>({ ...userScript, kind: 'suitelet' }, { rawEndpoints: ['csv'] });
        const blob: Blob = await documentsApi.csv({ month: '2026-09' });
        expect(await blob.text()).toBe('month,2026-09');
        expect(JSON.parse(lastRequest(fetchMock).init.body as string)).toEqual({ month: '2026-09', endpoint: 'csv' });
    });
});

describe('callRawEndpoint', () => {
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
