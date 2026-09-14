import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const stubsDirectory = path.join(packageDirectory, 'src', 'testing', 'N').split(path.sep).join('/');

export default defineConfig({
    resolve: {
        alias: [
            // N/* is only real inside NetSuite; the package's own tests use the stubs it ships.
            { find: /^N\/(.*)$/, replacement: `${stubsDirectory}/$1.ts` },
        ],
    },
    test: {
        environment: 'node',
        include: ['__tests__/**/*.test.ts'],
    },
});
