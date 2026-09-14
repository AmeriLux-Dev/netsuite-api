import { describe, expect, it } from 'vitest';
import { isControllerFileName, readControllerContract, toPascalCase } from '../../tooling/controllerReader.js';
import { userControllerSource, userRolesControllerSource } from './fixtures.js';

const options = { carriedTypeImports: ['common/'] };

function messages(source: string, filePath = 'api/src/controllers/thingController.ts'): string[] {
    return readControllerContract(filePath, source, options).problems.map((problem) => problem.message);
}

describe('isControllerFileName and toPascalCase', () => {
    it('accepts <camelName>Controller.ts only', () => {
        expect(isControllerFileName('userController.ts')).toBe(true);
        expect(isControllerFileName('userRolesController.ts')).toBe(true);
        expect(isControllerFileName('UserController.ts')).toBe(false);
        expect(isControllerFileName('userService.ts')).toBe(false);
        expect(toPascalCase('userRoles')).toBe('UserRoles');
    });
});

describe('readControllerContract', () => {
    it('reads the exported types, the endpoint signatures and the carried type imports', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userRolesController.ts', userRolesControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract).toMatchObject({
            name: 'userRoles',
            endpointsTypeName: 'UserRolesEndpoints',
            clientName: 'userRolesApi',
            typeImports: [{ moduleSpecifier: 'common/types/models.gen', names: ['EmployeeRole'] }],
        });
        expect(contract?.typeDeclarations.map((declaration) => declaration.name)).toEqual(['RoleSummary', 'UserRolesByEmployeeRequest', 'UserRolesByEmployeeResponse']);
        expect(contract?.typeDeclarations[0].text).toBe(
            "/** A role as the wire carries it: picked from the generated entity type so it follows the model. */\nexport type RoleSummary = Pick<EmployeeRole, 'roleId' | 'roleName'>;",
        );
        expect(contract?.endpoints).toEqual([
            {
                name: 'byEmployee',
                requestType: 'UserRolesByEmployeeRequest',
                requestOptional: false,
                responseType: 'UserRolesByEmployeeResponse',
                jsDoc: '/**\n     * Every role assigned to the employee; the service answers 400 for a bad id.\n     */',
            },
        ]);
    });

    it('drops a type import from a sibling controller and skips the typeof alias of the endpoints', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userController.ts', userControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract?.typeImports).toEqual([]);
        expect(contract?.typeDeclarations.map((declaration) => declaration.name)).toEqual(['ActiveUserSummary', 'UserRolesResponse']);
        expect(contract?.endpoints).toEqual([
            { name: 'roles', requestType: undefined, requestOptional: false, responseType: 'UserRolesResponse', jsDoc: '/** The caller and every role assigned to them. Takes no request; the session says who is calling. */' },
        ]);
    });

    it('does not mistake a file comment for the JSDoc of the first type', () => {
        const { contract } = readControllerContract('api/src/controllers/userController.ts', userControllerSource, options);
        expect(contract?.typeDeclarations[0].text.startsWith('/** The caller as the session knows them. */')).toBe(true);
    });

    it('reads an optional request parameter and a method-style handler', () => {
        const source = `
import { defineEndpoints } from '@amerilux/netsuite-api/server';
export interface Filter { search?: string }
export const thingEndpoints = defineEndpoints({
    list: (request?: Filter): string[] => [],
    count(request: Filter): number { return 0; },
});
`;
        const { contract, problems } = readControllerContract('api/src/controllers/thingController.ts', source, options);
        expect(problems).toEqual([]);
        expect(contract?.endpoints).toEqual([
            { name: 'list', requestType: 'Filter', requestOptional: true, responseType: 'string[]', jsDoc: undefined },
            { name: 'count', requestType: 'Filter', requestOptional: false, responseType: 'number', jsDoc: undefined },
        ]);
    });

    it('rejects a file that is not named <name>Controller.ts', () => {
        expect(messages('', 'api/src/controllers/UserController.ts')).toEqual(['a controller file is named <name>Controller.ts, with <name> in camelCase.']);
    });

    it('requires the defineEndpoints declaration', () => {
        expect(messages('export interface A { a: 1 }')).toEqual(["must declare 'export const thingEndpoints = defineEndpoints({ ... })'."]);
    });

    it('requires handlers to be inline and annotated', () => {
        const source = `
import { defineEndpoints } from '@amerilux/netsuite-api/server';
import { doIt } from '../services/thingService';
export const thingEndpoints = defineEndpoints({
    byReference: doIt,
    noReturnType: (request: { id: number }) => ({ id: request.id }),
    noParameterType: (request): number => 1,
    tooMany: (a: number, b: number): number => a + b,
});
`;
        expect(messages(source)).toEqual([
            "endpoint 'byReference' must be an inline function with its parameter and return type annotated; a reference to a function elsewhere carries no types the generator can read.",
            "endpoint 'noReturnType' has no return type annotation; the response shape is read from it.",
            "endpoint 'noParameterType' has no parameter type annotation; the request shape is read from it.",
            "endpoint 'tooMany' takes 2 parameters; an endpoint takes one request or none.",
        ]);
    });

    it('requires every type to be exported and written out', () => {
        const source = `
import { defineEndpoints } from '@amerilux/netsuite-api/server';
interface Hidden { a: 1 }
export type Copied = typeof something;
export const thingEndpoints = defineEndpoints({ list: (): Hidden[] => [] });
`;
        expect(messages(source)).toEqual([
            "'Hidden' is not exported; every type in a controller is a wire shape, so export it (or move it below the controller).",
            "type 'Copied' is a typeof; a wire shape is written out as an interface or a type alias.",
        ]);
    });

    it('rejects a type imported from anywhere but the carried modules or a sibling controller', () => {
        const source = `
import { defineEndpoints } from '@amerilux/netsuite-api/server';
import type { Thing } from '../services/thingService';
import { type Other, doIt } from '../repositories/thingRepository';
import type * as Models from 'common/types/models.gen';
export const thingEndpoints = defineEndpoints({ list: (): Thing[] => doIt() });
`;
        expect(messages(source)).toEqual([
            "type Thing is imported from '../services/thingService'; a controller's wire shapes may only take types from 'common/' or from another controller.",
            "type Other is imported from '../repositories/thingRepository'; a controller's wire shapes may only take types from 'common/' or from another controller.",
            "'import type * as Models' from 'common/types/models.gen' cannot be carried to the client; import the types by name.",
        ]);
    });

    it('carries a renamed type import as written', () => {
        const source = `
import { defineEndpoints } from '@amerilux/netsuite-api/server';
import type { Employee as EmployeeRecord } from 'common/types/models.gen';
export const thingEndpoints = defineEndpoints({ me: (): EmployeeRecord => ({} as EmployeeRecord) });
`;
        expect(readControllerContract('api/src/controllers/thingController.ts', source, options).contract?.typeImports).toEqual([
            { moduleSpecifier: 'common/types/models.gen', names: ['Employee as EmployeeRecord'] },
        ]);
    });
});
