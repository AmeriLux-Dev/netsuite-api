import { describe, expect, it, vi } from 'vitest';
import type { EntryPoints } from 'N/types';
import { ApiError, defineEndpoints, defineSuitelet } from '../../src/server/index.js';

/** The parts of a Suitelet context the wrapper touches, with the response captured for assertions. */
function createSuiteletContext(method: string, body = '') {
    const write = vi.fn();
    const setHeader = vi.fn();
    const context = {
        request: { method, parameters: {}, body },
        response: { write, setHeader },
    } as unknown as EntryPoints.Suitelet.onRequestContext;
    const written = () => JSON.parse((write.mock.calls[0] as [{ output: string }])[0].output) as unknown;
    return { context, write, setHeader, written };
}

const endpoints = defineEndpoints({
    byId: (request: { id: string }): { id: number } => ({ id: Number(request.id) }),
    create: (request: { name: string }): { created: string } => {
        if (!request.name) throw ApiError.badRequest('name is required');
        return { created: request.name };
    },
});

describe('defineSuitelet', () => {
    const suitelet = defineSuitelet('things', endpoints);

    it('serves a POST from the JSON body, endpoint name included, as a JSON envelope', () => {
        const { context, setHeader, written } = createSuiteletContext('POST', '{"endpoint":"byId","id":"7"}');
        suitelet(context);
        expect(setHeader).toHaveBeenCalledWith({ name: 'Content-Type', value: 'application/json' });
        expect(written()).toEqual({ status: 200, error: null, data: { id: 7 } });
    });

    it('returns the same error envelope a Restlet would', () => {
        const { context, written } = createSuiteletContext('POST', '{"endpoint":"create"}');
        suitelet(context);
        expect(written()).toEqual({ status: 400, error: 'name is required', data: null });
    });

    it('answers 400 without an endpoint name and 405 for any method but POST', () => {
        const missing = createSuiteletContext('POST', '{"id":"7"}');
        suitelet(missing.context);
        expect(missing.written()).toMatchObject({ status: 400, data: null });

        const wrongMethod = createSuiteletContext('GET');
        suitelet(wrongMethod.context);
        expect(wrongMethod.written()).toMatchObject({ status: 405, data: null });
    });
});
