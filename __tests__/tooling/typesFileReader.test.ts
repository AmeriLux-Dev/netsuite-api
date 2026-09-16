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
        expect(selected.sections.map((section) => section.filePath)).toEqual(['api/src/types/models.gen.ts']);
        expect(selected.sections[0].declarations.map((declaration) => declaration.name)).toEqual(['Department', 'Employee', 'EmployeeRole', 'EmployeeRecord']);
        expect(selected.sections[0].declarations[3].text).toBe('export type EmployeeRecord = Employee;');
    });

    it('skips a reference to a global and reports one to something no inlinable file declares', () => {
        const file = readInlinableTypesFile('types.ts', `
import type { EntityPatch } from '@amerilux/netsuite-repository';
export interface Customer { since: Date; tags: Record<string, string> }
export type CustomerPatch = EntityPatch<Customer>;
`);
        expect(selectInlinedTypes(file, [{ name: 'Customer' }], controllerPath)).toEqual({
            sections: [{ filePath: 'types.ts', declarations: [{ name: 'Customer', text: 'export interface Customer { since: Date; tags: Record<string, string> }' }] }],
            problems: [],
        });
        expect(selectInlinedTypes(file, [{ name: 'CustomerPatch' }], controllerPath).problems).toEqual([
            { filePath: controllerPath, message: "type 'CustomerPatch' (types.ts) is built on EntityPatch from '@amerilux/netsuite-repository', which the client cannot carry; write the wire shape out in the controller instead." },
        ]);
        expect(selectInlinedTypes(file, [{ name: 'EntityPatch' }, { name: 'Missing' }], controllerPath).problems).toEqual([
            { filePath: controllerPath, message: "type 'EntityPatch' is imported into types.ts from '@amerilux/netsuite-repository', not declared there; the client cannot carry it." },
            { filePath: controllerPath, message: "type 'Missing' is not declared in types.ts." },
        ]);
    });

    it('follows a reference into the inlinable file it is imported from, one section per file, and aliases a name reached that way', () => {
        const serviceFile = readInlinableTypesFile('api/src/services/employeeService.ts', `
import type { Employee, EmployeeRole } from '../types/models.gen';
import { listEmployees } from '../repositories/employeeRepository';

/** An employee as the service hands it up. */
export type EmployeeSummary = Pick<Employee, 'id' | 'name'> & { roles: RoleName[] };
export type RoleName = EmployeeRole['roleName'];

export function getEmployees(): EmployeeSummary[] { return listEmployees().map(() => ({} as EmployeeSummary)); }
`);
        const resolveImport = (specifier: string) => (specifier === '../types/models.gen' ? modelsFile : undefined);
        const selected = selectInlinedTypes(serviceFile, [{ name: 'EmployeeSummary' }, { name: 'Employee', alias: 'EmployeeRecord' }], controllerPath, resolveImport);
        expect(selected.problems).toEqual([]);
        expect(selected.sections.map((section) => [section.filePath, section.declarations.map((declaration) => declaration.name)])).toEqual([
            ['api/src/services/employeeService.ts', ['EmployeeSummary', 'RoleName', 'EmployeeRecord']],
            ['api/src/types/models.gen.ts', ['Department', 'Employee', 'EmployeeRole']],
        ]);
    });

    it('reports a renamed import between inlinable files, and says nothing more about a file the resolver reported missing', () => {
        const serviceFile = readInlinableTypesFile('api/src/services/employeeService.ts', `
import type { Employee as EmployeeRecord } from '../types/models.gen';
export type EmployeeSummary = Pick<EmployeeRecord, 'id'>;
`);
        expect(serviceFile.renamedImports.get('EmployeeRecord')).toBe('Employee');
        expect(selectInlinedTypes(serviceFile, [{ name: 'EmployeeSummary' }], controllerPath, () => modelsFile).problems).toEqual([
            {
                filePath: controllerPath,
                message: "type 'EmployeeSummary' (api/src/services/employeeService.ts) is built on EmployeeRecord, imported from '../types/models.gen' as a rename of Employee; import it under its own name so the client can carry it.",
            },
        ]);
        expect(selectInlinedTypes(serviceFile, [{ name: 'EmployeeRecord' }], controllerPath, () => modelsFile).problems).toEqual([
            { filePath: controllerPath, message: "type 'EmployeeRecord' is imported into api/src/services/employeeService.ts from '../types/models.gen' as a rename of Employee; import it under its own name so the client can carry it." },
        ]);
        expect(selectInlinedTypes(serviceFile, [{ name: 'EmployeeSummary' }], controllerPath, () => 'missing')).toEqual({
            sections: [{ filePath: 'api/src/services/employeeService.ts', declarations: [{ name: 'EmployeeSummary', text: "export type EmployeeSummary = Pick<EmployeeRecord, 'id'>;" }] }],
            problems: [],
        });
    });
});
