import { describe, expect, it } from 'vitest';
import { readAppDeclarations } from '../../tooling/appReader.js';
import { appSource } from './fixtures.js';

describe('readAppDeclarations', () => {
    it('reads every exported constant and type with its JSDoc, in order', () => {
        const source = `${appSource}
/** A list value no model owns. */
export type Priority = 'high' | 'low';

export const priorities = { high: 1, low: 2 } as const;
`;
        const { declarations, problems } = readAppDeclarations('netsuite.ts', source);
        expect(problems).toEqual([]);
        expect(declarations).toHaveLength(3);
        expect(declarations[0].startsWith('/** The application\'s names. */\nexport const app = {')).toBe(true);
        expect(declarations[1]).toBe("/** A list value no model owns. */\nexport type Priority = 'high' | 'low';");
        expect(declarations[2]).toBe('export const priorities = { high: 1, low: 2 } as const;');
    });

    it('rejects imports, non-exported statements and anything that runs', () => {
        const source = `import type { ScriptRef } from '@amerilux/netsuite-api';
const hidden = 1;
export let mutable = 2;
export function compute(): number { return 3; }
export const app = { name: 'X' } as const;
`;
        const { declarations, problems } = readAppDeclarations('netsuite.ts', source);
        expect(declarations).toEqual(["export const app = { name: 'X' } as const;"]);
        expect(problems.map((problem) => problem.message)).toEqual([
            "imports nothing: it is copied into the client module verbatim (found import type { ScriptRef } from '@amerilux/netsuite-api';).",
            'holds exported constants and types only, because the client module carries it verbatim (found const hidden = 1;).',
            'exports constants only (found export let mutable = 2;).',
            'holds exported constants and types only, because the client module carries it verbatim (found export function compute(): number { return 3; }).',
        ]);
    });
});
