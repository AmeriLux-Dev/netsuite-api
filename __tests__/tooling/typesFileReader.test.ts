import { describe, expect, it } from 'vitest';
import { readInlinableTypesFile, selectInlinedTypes } from '../../tooling/typesFileReader.js';
import { modelsSource } from './fixtures.js';

const modelsFile = readInlinableTypesFile('api/src/types/models.gen.ts', modelsSource);
const controllerPath = 'api/src/controllers/employeeController.ts';

describe('readInlinableTypesFile', () => {
    it('reads every declaration with what it refers to, and what the file imports', () => {
        expect(Array.from(modelsFile.declarations.keys())).toEqual(['Department', 'Employee', 'EmployeeCreate', 'EmployeeRole']);
        expect(modelsFile.declarations.get('Employee')?.references).toEqual(['Department']);
        expect(modelsFile.declarations.get('EmployeeCreate')?.references).toEqual(['EntityCreate', 'Employee']);
        expect(modelsFile.declarations.get('EmployeeCreate')?.text).toBe('/** What `create()` takes for an Employee. */\nexport type EmployeeCreate = EntityCreate<Employee>;');
        expect(Array.from(modelsFile.importedNames.entries())).toEqual([['EntityCreate', '@amerilux/netsuite-repository']]);
    });

    it('follows an extends clause, a qualified name and a typeof, and leaves out a declaration\'s own type parameters', () => {
        const file = readInlinableTypesFile('types.ts', `
import * as Shared from './shared';
export interface Base { id: number }
export interface Line<T> extends Base { item: T; owner: Shared.Owner; kind: typeof KINDS; when: Date }
export enum Status { Open, Closed }
`);
        expect(file.declarations.get('Line')?.references).toEqual(['Base', 'Shared', 'KINDS', 'Date']);
        expect(file.declarations.get('Status')?.references).toEqual([]);
        expect(file.importedNames.get('Shared')).toBe('./shared');
    });
});

describe('selectInlinedTypes', () => {
    it('selects the named types and what they refer to, in file order, then an alias per renamed import', () => {
        const selected = selectInlinedTypes(modelsFile, [{ name: 'EmployeeRole' }, { name: 'Employee', alias: 'EmployeeRecord' }], controllerPath);
        expect(selected.problems).toEqual([]);
        expect(selected.declarations.map((declaration) => declaration.name)).toEqual(['Department', 'Employee', 'EmployeeRole', 'EmployeeRecord']);
        expect(selected.declarations[3].text).toBe('export type EmployeeRecord = Employee;');
    });

    it('skips a reference to a global and reports one to something the file imports', () => {
        const file = readInlinableTypesFile('types.ts', `
import type { EntityPatch } from '@amerilux/netsuite-repository';
export interface Customer { since: Date; tags: Record<string, string> }
export type CustomerPatch = EntityPatch<Customer>;
`);
        expect(selectInlinedTypes(file, [{ name: 'Customer' }], controllerPath)).toEqual({ declarations: [{ name: 'Customer', text: 'export interface Customer { since: Date; tags: Record<string, string> }' }], problems: [] });
        expect(selectInlinedTypes(file, [{ name: 'CustomerPatch' }], controllerPath).problems).toEqual([
            { filePath: controllerPath, message: "type 'CustomerPatch' (types.ts) is built on EntityPatch from '@amerilux/netsuite-repository', which the client cannot carry; write the wire shape out in the controller instead." },
        ]);
        expect(selectInlinedTypes(file, [{ name: 'EntityPatch' }, { name: 'Missing' }], controllerPath).problems).toEqual([
            { filePath: controllerPath, message: "type 'EntityPatch' is imported into types.ts from '@amerilux/netsuite-repository', not declared there; the client cannot carry it." },
            { filePath: controllerPath, message: "type 'Missing' is not declared in types.ts." },
        ]);
    });
});
