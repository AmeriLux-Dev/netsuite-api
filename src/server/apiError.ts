/** Thrown by domain code or handlers; the controller wrapper turns it into the envelope's status and error. */
export class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly details?: unknown) {
        super(message);
        this.name = 'ApiError';
    }

    static badRequest(message: string, details?: unknown): ApiError {
        return new ApiError(400, message, details);
    }

    static notFound(message: string, details?: unknown): ApiError {
        return new ApiError(404, message, details);
    }

    static forbidden(message = 'Not permitted'): ApiError {
        return new ApiError(403, message);
    }
}
