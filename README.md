# @amerilux/netsuite-api

The API layer for a NetSuite single-page app. The app's server side is SuiteScript; its browser side is a bundle served by a Suitelet. This package holds what sits between them, so a project writes controllers and services and nothing else:

- **`@amerilux/netsuite-api/server`**: declare a controller's endpoints and the script that serves them, expose them as a Restlet or a Suitelet, reject a call with an `ApiError`, call another Suitelet controller from server code, keep the record a Map/Reduce job's runs live in, and find a File Cabinet file by name.
- **`@amerilux/netsuite-api/client`**: a typed browser client per controller, built from the endpoint types.
- **`@amerilux/netsuite-api/testing`**: stubs for the `N/*` modules and the vitest wiring that routes imports to them.
- **`netsuite-api generate`**: reads the controllers and the jobs and writes the client's whole view of the backend, one module each and an index re-exporting them, plus the server-side map of scripts and the run record. The client never imports from the server tree.
- **`@amerilux/netsuite-api`** (the root): the wire itself. The envelope, the endpoint types, `ScriptDeclaration`, `ScriptRef`, `JobRef`, `JobRun`.

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

Every call is a POST whose JSON body carries the request plus an `endpoint` property naming the endpoint. The handler answers with data, or throws an `ApiError` for a status the caller should see, with a `details` object the caller can act on (a per-field validation map, the offending id) that travels in the envelope; anything else is a 500 whose cause is logged and never sent. A Suitelet controller is the same file with `defineSuitelet` and `onRequest` instead, and `browser: false` in the declaration when only server code calls it.

The declaration is the controller's own statement of the script it is deployed as. It creates nothing: the controller builds, tests and bundles before any script record exists. The ids are how a client reaches the controller once it is deployed, so set them to whatever the record and deployment are called in NetSuite and in the SDF object; the generator wires every client to them.

The generator reads the file as source, so a few things are rules rather than conventions. Each of them is an error with a message when broken:

- Handlers are written inline with their parameter and return types annotated. A reference to a service function carries no types the generator can read.
- Every type in the file is a wire shape and is exported.
- A type is imported only from the inlined files (by default the generated entity types and the services: what a service returns is the domain type a wire shape is built from), the carried modules (the package's server entry, for `RawResponse`) or another controller. A service's function is never referenced by the handler in place of an annotation.
- The script declaration is an object literal with literal ids, its `name` is the file name without `Controller`, and the entry point export and the `@NScriptType` header agree with the define function.
- Script ids are unique across controllers, and no wire shape is named `Endpoints`. A shape's name carries no controller prefix: each controller's generated module is its own namespace.

## What the generator writes

`netsuite-api generate`, run from the project root, writes four kinds of file:

**`client/src/api/<name>.gen.ts`**, one module per controller: the entity types it names (copied in, with whatever they refer to, so the module stands on its own), its wire shapes, its endpoint type and, for a browser-facing controller, a client built from the declared script:

```ts
// client/src/api/customer.gen.ts
import { createApiClient } from '@amerilux/netsuite-api/client';

// Types from api/src/types/models.gen.ts, copied so this module stands on its own.

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

A type imported from a service is copied the same way, with the entity types it is built on following it in from the models file. A type imported from another controller becomes an import of that controller's module. A type built on something no inlined file declares (`CustomerCreate`, `CustomerPatch`: the repository package's input types; a type a service imports from a package) is an error, because the client could not carry it; write the wire shape out in the controller instead. So is a type reached through a renamed import (`import type { Employee as EmployeeRecord }`) in a service: import it under its own name. A generated module no controller owns any more is deleted on the next run.

JSON carries no dates. A `Date` in a response shape (an entity's `tranDate`) arrives in the browser as an ISO 8601 string, so the generated module writes `string` wherever the shape says `Date`; the page formats it. A `Date` in a request shape is an error, because the handler would receive a string where its annotation promises a Date: take a string and parse it in the handler.

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
  "jobs": "api/src/jobs",
  "outDir": "client/src/api",
  "scriptsOutFile": "api/src/scripts.gen.ts",
  "clientModule": "@amerilux/netsuite-api/client",
  "wireModule": "@amerilux/netsuite-api",
  "typeImports": { "@amerilux/netsuite-api/server": "@amerilux/netsuite-api/client" },
  "inlineTypes": {
    "../types/models.gen": "api/src/types/models.gen.ts",
    "../services/*": "api/src/services/*.ts",
    "../../types/models.gen": "api/src/types/models.gen.ts",
    "../../services/*": "api/src/services/*.ts"
  }
}
```

Paths are relative to the config file. `outDir` holds the controller and job modules and their indexes, and nothing else. A project with jobs adds a `jobRuns` block naming the run record it deployed; see **Jobs**. `inlineTypes` maps a specifier as written in a controller to the file whose type declarations are copied into the module of every controller importing from it; a key with one `*` stands for a file name and the `*` in its file takes that name, so `../services/*` covers every service. Only the type declarations of a file are read, so a service's functions are skipped; a type in one inlined file that refers to a type imported from another (a service's summary type built on an entity type) brings that type along, the import resolved through the same map as written from the same folder depth. The `../../` entries are the same two files named from one folder deeper, because a job is a folder and its stage files sit inside it. `typeImports` maps a specifier to the one the client resolves, for a type that stays an import (the package's server entry maps to its client entry so `RawResponse` carries over). A type imported from any other module is an error.

## The client at runtime

Calls go to NetSuite's own Restlet and Suitelet paths on the current origin, riding the session. A development server that proxies to a sandbox sets its own paths once at startup:

```ts
import { configureApiClient } from '@amerilux/netsuite-api/client';

if (import.meta.env.DEV) configureApiClient({ basePaths: { restlet: '/api/restlet', suitelet: '/api/suitelet' } });
```

A failed call rejects with an `ApiClientError` carrying the envelope's status, message and `details` (whatever the handler gave its `ApiError`, for a form to show per field); a call that got no answer at all carries `NO_RESPONSE_STATUS` (0). Before it rejects, the failure goes to the handler `configureApiClient` was given, with the script, the endpoint and the request, so the app reports every failure in one place and a hook carries no error handling of its own:

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

## Jobs

A job is an ordinary Map/Reduce script: its stages are NetSuite's own entry points, written the way any SuiteScript developer writes them. What this package adds is the run, because a Map/Reduce answers nothing and cannot be waited on: every run is a row in a record of the application's own, and that row is what server code and the browser talk about. Three calls are what it costs a job — the run is opened in `getInputData`, found again by a stage that records something against it, and closed in `summarize`.

A job is a folder. The file NetSuite loads carries the header and says which stages there are, so what a job is reads at a glance and a developer opens map.ts to see what the map stage does:

```ts
// api/src/jobs/closeStaleOrders/closeStaleOrders.ts
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

/** Closes the sales orders nobody has touched for long enough. */
export { getInputData } from './getInputData';
export { map } from './map';
export { summarize } from './summarize';
```

The script's ids are not here: they are written by hand in `netsuite.ts`, beside the job's SDF object, with everything else this application does not own, and the stages pass the job to the run store themselves.

```ts
// netsuite.ts
export const jobs = {
    closeStaleOrders: {
        name: 'closeStaleOrders',
        scriptId: 'customscript_app_close_stale_mr',
        deployments: ['customdeploy_app_close_stale_mr', 'customdeploy_app_close_stale_mr_2'],
        runParameter: 'custscript_app_close_stale_run',
    },
} as const;
```

Each stage is a file named after the stage NetSuite calls, holding the work and the shapes on its own boundary. `getInputData` opens the run, which answers what it was started with:

```ts
// api/src/jobs/closeStaleOrders/getInputData.ts
import type { EntryPoints } from 'N/types';
import { jobs } from '../../../../netsuite';
import { openJobRun } from '../../repositories/jobRunRepository';
import { listStaleOrders, type StaleOrder } from '../../services/staleOrderService';

/** What a run of this job is asked to do. */
export interface CloseStaleRequest {
    olderThanDays: number;
}

export function getInputData(_context: EntryPoints.MapReduce.getInputDataContext): StaleOrder[] {
    const input = openJobRun<CloseStaleRequest>(jobs.closeStaleOrders);
    return listStaleOrders(input.olderThanDays);
}
```

`map` and `reduce` are NetSuite's, unchanged: the value arrives as JSON and is written on as JSON. `summarize` builds the result and closes the run with it, which is what a page polling the run is waiting for:

```ts
// api/src/jobs/closeStaleOrders/summarize.ts
export function summarize(context: EntryPoints.MapReduce.summarizeContext): void {
    const closed: number[] = [];
    context.output.iterator().each((_key, value) => {
        closed.push(JSON.parse(value) as number);
        return true;
    });
    closeJobRun<CloseStaleResult>(jobs.closeStaleOrders, context, { closed: closed.length });
}
```

The two calls are the run's contract, and the generator reads it there: the type `openJobRun` is given is what a run is started with, and the type `closeJobRun` is given is what a finished run leaves behind. It copies the shapes the result names into the browser's module, whether the stage file declares them or takes them from a service, and a stage file may name a shape another file of the folder declares — the value a map stage writes is declared in map.ts and named again in summarize.ts. Only the result has to be a shape the client can carry, because it is the only one a browser is handed; the items a run is planned into stay on the server and may be built on whatever the server has.

Everything NetSuite collected is written onto the run by `closeJobRun`, so a map key that failed is on the run as well as in the execution log, and a run whose input stage failed is `failed`. Plenty of jobs leave nothing behind, because the records they write are the point: such a job closes its run with `closeJobRun<null>(job, context, null)`, and a page watches `status`, the progress fields and `errors` instead of a result. A stage that needs the run it belongs to — to stamp a record with it — asks for it with `readJobRunId(job)`.

A job whose runs are scheduled rather than started from a page has no run id to be passed, so `openJobRun` opens one for it; that is all the difference a schedule makes.

Reading a run asks the task about progress as well. `stagePercentComplete` is `getPercentageCompleted()`, which NetSuite documents as the percentage complete of the **stage being processed**, so it counts to 100 once per stage; `itemsProcessed` and `itemsTotal` come from that stage's `getTotal*Count()` and `getPending*Count()` pair and only go up. The record keeps the percent (100 once a run ends) but never the counts, so the counts are null for a run that has ended or whose task id NetSuite has purged — by then the run has the result, which the record did keep.

The store belongs in a repository, because it writes a record and submits a task: it starts runs, reads them, and is where the three calls a stage makes come from. Keep it job-agnostic — whatever decides a run should start passes the job and the input — and put that decision in the job's own folder (`start.ts`), so everything about a job is one place and a controller reaches for it by name.

```ts
// api/src/repositories/jobRunRepository.ts
import { createJobRunStore } from '@amerilux/netsuite-api/server';
import type { JobRef, JobRun } from '@amerilux/netsuite-api/server';
import type { EntryPoints } from 'N/types';
import { jobRuns } from '../scripts.gen';

const jobRunStore = createJobRunStore(jobRuns);

export const startJobRun = (job: JobRef, input: unknown): string => jobRunStore.start(job, input);
export const findJobRun = (runId: string): JobRun | null => jobRunStore.read(runId);

// What a stage calls: open the run in getInputData, close it in summarize, and ask for it in between.
export const openJobRun = <TInput>(job: JobRef): TInput => jobRunStore.openRun<TInput>(job);
export const readJobRunId = (job: JobRef): string => jobRunStore.currentRunId(job);
export const closeJobRun = <TResult>(job: JobRef, context: EntryPoints.MapReduce.summarizeContext, result: TResult): void => jobRunStore.closeRun(job, context, result);

// api/src/jobs/closeStaleOrders/start.ts
export const startClosingStaleOrders = (olderThanDays: number) => startJobRun(jobs.closeStaleOrders, { olderThanDays } satisfies CloseStaleRequest);
```

`start` writes the run, then submits the task to the first deployment that takes it; NetSuite runs one instance of a deployment at a time, so the list in netsuite.ts is how many runs can overlap. When they are all running it throws `ApiError.conflict` (409) and removes the run it had written, because nothing started. A controller endpoint hands the run id to the browser, which polls another endpoint for `read`.

`read` is the reason a dead run does not look like a working one: it takes status, stage and progress from `N/task.checkStatus` as well as the record, so a task NetSuite gave up on is `failed`, and a task that finished without writing a result is `failed` too. `findExpired(days)` and `remove` are what a cleanup job runs on a schedule; run records are not meant to be permanent.

`findRuns({ job, startedBy, unfinishedOnly, limit })` answers the matching runs newest first, in one query and without loading a record: it is how a page finds the run it lost track of, because the run knows who started it even after a browser has forgotten. Its rows carry what the record says, not what the task says, so read a run by id before believing one is still working — and they carry no progress at all, because only the task has any.

### The run record

The shape is this package's and the ids are the application's, because the record carries the application's prefix. `netsuite-api.config.json` names them and the generator writes them into the scripts map as `jobRuns`:

```json
"jobRuns": {
  "recordType": "customrecord_app_job_run",
  "fieldPrefix": "custrecord_app_jr",
  "extraFields": { "customerId": { "id": "custrecord_app_jr_customer", "type": "integer" } }
}
```

Each field's id is the prefix plus a short suffix (`_job`, `_status`, `_stage`, `_percent`, `_input`, `_result`, `_errors`, `_task`, `_deploy`, `_by`, `_start`, `_end`); `fields` overrides any one of them for a record whose field is named differently. `extraFields` are the fields the application added: `start` sets them (`{ extra: { customerId } }`) and a run reports them back under `extra`, typed.

## Tests

`N/*` modules exist only inside NetSuite. The `testing` entry ships a stub per module, each export a `vi.fn()`, the Map/Reduce contexts a job's stages are called with (`mapContextFor`, `reduceContextFor`, `summarizeContextFor`, each capturing what the stage wrote), and the vitest wiring:

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
