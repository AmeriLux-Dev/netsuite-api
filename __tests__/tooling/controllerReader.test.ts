import { describe, expect, it } from 'vitest';
import { isControllerFileName, readControllerContract } from '../../tooling/controllerReader.js';
import { userControllerSource, userRolesControllerSource } from './fixtures.js';

const options = {
    typeImports: { '@amerilux/netsuite-api/server': '@amerilux/netsuite-api/client' },
    inlineTypes: { '../types/models.gen': 'api/src/types/models.gen.ts', '../services/*': 'api/src/services/*.ts' },
};

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

describe('isControllerFileName', () => {
    it('accepts <camelName>Controller.ts only', () => {
        expect(isControllerFileName('userController.ts')).toBe(true);
        expect(isControllerFileName('userRolesController.ts')).toBe(true);
        expect(isControllerFileName('UserController.ts')).toBe(false);
        expect(isControllerFileName('userService.ts')).toBe(false);
    });
});

describe('readControllerContract', () => {
    it('reads the script declaration, the exported types, the endpoint signatures and the inlined type imports', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userRolesController.ts', userRolesControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract).toMatchObject({
            name: 'userRoles',
            script: { kind: 'suitelet', scriptId: 'customscript_demo_user_roles', deployId: 'customdeploy_demo_user_roles', browser: false },
            carriedTypeImports: [],
            inlinedTypeImports: [{ specifier: '../services/userRolesService', names: [{ name: 'RoleSummary' }] }],
            controllerTypeImports: [],
        });
        expect(contract?.typeDeclarations.map((declaration) => declaration.name)).toEqual(['ByEmployeeRequest', 'ByEmployeeResponse']);
        expect(contract?.typeDeclarations[1].text).toBe(
            'export interface ByEmployeeResponse {\n    employeeId: number;\n    /** Every role assigned to the employee, by name. */\n    roles: RoleSummary[];\n}',
        );
        expect(contract?.endpoints).toEqual([
            {
                name: 'byEmployee',
                requestType: 'ByEmployeeRequest',
                requestOptional: false,
                responseType: 'ByEmployeeResponse',
                raw: false,
                jsDoc: '/**\n     * Every role assigned to the employee; 400 for a bad id.\n     */',
            },
        ]);
    });

    it('reads a Restlet, resolves a type import from a service through the wildcard entry and skips the typeof alias of the endpoints', () => {
        const { contract, problems } = readControllerContract('api/src/controllers/userController.ts', userControllerSource, options);
        expect(problems).toEqual([]);
        expect(contract?.script).toEqual({ kind: 'restlet', scriptId: 'customscript_demo_user', deployId: 'customdeploy_demo_user', browser: true });
        expect(contract?.carriedTypeImports).toEqual([]);
        expect(contract?.inlinedTypeImports).toEqual([{ specifier: '../services/userRolesService', names: [{ name: 'RoleSummary' }] }]);
        expect(contract?.controllerTypeImports).toEqual([]);
        expect(contract?.typeDeclarations.map((declaration) => declaration.name)).toEqual(['ActiveUserSummary', 'RolesResponse']);
        expect(contract?.endpoints).toEqual([
            { name: 'roles', requestType: undefined, requestOptional: false, responseType: 'RolesResponse', raw: false, jsDoc: '/** The caller and every role assigned to them. Takes no request; the session says who is calling. */' },
        ]);
    });

    it('resolves a type import from a sibling controller to that controller', () => {
        const source = userControllerSource.replace("import type { RoleSummary } from '../services/userRolesService';", "import type { RoleSummary } from './userRolesController';");
        const { contract, problems } = readControllerContract('api/src/controllers/userController.ts', source, options);
        expect(problems).toEqual([]);
        expect(contract?.inlinedTypeImports).toEqual([]);
        expect(contract?.controllerTypeImports).toEqual([{ controllerName: 'userRoles', names: [{ name: 'RoleSummary' }] }]);
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
            { name: 'list', requestType: 'Filter', requestOptional: true, responseType: 'string[]', raw: false, jsDoc: undefined },
            { name: 'count', requestType: 'Filter', requestOptional: false, responseType: 'number', raw: false, jsDoc: undefined },
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

    it('requires every type to be exported, written out, and not named after the generated endpoint type', () => {
        const source = thingController(`
interface Hidden { a: 1 }
export type Copied = typeof something;
export interface Endpoints { a: 1 }
export const thingEndpoints = defineEndpoints({ list: (): Hidden[] => [] });`);
        expect(messages(source)).toEqual([
            "'Hidden' is not exported; every type in a controller is a wire shape, so export it (or move it below the controller).",
            "type 'Copied' is a typeof; a wire shape is written out as an interface or a type alias.",
            "type 'Endpoints' is the name the generated module gives the endpoint signatures; call the wire shape something else.",
        ]);
    });

    it('rejects a type imported from anywhere but the inlined files, the carried modules or a sibling controller', () => {
        const source = thingController(`
import type { Thing } from '../helpers/thing';
import { type Other, doIt } from '../repositories/thingRepository';
import type * as Models from '../types/models.gen';
export const thingEndpoints = defineEndpoints({ list: (): Thing[] => doIt() });`);
        expect(messages(source)).toEqual([
            "type Thing is imported from '../helpers/thing'; a controller's wire shapes may only take types from '../types/models.gen', '../services/*', '@amerilux/netsuite-api/server' or from another controller.",
            "type Other is imported from '../repositories/thingRepository'; a controller's wire shapes may only take types from '../types/models.gen', '../services/*', '@amerilux/netsuite-api/server' or from another controller.",
            "'import type * as Models' from '../types/models.gen' cannot be carried to the client; import the types by name.",
        ]);
    });

    it('marks an endpoint whose return type is written RawResponse, carrying the type from the package client entry', () => {
        const source = thingController(`
import type { RawResponse } from '@amerilux/netsuite-api/server';
export const thingEndpoints = defineEndpoints({
    csv: (request: { month: string }): RawResponse => rawResponse({ contentType: 'text/csv', body: '' }),
    rows: (): string[] => [],
});`);
        const { contract, problems } = readControllerContract('api/src/controllers/thingController.ts', source, options);
        expect(problems).toEqual([]);
        expect(contract?.carriedTypeImports).toEqual([{ moduleSpecifier: '@amerilux/netsuite-api/client', names: [{ name: 'RawResponse' }] }]);
        expect(contract?.endpoints.map((endpoint) => [endpoint.name, endpoint.raw])).toEqual([['csv', true], ['rows', false]]);
    });

    it('reads a renamed type import with its alias', () => {
        const source = thingController(`
import type { Employee as EmployeeRecord } from '../types/models.gen';
export const thingEndpoints = defineEndpoints({ me: (): EmployeeRecord => ({} as EmployeeRecord) });`);
        expect(readControllerContract('api/src/controllers/thingController.ts', source, options).contract?.inlinedTypeImports).toEqual([
            { specifier: '../types/models.gen', names: [{ name: 'Employee', alias: 'EmployeeRecord' }] },
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
