/// <reference types="node" />
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test support for a project's api workspace. N/* modules are only real inside NetSuite; the stubs
 * under ./N answer with vi.fn shells so a service or controller can run under vitest. A project's
 * vitest config aliases N/* to them and inlines this package so its own N/* imports go through the
 * alias too:
 *
 *     resolve: { alias: [...netsuiteModuleStubAliases()] },
 *     test: { server: { deps: { inline: [...inlinedPackagesForNetsuiteStubs] } } },
 *
 * This module runs in the vitest config, so it never imports vitest itself.
 */

/** Absolute directory of the stub modules, one file per N/* module (N/ui/serverWidget included). */
export const netsuiteModuleStubsDirectory = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'N');

export interface ModuleAlias {
    find: RegExp;
    replacement: string;
}

/**
 * The vitest alias that routes every N/* import to its stub. A wrapper package that re-exports the
 * modules under its own names passes patterns of its own; each must capture the module name
 * (`log`, `ui/serverWidget`) in its first group.
 */
export function netsuiteModuleStubAliases(additionalPatterns: RegExp[] = []): ModuleAlias[] {
    const posixDirectory = netsuiteModuleStubsDirectory.split(nodePath.sep).join('/');
    const extension = nodePath.extname(fileURLToPath(import.meta.url));
    const replacement = `${posixDirectory}/$1${extension}`;
    return [/^N\/(.*)$/, ...additionalPatterns].map((find) => ({ find, replacement }));
}

/**
 * Packages whose own N/* imports must go through the alias. Vitest externalizes node_modules by
 * default and Node's resolver knows no N/log; inlining routes the import through vite instead.
 */
export const inlinedPackagesForNetsuiteStubs = ['@amerilux/netsuite-api'] as const;
