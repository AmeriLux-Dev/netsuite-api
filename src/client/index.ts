/**
 * The browser side of the API: the calls the generated client modules make, one per endpoint, and the
 * configuration they share. Runs in the browser only; nothing here imports N/*.
 */
export { ApiClientError, NETSUITE_API_BASE_PATHS, NO_RESPONSE_STATUS, buildApiUrl, callEndpoint, callRawEndpoint, configureApiClient } from './apiClient.js';
export type { ApiBasePaths, ApiCallContext, ApiCallOptions, ApiClientConfiguration, ApiErrorHandler } from './apiClient.js';
export { ENDPOINT_PARAMETER } from '../index.js';
export type {
    ApiEnvelope,
    ApiErrorBody,
    JobRun,
    JobRunError,
    JobRunListEntry,
    JobRunQuery,
    JobRunStage,
    JobRunStatus,
    RawResponse,
    ScriptDeclaration,
    ScriptKind,
    ScriptRef,
} from '../index.js';
