import type { File as NetSuiteFile } from 'N/file';
import type { EntryPoints } from 'N/types';
import type { RawResponse } from '../index.js';

/**
 * The escape hatch from the JSON envelope, for a Suitelet endpoint that answers with a document: a
 * CSV export, a rendered PDF, a File Cabinet file. The handler returns rawResponse(...) and declares
 * `RawResponse` as its return type; defineSuitelet writes the answer as it is, and the generated
 * client resolves the call to a Blob. A Restlet cannot write one: its handler returning a raw response
 * is a 500.
 */

/** Text (or a string body of any kind) with its content type; `fileName` makes it a download. */
export interface RawTextResponse {
    contentType: string;
    body: string;
    /** Set to answer as an attachment named this way. */
    fileName?: string;
    headers?: Record<string, string>;
}

/** A File Cabinet file or an N/file object built in memory (a rendered PDF, say). */
export interface RawFileResponse {
    file: NetSuiteFile;
    /** True to display in the browser where it can; false (the default) to download. */
    inline?: boolean;
    headers?: Record<string, string>;
}

export type RawResponseOptions = RawTextResponse | RawFileResponse;

class SuiteletRawResponse implements RawResponse {
    readonly isRawResponse = true as const;

    constructor(readonly options: RawResponseOptions) {}
}

/** Builds the answer a Suitelet endpoint returns instead of data. */
export function rawResponse(options: RawResponseOptions): RawResponse {
    return new SuiteletRawResponse(options);
}

/** True for a value built by rawResponse(); narrows to its options. */
export function isRawResponse(value: unknown): value is SuiteletRawResponse {
    return value instanceof SuiteletRawResponse;
}

export type SuiteletResponse = EntryPoints.Suitelet.onRequestContext['response'];

/** Writes a raw answer to the Suitelet response: headers, then the file or the body. */
export function writeRawResponse(response: SuiteletResponse, options: RawResponseOptions): void {
    for (const [name, value] of Object.entries(options.headers ?? {})) response.setHeader({ name, value });
    if ('file' in options) {
        response.writeFile({ file: options.file, isInline: options.inline ?? false });
        return;
    }
    response.setHeader({ name: 'Content-Type', value: options.contentType });
    if (options.fileName !== undefined) response.setHeader({ name: 'Content-Disposition', value: `attachment; filename="${options.fileName}"` });
    response.write({ output: options.body });
}
