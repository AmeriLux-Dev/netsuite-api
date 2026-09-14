import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as log from 'N/log';
import { ApiError, defineEndpoints, defineRestlet, parseEndpointRequest, rawResponse, readEndpointCall } from '../../src/server/index.js';
import type { RawResponse } from '../../src/server/index.js';

const thingsEndpoints = defineEndpoints({
    byId: (request: { id: string }): { id: number } => ({ id: Number(request.id) }),
    create: (request: { name: string }): { created: string } => {
        if (!request.name) throw ApiError.notFound('No such thing');
        return { created: request.name };
    },
    explode: (): never => {
        throw new Error('boom');
    },
});

describe('parseEndpointRequest', () => {
    it('passes objects through and treats an empty body as an empty object', () => {
        expect(parseEndpointRequest({ a: 1 })).toEqual({ a: 1 });
        expect(parseEndpointRequest(undefined)).toEqual({});
        expect(parseEndpointRequest('')).toEqual({});
    });

    it('parses a JSON string body', () => {
        expect(parseEndpointRequest('{"search":"acme"}')).toEqual({ search: 'acme' });
    });

    it('rejects a body that is not JSON as a 400', () => {
        expect(() => parseEndpointRequest('not json')).toThrow(ApiError);
    });
});

describe('readEndpointCall', () => {
    it('splits the endpoint name off the rest of the request', () => {
        expect(readEndpointCall({ endpoint: 'byId', id: '7', script: 'x' })).toEqual({ name: 'byId', request: { id: '7', script: 'x' } });
    });

    it('reports a missing or blank name as undefined and rejects non-objects', () => {
        expect(readEndpointCall({ id: '7' }).name).toBeUndefined();
        expect(readEndpointCall({ endpoint: '' }).name).toBeUndefined();
        expect(() => readEndpointCall([1])).toThrow(ApiError);
    });
});

describe('defineRestlet', () => {
    const post = defineRestlet({ name: 'things', scriptId: 'customscript_test_things', deployId: 'customdeploy_test_things' }, thingsEndpoints);

    beforeEach(() => {
        vi.mocked(log.audit).mockClear();
        vi.mocked(log.error).mockClear();
    });

    it('routes a JSON body to the named endpoint, wraps its result in the envelope and audits the call', () => {
        expect(post('{"endpoint":"byId","id":"7"}')).toEqual({ status: 200, error: null, data: { id: 7 } });
        expect(log.audit).toHaveBeenCalledWith('endpoint completed', expect.objectContaining({ controller: 'things', endpoint: 'byId', status: 200 }));
    });

    it('accepts a body NetSuite already parsed into an object', () => {
        expect(post({ endpoint: 'create', name: 'widget' })).toEqual({ status: 200, error: null, data: { created: 'widget' } });
    });

    it('maps ApiError to its status and message', () => {
        expect(post({ endpoint: 'create', name: '' })).toEqual({ status: 404, error: 'No such thing', data: null });
        expect(log.error).not.toHaveBeenCalled();
    });

    it('hides unexpected errors behind a 500 and logs them', () => {
        expect(post({ endpoint: 'explode' })).toEqual({ status: 500, error: 'Internal Server Error', data: null });
        expect(log.error).toHaveBeenCalledWith('endpoint failed', expect.objectContaining({ controller: 'things', endpoint: 'explode', message: 'boom' }));
    });

    it('answers 400 without an endpoint name and 404 for an unknown one, inherited names included', () => {
        expect(post({ id: '7' })).toMatchObject({ status: 400, data: null });
        expect(post({ endpoint: 'nope' })).toMatchObject({ status: 404, data: null });
        expect(post({ endpoint: 'constructor' })).toMatchObject({ status: 404, data: null });
    });

    it('runs the authorize hook before the handler, with the endpoint and the request, and answers what it throws', () => {
        const authorize = vi.fn(({ endpoint, request }: { endpoint: string; request: Record<string, unknown> }) => {
            if (endpoint === 'create' && request.name === 'secret') throw ApiError.forbidden('Not for you');
        });
        const guarded = defineRestlet({ name: 'things', scriptId: 'customscript_test_things', deployId: 'customdeploy_test_things' }, thingsEndpoints, { authorize });
        expect(guarded({ endpoint: 'create', name: 'secret' })).toEqual({ status: 403, error: 'Not for you', data: null });
        expect(guarded({ endpoint: 'create', name: 'widget' })).toEqual({ status: 200, error: null, data: { created: 'widget' } });
        expect(authorize).toHaveBeenCalledWith({ controller: 'things', endpoint: 'create', request: { name: 'secret' } });
        // An unknown endpoint is a 404 before the hook sees it.
        authorize.mockClear();
        expect(guarded({ endpoint: 'nope' })).toMatchObject({ status: 404 });
        expect(authorize).not.toHaveBeenCalled();
    });

    it('answers 500 and logs when a handler returns a raw response, which only a Suitelet can write', () => {
        const documents = defineEndpoints({ csv: (): RawResponse => rawResponse({ contentType: 'text/csv', body: 'a,b' }) });
        const restlet = defineRestlet({ name: 'documents', scriptId: 'customscript_test_documents', deployId: 'customdeploy_test_documents' }, documents);
        expect(restlet({ endpoint: 'csv' })).toEqual({ status: 500, error: 'Internal Server Error', data: null });
        expect(log.error).toHaveBeenCalledWith('endpoint failed', expect.objectContaining({ controller: 'documents', endpoint: 'csv', message: expect.stringContaining('only a Suitelet') }));
    });
});
