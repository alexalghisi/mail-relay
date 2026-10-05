export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
    info(msg: string, fields?: Fields): void;
    warn(msg: string, fields?: Fields): void;
    error(msg: string, fields?: Fields): void;
}

/** One logfmt line per entry: easy to read in a terminal and to grep. */
export function createLogger(component: string, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
    const emit = (level: string, msg: string, fields: Fields = {}) => {
        const time = new Date().toISOString().slice(11, 23);
        const rest = Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${formatValue(v)}`)
            .join(" ");
        write(`${time} ${level.padEnd(5)} ${component.padEnd(8)} ${msg}${rest ? " " + rest : ""}`);
    };
    return {
        info: (msg, fields) => emit("info", msg, fields),
        warn: (msg, fields) => emit("warn", msg, fields),
        error: (msg, fields) => emit("error", msg, fields),
    };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function formatValue(value: string | number | boolean | null | undefined): string {
    const s = String(value);
    return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}
