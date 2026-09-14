export interface ParsedCommandLine {
    command?: string;
    options: Record<string, string | boolean>;
    positional: string[];
}

/** Parses `command --key value --key=value --flag positional` without any dependency. */
export function parseCommandLineArguments(argv: string[]): ParsedCommandLine {
    const parsed: ParsedCommandLine = { options: {}, positional: [] };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument.startsWith('--')) {
            const body = argument.slice(2);
            const equalsIndex = body.indexOf('=');
            if (equalsIndex >= 0) {
                parsed.options[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1);
            } else if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
                parsed.options[body] = argv[++index];
            } else {
                parsed.options[body] = true;
            }
        } else if (parsed.command === undefined) {
            parsed.command = argument;
        } else {
            parsed.positional.push(argument);
        }
    }
    return parsed;
}

export function readStringOption(options: Record<string, string | boolean>, name: string): string | undefined {
    const value = options[name];
    return typeof value === 'string' ? value : undefined;
}

export function readFlagOption(options: Record<string, string | boolean>, name: string): boolean {
    return options[name] === true || options[name] === 'true';
}
