# @amerilux/netsuite-api

The API layer for a NetSuite single-page app. The app's server side is SuiteScript; its browser side is a bundle served by a Suitelet. This package holds what sits between them, so a project writes controllers and services and nothing else:

- **`@amerilux/netsuite-api/server`**: declare a controller's endpoints, expose them as a Restlet or a Suitelet, reject a call with an `ApiError`, call another Suitelet controller from server code, and find a File Cabinet file by name.
- **`@amerilux/netsuite-api/client`**: a typed browser client per controller, built from the endpoint types.
- **`@amerilux/netsuite-api/testing`**: stubs for the `N/*` modules and the vitest wiring that routes imports to them.
- **`netsuite-api generate`**: reads the controllers and writes one client module holding every wire shape, every endpoint interface, and a client for each controller the browser calls. The client never imports from the server tree.
- **`@amerilux/netsuite-api`** (the root): the wire itself. The envelope, the endpoint types, `ScriptRef`.

The layout it assumes is the one `create-netsuite-project` scaffolds: `api/` (SuiteScript), `client/` (React), and `common/` (shared by both, holding `netsuite.ts` with the `scripts` map).

## A controller

One file per script under `api/src/controllers/`, named `<name>Controller.ts` after its `scripts` entry. The file declares the wire shapes, the endpoints, and the entry point:

```ts
/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
import { defineEndpoints, defineRestlet } from '@amerilux/netsuite-api/server';
import type { Customer } from 'common/types/models.gen';
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

export const post = defineRestlet('customer', customerEndpoints);
```

Every call is a POST whose JSON body carries the request plus an `endpoint` property naming the endpoint. The handler answers with data, or throws an `ApiError` for a status the caller should see; anything else is a 500 with the details logged. A Suitelet controller is the same file with `defineSuitelet` and `onRequest` instead.

The generator reads this file as source, so a few things are rules rather than conventions. Each of them is an error with a message when broken:

- Handlers are written inline with their parameter and return types annotated. A reference to a service function carries no types the generator can read.
- Every type in the file is a wire shape and is exported.
- A type is imported only from the carried modules (`common/` by default) or from another controller. A service's return type is never used as a DTO by reference.
- Type names are unique across controllers. The generated module holds them all.

## The generated client module

`netsuite-api generate`, run from the client workspace, writes `src/api/index.gen.ts`:

```ts
import { createApiClient } from '@amerilux/netsuite-api/client';
import { scripts } from 'common/netsuite';
import type { Customer } from 'common/types/models.gen';

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

export const customerApi = createApiClient<CustomerEndpoints>(scripts.customer);
```

A hook calls `customerApi.search({ search: 'acme' })` and gets a `Promise<CustomerSummary[]>`. The second argument carries an `AbortSignal`. A `scripts` entry with `browser: false` (a Suitelet only server code calls) gets its types written but no client.

`netsuite-api check` exits non-zero when the module is missing or out of date, for CI. `netsuite-api generate --dry-run` prints the module instead of writing it.

### Configuration

`netsuite-api.config.json` in the client workspace, every setting optional:

```json
{
  "controllers": "../api/src/controllers",
  "scriptsFile": "../common/netsuite.ts",
  "scriptsModule": "common/netsuite",
  "outFile": "src/api/index.gen.ts",
  "clientModule": "@amerilux/netsuite-api/client",
  "carriedTypeImports": ["common/"]
}
```

Paths are relative to the config file. `carriedTypeImports` lists the module specifier prefixes a controller may import types from; those imports are carried into the generated module verbatim, so the client must resolve them the same way.

## The client at runtime

Calls go to NetSuite's own Restlet and Suitelet paths on the current origin, riding the session. A development server that proxies to a sandbox sets its own paths once at startup:

```ts
import { configureApiClient } from '@amerilux/netsuite-api/client';

if (import.meta.env.DEV) configureApiClient({ basePaths: { restlet: '/api/restlet', suitelet: '/api/suitelet' } });
```

A failed call rejects with an `ApiClientError` carrying the envelope's status and message.

## Calling a Suitelet from server code

A Restlet runs as the caller's role. When a lookup needs a role the caller lacks, put it behind a Suitelet deployed to run as that role, mark its `scripts` entry `browser: false`, and call it from a repository:

```ts
import { createSuiteletClient } from '@amerilux/netsuite-api/server';
import type { UserRolesEndpoints } from '../controllers/userRolesController';

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
