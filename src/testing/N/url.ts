import { vi, type Mock } from 'vitest';

export const resolveScript: Mock = vi.fn(() => '/app/site/hosting/scriptlet.nl?script=1&deploy=1');
export const resolveRecord: Mock = vi.fn(() => '/app/common/entity/custjob.nl?id=1');
export const resolveDomain: Mock = vi.fn(() => 'localhost');
export const format: Mock = vi.fn((options: { domain: string }) => options.domain);
export const HostType = { APPLICATION: 'APPLICATION', RESTLET: 'RESTLET' };
