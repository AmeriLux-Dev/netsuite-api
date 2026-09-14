import { vi, type Mock } from 'vitest';

export const getCurrentScript: Mock = vi.fn(() => ({ id: 'customscript_test', deploymentId: 'customdeploy_test', getParameter: vi.fn(), getRemainingUsage: () => 1000 }));
export const getCurrentUser: Mock = vi.fn(() => ({ id: 1, name: 'Test User', role: 3, email: 'test@example.com' }));
export const getCurrentSession: Mock = vi.fn(() => ({ get: vi.fn(), set: vi.fn() }));
export const isFeatureInEffect: Mock = vi.fn(() => false);
export const accountId = 'TSTDRV0000000';
export const envType = 'SANDBOX';
export const EnvType = { SANDBOX: 'SANDBOX', PRODUCTION: 'PRODUCTION' };
