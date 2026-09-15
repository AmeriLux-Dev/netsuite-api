# @amerilux/netsuite-api

The API layer for a NetSuite single-page app. The app's server side is SuiteScript; its browser side is a bundle served by a Suitelet. This package holds what sits between them, so a project writes controllers and services and nothing else:

- **`@amerilux/netsuite-api/server`**: declare a controller's endpoints and the script that serves them, expose them as a Restlet or a Suitelet, reject a call with an `ApiError`, call another Suitelet controller from server code, and find a File Cabinet file by name.
- **`@amerilux/netsuite-api/client`**: a typed browser client per controller, built from the endpoint types.
- **`@amerilux/netsuite-api/testing`**: stubs for the `N/*` modules and the vitest wiring that routes imports to them.
- **`netsuite-api generate`**: reads the controllers and writes the client's whole view of the backend, one module per controller and an index re-exporting them, plus the server-side map of scripts. The client never imports from the server tree.
- **`@amerilux/netsuite-api`** (the root): the wire itself. The envelope, the endpoint types, `ScriptDeclaration`, `ScriptRef`.

The layout it assumes is the one `create-netsuite-project` scaffolds: `api/` (SuiteScript) and `client/` (React) as workspaces.

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

export interface SearchRequest {
    search: string;
}

export type CustomerSummary = Pick<Customer, 'id' | 'companyName'>;

export const customerEndpoints = defineEndpoints({
    /** Customers whose name contains the search text. */
    search: (request: SearchRequest): CustomerSummary[] => searchCustomers(request.search),
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
- A type is imported only from the inlined files (the generated entity types, by default), the carried modules (the package's server entry, for `RawResponse`) or another controller. A service's return type is never used as a DTO by reference.
- The script declaration is an object literal with literal ids, its `name` is the file name without `Controller`, and the entry point export and the `@NScriptType` header agree with the define function.
- Script ids are unique across controllers, and no wire shape is named `Endpoints`. A shape's name carries no controller prefix: each controller's generated module is its own namespace.

## What the generator writes

`netsuite-api generate`, run from the project root, writes four kinds of file:

**`client/src/api/<name>.gen.ts`**, one module per controller: the entity types it names (copied in, with whatever they refer to, so the module stands on its own), its wire shapes, its endpoint type and, for a browser-facing controller, a client built from the declared script:

```ts
// client/src/api/customer.gen.ts
import { createApiClient } from '@amerilux/netsuite-api/client';

// Entity types from api/src/types/models.gen.ts, copied so this module stands on its own.

export interface Customer {
    id: number;
    companyName: string;
}

export interface SearchRequest {
    search: string;
}

export type CustomerSummary = Pick<Customer, 'id' | 'companyName'>;

/** The endpoint signatures of the customer controller, as its handlers declare them. */
export type Endpoints = {
    /** Customers whose name contains the search text. */
    search: (request: SearchRequest) => CustomerSummary[];
    byId: (request: { id: number }) => Customer;
};

/** One typed function per endpoint of the customer controller: \`customer.api.search(...)\`. */
export const api = createApiClient<Endpoints>({ kind: 'restlet', scriptId: 'customscript_app_customer', deployId: 'customdeploy_app_customer' });
```

A type imported from another controller becomes an import of that controller's module. A type built on something the entity file imports itself (`CustomerCreate`, `CustomerPatch`: the repository package's input types) is an error, because the client could not carry it; write the wire shape out in the controller instead. A generated module no controller owns any more is deleted on the next run.

**`client/src/api/index.gen.ts`**, the client's view of the backend: every controller's module re-exported under the controller's name.

```ts
export * as customer from './customer.gen';
export * as user from './user.gen';
```

A hook imports `{ customer }` from it, calls `customer.api.search({ search: 'acme' })` and gets a `Promise<customer.CustomerSummary[]>`. The second argument carries an `AbortSignal`.

**`api/src/scripts.gen.ts`**, the server-side map of every declared script by controller name. A repository passes an entry to `createSuiteletClient`; nothing else needs it.

`netsuite-api check` exits non-zero when any generated file is missing, out of date or left over, for CI. `netsuite-api generate --dry-run` prints every file instead of writing anything.

### Configuration

`netsuite-api.config.json` at the project root, every setting optional. The defaults:

```json
{
  "controllers": "api/src/controllers",
  "outDir": "client/src/api",
  "scriptsOutFile": "api/src/scripts.gen.ts",
  "clientModule": "@amerilux/netsuite-api/client",
  "wireModule": "@amerilux/netsuite-api",
  "typeImports": { "@amerilux/netsuite-api/server": "@amerilux/netsuite-api/client" },
  "inlineTypes": { "../types/models.gen": "api/src/types/models.gen.ts" }
}
```

Paths are relative to the config file. `outDir` holds the controller modules and the index, and nothing else. `inlineTypes` maps a specifier as written in a controller to the type-only file whose declarations are copied into the module of every controller importing from it. `typeImports` maps a specifier to the one the client resolves, for a type that stays an import (the package's server entry maps to its client entry so `RawResponse` carries over). A type imported from any other module is an error.

## The client at runtime

Calls go to NetSuite's own Restlet and Suitelet paths on the current origin, riding the session. A development server that proxies to a sandbox sets its own paths once at startup:

```ts
import { configureApiClient } from '@amerilux/netsuite-api/client';

if (import.meta.env.DEV) configureApiClient({ basePaths: { restlet: '/api/restlet', suitelet: '/api/suitelet' } });
```

A failed call rejects with an `ApiClientError` carrying the envelope's status and message; a call that got no answer at all carries `NO_RESPONSE_STATUS` (0). Before it rejects, the failure goes to the handler `configureApiClient` was given, with the script, the endpoint and the request, so the app reports every failure in one place and a hook carries no error handling of its own:

```ts
configureApiClient({ onError: (error, { endpoint }) => showBanner(`${endpoint}: ${error.message}`) });
```

The rejection still reaches the caller, so a query sees its error state. A call that reports the failure itself passes `{ handleError: false }` as its second argument; an aborted call is not a failure and never reaches the handler.

## Authorizing calls

A Restlet runs as the caller's role, and NetSuite's own permissions apply to every record the handler touches. When a controller needs a rule of its own, such as an endpoint only some roles may call, the define call takes an `authorize` hook, run before every handler once the endpoint is known to exist:

```ts
import * as runtime from 'N/runtime';
import { ApiError, defineEndpoints, defineRestlet } from '@amerilux/netsuite-api/server';

const ADMINISTRATOR = 3;

export const post = defineRestlet({ name: 'orders', scriptId: '...', deployId: '...' }, ordersEndpoints, {
    authorize: ({ endpoint }) => {
        if (endpoint === 'remove' && Number(runtime.getCurrentUser().role) !== ADMINISTRATOR) throw ApiError.forbidden('Only an administrator removes orders.');
    },
});
```

The hook sees the controller, the endpoint name and the request. Throwing an `ApiError` answers with its status and message; returning lets the call through. Reading the session belongs in a repository function in a project that keeps to its layers, so a real hook calls one.

## Answering with a document

Every endpoint answers with the JSON envelope, except a Suitelet endpoint that returns `rawResponse(...)`: a CSV export, a rendered PDF, a File Cabinet file. The handler writes `RawResponse` as its return type, exactly, and the generator lists the endpoint on the client, which resolves it to a `Blob`:

```ts
import type { RawResponse } from '@amerilux/netsuite-api/server';
import { defineEndpoints, defineSuitelet, rawResponse } from '@amerilux/netsuite-api/server';

export const documentsEndpoints = defineEndpoints({
    csv: (request: { month: string }): RawResponse => rawResponse({ contentType: 'text/csv', body: buildCsv(request.month), fileName: `orders-${request.month}.csv` }),
    invoicePdf: (request: { id: number }): RawResponse => rawResponse({ file: renderInvoice(request.id), inline: true }),
});
```

In the browser, `documents.api.csv({ month })` resolves to a `Blob`; hand it to `URL.createObjectURL` for a download link. A text answer takes a content type, a body, optional headers and, for a download, a file name; a file answer takes an `N/file` object and whether to show it inline. A failure still arrives as the envelope and is thrown as an `ApiClientError`. A Restlet cannot write a raw answer: a handler returning one there is a 500.

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
