import { describe, expect, it } from 'vitest';
import { isControllerFileName, readControllerContract, toPascalCase } from '../../tooling/controllerReader.js';
import { userControllerSource, userRolesControllerSource } from './fixtures.js';

const options = { typeImports: { '../types/models.gen': './models.gen' } };

const restletHeader = `/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
`;

/** A minimal, valid thing controller around the given body, so a test can break one thing at a time. */
function thingController(body: string, entryPoint = "export const post = defineRestlet({ name: 'thing', scriptId: 'customscript_test_thing', deployId: 'customdeploy_test_thing' }, thingEndpoints);"): string {
    return `${restletHeader}import { defineEndpoints, defineRestlet } from '@amerilux/netsuite-api/server';\n${body}\n${entryPoint}\n`;
}

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
    it('reads the script declaration, the exported types, the endpoint signatures and the carried type imports', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userRolesController.ts', userRolesControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract).toMatchObject({
            name: 'userRoles',
            endpointsTypeName: 'UserRolesEndpoints',
            clientName: 'userRolesApi',
            script: { kind: 'suitelet', scriptId: 'customscript_demo_user_roles', deployId: 'customdeploy_demo_user_roles', browser: false },
            typeImports: [{ moduleSpecifier: './models.gen', names: ['EmployeeRole'] }],
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

    it('reads a Restlet, drops a type import from a sibling controller and skips the typeof alias of the endpoints', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userController.ts', userControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract?.script).toEqual({ kind: 'restlet', scriptId: 'customscript_demo_user', deployId: 'customdeploy_demo_user', browser: true });
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
        const source = thingController(`
export interface Filter { search?: string }
export const thingEndpoints = defineEndpoints({
    list: (request?: Filter): string[] => [],
    count(request: Filter): number { return 0; },
});`);
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

    it('requires the defineEndpoints declaration and the entry point', () => {
        expect(messages(`${restletHeader}export interface A { a: 1 }`)).toEqual([
            "must declare 'export const thingEndpoints = defineEndpoints({ ... })'.",
            "must end with 'export const post = defineRestlet({ name, scriptId, deployId }, thingEndpoints)' or 'export const onRequest = defineSuitelet(...)'.",
        ]);
    });

    it('requires handlers to be inline and annotated', () => {
        const source = thingController(`
import { doIt } from '../services/thingService';
export const thingEndpoints = defineEndpoints({
    byReference: doIt,
    noReturnType: (request: { id: number }) => ({ id: request.id }),
    noParameterType: (request): number => 1,
    tooMany: (a: number, b: number): number => a + b,
});`);
        expect(messages(source)).toEqual([
            "endpoint 'byReference' must be an inline function with its parameter and return type annotated; a reference to a function elsewhere carries no types the generator can read.",
            "endpoint 'noReturnType' has no return type annotation; the response shape is read from it.",
            "endpoint 'noParameterType' has no parameter type annotation; the request shape is read from it.",
            "endpoint 'tooMany' takes 2 parameters; an endpoint takes one request or none.",
        ]);
    });

    it('requires every type to be exported and written out', () => {
        const source = thingController(`
interface Hidden { a: 1 }
export type Copied = typeof something;
export const thingEndpoints = defineEndpoints({ list: (): Hidden[] => [] });`);
        expect(messages(source)).toEqual([
            "'Hidden' is not exported; every type in a controller is a wire shape, so export it (or move it below the controller).",
            "type 'Copied' is a typeof; a wire shape is written out as an interface or a type alias.",
        ]);
    });

    it('rejects a type imported from anywhere but the carried modules or a sibling controller', () => {
        const source = thingController(`
import type { Thing } from '../services/thingService';
import { type Other, doIt } from '../repositories/thingRepository';
import type * as Models from '../types/models.gen';
export const thingEndpoints = defineEndpoints({ list: (): Thing[] => doIt() });`);
        expect(messages(source)).toEqual([
            "type Thing is imported from '../services/thingService'; a controller's wire shapes may only take types from '../types/models.gen' or from another controller.",
            "type Other is imported from '../repositories/thingRepository'; a controller's wire shapes may only take types from '../types/models.gen' or from another controller.",
            "'import type * as Models' from '../types/models.gen' cannot be carried to the client; import the types by name.",
        ]);
    });

    it('carries a renamed type import under the client specifier', () => {
        const source = thingController(`
import type { Employee as EmployeeRecord } from '../types/models.gen';
export const thingEndpoints = defineEndpoints({ me: (): EmployeeRecord => ({} as EmployeeRecord) });`);
        expect(readControllerContract('api/src/controllers/thingController.ts', source, options).contract?.typeImports).toEqual([
            { moduleSpecifier: './models.gen', names: ['Employee as EmployeeRecord'] },
        ]);
    });

    describe('the script declaration', () => {
        const endpoints = 'export const thingEndpoints = defineEndpoints({ list: (): string[] => [] });';

        it('requires the entry point export NetSuite looks for, matching the header', () => {
            expect(messages(thingController(endpoints, "const post = defineRestlet({ name: 'thing', scriptId: 'customscript_test_thing', deployId: 'customdeploy_test_thing' }, thingEndpoints);"))).toEqual([
                "the entry point must be 'export const post = defineRestlet({ name, scriptId, deployId }, thingEndpoints)'; NetSuite looks for that export on a Restlet.",
            ]);
            expect(messages(thingController(endpoints, "export const onRequest = defineSuitelet({ name: 'thing', scriptId: 'customscript_test_thing', deployId: 'customdeploy_test_thing' }, thingEndpoints);"))).toEqual([
                "the leading JSDoc says '@NScriptType Restlet' but the entry point is defineSuitelet; both must say Suitelet.",
            ]);
        });

        it('requires the declaration inline with literal ids and the controller name', () => {
            expect(messages(thingController(endpoints, 'export const post = defineRestlet(script, thingEndpoints);'))).toEqual([
                'defineRestlet takes the script declaration as an object literal written inline: defineRestlet({ name, scriptId, deployId }, thingEndpoints).',
            ]);
            expect(messages(thingController(endpoints, "export const post = defineRestlet({ name: 'other', scriptId: `customscript_${prefix}_thing`, browser: flag }, otherEndpoints);"))).toEqual([
                'defineRestlet must be passed thingEndpoints: defineRestlet({ name, scriptId, deployId }, thingEndpoints).',
                "the script declaration needs 'scriptId' as a string literal; the generator reads it from the source.",
                "the script declaration needs 'deployId' as a string literal; the generator reads it from the source.",
                "the script declaration says name: 'other' but the file is thingController.ts; the name is the file name without Controller.",
                "'browser' must be the literal true or false.",
            ]);
        });

        it('allows one entry point only', () => {
            const twice = thingController(
                endpoints,
                "export const post = defineRestlet({ name: 'thing', scriptId: 'customscript_test_thing', deployId: 'customdeploy_test_thing' }, thingEndpoints);\nexport const post2 = defineRestlet({ name: 'thing', scriptId: 'customscript_test_thing2', deployId: 'customdeploy_test_thing2' }, thingEndpoints);",
            );
            expect(messages(twice)).toEqual(['a controller has one entry point; a second defineRestlet or defineSuitelet call is a second script.']);
        });
    });
});
