import { describe, expect, it, vi } from 'vitest';
import type { EntryPoints } from 'N/types';
import { ApiError, defineEndpoints, defineSuitelet, rawResponse } from '../../src/server/index.js';
import type { RawResponse } from '../../src/server/index.js';

/** The parts of a Suitelet context the wrapper touches, with the response captured for assertions. */
function createSuiteletContext(method: string, body = '') {
    const write = vi.fn();
    const writeFile = vi.fn();
    const setHeader = vi.fn();
    const context = {
        request: { method, parameters: {}, body },
        response: { write, writeFile, setHeader },
    } as unknown as EntryPoints.Suitelet.onRequestContext;
    const written = () => JSON.parse((write.mock.calls[0] as [{ output: string }])[0].output) as unknown;
    const headers = () => Object.fromEntries((setHeader.mock.calls as [{ name: string; value: string }][]).map(([header]) => [header.name, header.value]));
    return { context, write, writeFile, setHeader, written, headers };
}

const script = { name: 'things', scriptId: 'customscript_test_things', deployId: 'customdeploy_test_things', browser: false };

const endpoints = defineEndpoints({
    byId: (request: { id: string }): { id: number } => ({ id: Number(request.id) }),
    create: (request: { name: string }): { created: string } => {
        if (!request.name) throw ApiError.badRequest('name is required');
        return { created: request.name };
    },
});

describe('defineSuitelet', () => {
    const suitelet = defineSuitelet(script, endpoints);

    it('serves a POST from the JSON body, endpoint name included, as a JSON envelope', () => {
        const { context, headers, written } = createSuiteletContext('POST', '{"endpoint":"byId","id":"7"}');
        suitelet(context);
        expect(headers()).toEqual({ 'Content-Type': 'application/json' });
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

    it('runs the authorize hook before the handler and answers what it throws', () => {
        const guarded = defineSuitelet(script, endpoints, {
            authorize: ({ endpoint }) => {
                if (endpoint === 'create') throw ApiError.forbidden();
            },
        });
        const forbidden = createSuiteletContext('POST', '{"endpoint":"create","name":"x"}');
        guarded(forbidden.context);
        expect(forbidden.written()).toEqual({ status: 403, error: 'Not permitted', data: null });
        const allowed = createSuiteletContext('POST', '{"endpoint":"byId","id":"7"}');
        guarded(allowed.context);
        expect(allowed.written()).toEqual({ status: 200, error: null, data: { id: 7 } });
    });

    describe('a raw response', () => {
        const file = { name: 'report.pdf' } as never;
        const documents = defineSuitelet(script, defineEndpoints({
            csv: (request: { month: string }): RawResponse => rawResponse({ contentType: 'text/csv', body: `month,${request.month}`, fileName: 'export.csv', headers: { 'Cache-Control': 'no-store' } }),
            page: (): RawResponse => rawResponse({ contentType: 'text/html', body: '<p>hi</p>' }),
            pdf: (): RawResponse => rawResponse({ file, inline: true }),
        }));

        it('writes a text body with its content type, headers and, when named, as an attachment', () => {
            const { context, write, headers } = createSuiteletContext('POST', '{"endpoint":"csv","month":"2026-09"}');
            documents(context);
            expect(headers()).toEqual({ 'Cache-Control': 'no-store', 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="export.csv"' });
            expect(write).toHaveBeenCalledWith({ output: 'month,2026-09' });
        });

        it('writes an unnamed body inline without a disposition', () => {
            const { context, write, headers } = createSuiteletContext('POST', '{"endpoint":"page"}');
            documents(context);
            expect(headers()).toEqual({ 'Content-Type': 'text/html' });
            expect(write).toHaveBeenCalledWith({ output: '<p>hi</p>' });
        });

        it('writes a file through writeFile', () => {
            const { context, write, writeFile } = createSuiteletContext('POST', '{"endpoint":"pdf"}');
            documents(context);
            expect(writeFile).toHaveBeenCalledWith({ file, isInline: true });
            expect(write).not.toHaveBeenCalled();
        });
    });
});
