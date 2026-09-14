# @amerilux/netsuite-api

The API layer for a NetSuite single-page app. The app's server side is SuiteScript; its browser side is a bundle served by a Suitelet. This package holds what sits between them, so a project writes controllers and services and nothing else:

- **`@amerilux/netsuite-api/server`**: declare a controller's endpoints and the script that serves them, expose them as a Restlet or a Suitelet, reject a call with an `ApiError`, call another Suitelet controller from server code, and find a File Cabinet file by name.
- **`@amerilux/netsuite-api/client`**: a typed browser client per controller, built from the endpoint types.
- **`@amerilux/netsuite-api/testing`**: stubs for the `N/*` modules and the vitest wiring that routes imports to them.
- **`netsuite-api generate`**: reads the controllers and writes the client's whole view of the backend, one client module and one copy of the entity types, plus the server-side map of scripts. The client never imports from the server tree.
- **`@amerilux/netsuite-api`** (the root): the wire itself. The envelope, the endpoint types, `ScriptDeclaration`, `ScriptRef`.

The layout it assumes is the one `create-netsuite-project` scaffolds: `api/` (SuiteScript) and `client/` (React) as workspaces, and `netsuite.ts` at the root holding the application's names.

## A controller

One file per script under `api/src/controllers/`, named `<name>Controller.ts`. The file declares the wire shapes, the endpoints, and the script that serves them:

```ts
/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
import { defineEndpoints, defineRestlet } from '@amerilux/netsuite-api/server';
import type { Customer } from '../types/models.gen';
import { findCustomer, searchCustomers } from '../services/customerService';

export interface CustomerSearchRequest {
    search: string;
}

export type CustomerSummary = Pick<Customer, 'id' | 'companyName'>;

export const customerEndpoints = defineEndpoints({
    /** Customers whose name contains the search text. */
    search: (request: CustomerSearchRequest): CustomerSummary[] => searchCustomers(request.search),
    byId: (request: { id: number }): Customer => findCustomer(request.id),
});

export type CustomerEndpoints = typeof customerEndpoints;

export const post = defineRestlet({
    name: 'customer',
    scriptId: 'customscript_app_customer',
    deployId: 'customdeploy_app_customer',
}, customerEndpoints);
```

Every call is a POST whose JSON body carries the request plus an `endpoint` property naming the endpoint. The handler answers with data, or throws an `ApiError` for a status the caller should see; anything else is a 500 with the details logged. A Suitelet controller is the same file with `defineSuitelet` and `onRequest` instead, and `browser: false` in the declaration when only server code calls it.

The declaration is the controller's own statement of the script it is deployed as. It creates nothing: the controller builds, tests and bundles before any script record exists. The ids are how a client reaches the controller once it is deployed, so set them to whatever the record and deployment are called in NetSuite and in the SDF object; the generator wires every client to them.

The generator reads the file as source, so a few things are rules rather than conventions. Each of them is an error with a message when broken:

- Handlers are written inline with their parameter and return types annotated. A reference to a service function carries no types the generator can read.
- Every type in the file is a wire shape and is exported.
- A type is imported only from the carried modules (the generated entity types, by default) or from another controller. A service's return type is never used as a DTO by reference.
- The script declaration is an object literal with literal ids, its `name` is the file name without `Controller`, and the entry point export and the `@NScriptType` header agree with the define function.
- Type names and script ids are unique across controllers.

## What the generator writes

`netsuite-api generate`, run from the project root, writes four things:

**`client/src/api/index.gen.ts`**, the client's view of the backend. For every controller its wire shapes and endpoint type, and for every browser-facing controller a client built from the declared script:

```ts
import { createApiClient } from '@amerilux/netsuite-api/client';
import type { Customer } from './models.gen';

// customer (api/src/controllers/customerController.ts)

export interface CustomerSearchRequest {
    search: string;
}

export type CustomerSummary = Pick<Customer, 'id' | 'companyName'>;

export type CustomerEndpoints = {
    /** Customers whose name contains the search text. */
    search: (request: CustomerSearchRequest) => CustomerSummary[];
    byId: (request: { id: number }) => Customer;
};

export const customerApi = createApiClient<CustomerEndpoints>({ kind: 'restlet', scriptId: 'customscript_app_customer', deployId: 'customdeploy_app_customer' });
```

A hook calls `customerApi.search({ search: 'acme' })` and gets a `Promise<CustomerSummary[]>`. The second argument carries an `AbortSignal`.

**`client/src/api/models.gen.ts`**, a copy of the api's generated entity types, so the carried imports resolve.

**`client/src/app.gen.ts`**, a verbatim copy of the app file, outside the api folder so a page or a component may import `app` without touching a client.

**`api/src/scripts.gen.ts`**, the server-side map of every declared script by controller name. A repository passes an entry to `createSuiteletClient`; nothing else needs it.

`netsuite-api check` exits non-zero when any generated file is missing or out of date, for CI. `netsuite-api generate --dry-run` prints the client module instead of writing anything.

### The app file

`netsuite.ts` at the project root holds the application's names and any id no controller or model owns. Both sides use it, so the client gets a verbatim copy: the file is exported constants and types only, with no imports and nothing that runs.

### Configuration

`netsuite-api.config.json` at the project root, every setting optional. The defaults:

```json
{
  "controllers": "api/src/controllers",
  "appFile": "netsuite.ts",
  "outFile": "client/src/api/index.gen.ts",
  "appOutFile": "client/src/app.gen.ts",
  "scriptsOutFile": "api/src/scripts.gen.ts",
  "clientModule": "@amerilux/netsuite-api/client",
  "wireModule": "@amerilux/netsuite-api",
  "typeImports": { "../types/models.gen": "./models.gen" },
  "copyFiles": { "api/src/types/models.gen.ts": "client/src/api/models.gen.ts" }
}
```

Paths are relative to the config file. `typeImports` maps a specifier as written in a controller to the specifier the client resolves; only listed specifiers may be imported for types. `copyFiles` copies the files those specifiers point at.

## The client at runtime

Calls go to NetSuite's own Restlet and Suitelet paths on the current origin, riding the session. A development server that proxies to a sandbox sets its own paths once at startup:

```ts
import { configureApiClient } from '@amerilux/netsuite-api/client';

if (import.meta.env.DEV) configureApiClient({ basePaths: { restlet: '/api/restlet', suitelet: '/api/suitelet' } });
```

A failed call rejects with an `ApiClientError` carrying the envelope's status and message.

## Calling a Suitelet from server code

A Restlet runs as the caller's role. When a lookup needs a role the caller lacks, put it behind a Suitelet deployed to run as that role, declare it `browser: false`, and call it from a repository through the generated scripts map:

```ts
import { createSuiteletClient } from '@amerilux/netsuite-api/server';
import type { UserRolesEndpoints } from '../controllers/userRolesController';
import { scripts } from '../scripts.gen';

const userRolesApi = createSuiteletClient<UserRolesEndpoints>(scripts.userRoles);
export const listRolesForEmployee = (employeeId: number) => userRolesApi.byEmployee({ employeeId }).roles;
```

## Tests

`N/*` modules exist only inside NetSuite. The `testing` entry ships a stub per module, each export a `vi.fn()`, and the vitest wiring:

```ts
import { inlinedPackagesForNetsuiteStubs, netsuiteModuleStubAliases } from '@amerilux/netsuite-api/testing';

export default defineConfig({
    resolve: { alias: [...netsuiteModuleStubAliases()] },
    test: { server: { deps: { inline: [...inlinedPackagesForNetsuiteStubs] } } },
});
```

Inlining matters: vitest leaves node_modules to Node's resolver by default, and Node knows no `N/log`. With the package inlined, its own `N/*` imports go through the alias too.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

Tag `v<version>` matching `package.json` to publish.

## License

MIT
