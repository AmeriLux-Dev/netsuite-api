import { describe, expect, it } from 'vitest';
import { readScriptRegistry } from '../../tooling/scriptsReader.js';
import { scriptsSource } from './fixtures.js';

describe('readScriptRegistry', () => {
    it('reads every entry with its kind and whether the browser calls it', () => {
        const { entries, problems } = readScriptRegistry('common/netsuite.ts', scriptsSource);
        expect(problems).toEqual([]);
        expect(Array.from(entries.values())).toEqual([
            { name: 'home', kind: 'suitelet', browser: true },
            { name: 'user', kind: 'restlet', browser: true },
            { name: 'userRoles', kind: 'suitelet', browser: false },
        ]);
    });

    it('reads the map without the as const and satisfies wrappers too', () => {
        const { entries } = readScriptRegistry('x.ts', "export const scripts = { a: { kind: 'restlet', scriptId: 'customscript_test_a', deployId: 'customdeploy_test_a', browser: true } };");
        expect(entries.get('a')).toEqual({ name: 'a', kind: 'restlet', browser: true });
    });

    it('reports a missing scripts export and an entry that is not an object', () => {
        expect(readScriptRegistry('x.ts', 'export const other = {};').problems).toEqual([{ filePath: 'x.ts', message: "declares no 'export const scripts = { ... }'." }]);
        const { entries, problems } = readScriptRegistry('x.ts', "export const scripts = { a: 'customscript_test_a', ...spread } as const;");
        expect(entries.size).toBe(0);
        expect(problems.map((problem) => problem.message)).toEqual([
            "scripts has an entry that is not 'name: { kind, scriptId, deployId }' (a: 'customscript_test_a').",
            "scripts has an entry that is not 'name: { kind, scriptId, deployId }' (...spread).",
        ]);
    });
});
