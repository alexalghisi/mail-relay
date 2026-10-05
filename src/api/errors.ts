/** Errors the API reports to clients, in the shape `{ statusCode, name, message }`. */
export class ApiError extends Error {
    readonly statusCode: number;
    readonly code: string;

    constructor(statusCode: number, code: string, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }

    toJSON(): { statusCode: number; name: string; message: string } {
        return { statusCode: this.statusCode, name: this.code, message: this.message };
    }
}
