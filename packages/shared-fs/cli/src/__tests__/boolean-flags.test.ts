import { describe, expect, it, vi } from "vitest";
import { createCliParser } from "../index.js";

/**
 * A boolean option given a value. yargs read every value but true or false
 * as false: `conflicts --fail-if-any=1` turned the CI gate off and
 * `mount --persistOnExit=30000` skipped the shutdown wait. The table covers
 * every boolean option of every command, as yargs knows them for the command
 * being parsed, in each spelling yargs reads as the option.
 */

const STOP = new Error("stopped before the command handler");

type Outcome =
    | { argv: Record<string, unknown> }
    | { refused: string }
    | { exit: number };

/**
 * `args` parsed as peerbit-fs parses them, stopped before the command
 * handler: the `keys` of the handler's argv, the message of a usage error
 * (yargs prints the command's usage, then the message), or { exit: 0 } where
 * yargs prints help or the version instead.
 */
const parse = async (args: string[], keys: string[]): Promise<Outcome> => {
    const errors: unknown[][] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...line) => {
        errors.push(line);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let argv: Record<string, unknown> | undefined;
    try {
        await createCliParser(args)
            // yargs throws its usage error instead of exiting 1 (the
            // lazy-runtime tests check the exit), and returns where it would
            // exit 0.
            .exitProcess(false)
            .middleware((parsed) => {
                argv = parsed;
                throw STOP;
            })
            .parseAsync();
        return { exit: 0 };
    } catch (rejection) {
        if (rejection === STOP && argv) {
            return {
                argv: Object.fromEntries(keys.map((key) => [key, argv![key]])),
            };
        }
        if (rejection instanceof Error && rejection.name === "YError") {
            return { refused: String(errors.at(-1)?.[0]) };
        }
        throw rejection;
    } finally {
        log.mockRestore();
        error.mockRestore();
    }
};

type Options = {
    boolean: string[];
    string: string[];
    number: string[];
    array: string[];
    choices: Record<string, string[]>;
};
type Known = { options: Options; aliases: Record<string, string[]> };
type Command = Known & {
    name: string;
    positionals: { name: string; required: boolean }[];
    placeholders: string[];
};

/** What yargs knows of the options of `args`' command, before validation. */
const optionsOf = async (args: string[]) => {
    const parser = createCliParser(args);
    let known: Known | undefined;
    try {
        await parser
            .middleware(() => {
                // Not in @types/yargs: the options of the command parsed.
                const options = (
                    parser as unknown as { getOptions(): Options }
                ).getOptions();
                known = {
                    options: {
                        boolean: [...options.boolean],
                        string: [...options.string],
                        number: [...options.number],
                        array: [...options.array],
                        choices: { ...options.choices },
                    },
                    aliases: {
                        ...(parser.parsed ? parser.parsed.aliases : {}),
                    },
                };
                throw STOP;
            }, true)
            .parseAsync();
    } catch (rejection) {
        if (rejection !== STOP) throw rejection;
    }
    return known!;
};

/**
 * Every command, from peerbit-fs's own definitions: its positionals (from
 * its usage line), the arguments that reach its options (a placeholder or
 * the first choice per required positional), and its options.
 */
const listCommands = async () => {
    const help = await createCliParser([]).getHelp();
    const commands: Command[] = [];
    for (const [, name] of help.matchAll(/^ {2}peerbit-fs ([a-z][\w-]*)/gm)) {
        const usage = (await createCliParser([name]).getHelp()).split("\n")[0];
        const positionals = [...usage.matchAll(/([<[])([\w-]+)[>\]]/g)].map(
            ([, bracket, positional]) => ({
                name: positional,
                required: bracket === "<",
            })
        );
        const required = positionals.filter(
            (positional) => positional.required
        );
        const known = await optionsOf([
            name,
            ...required.map((positional) => `x-${positional.name}`),
        ]);
        const placeholders = required.map(
            (positional) =>
                known.options.choices[positional.name]?.[0] ??
                `x-${positional.name}`
        );
        commands.push({ name, positionals, placeholders, ...known });
    }
    return commands;
};

const REFUSED = ["1", "0", "yes", "no", "30000", ""];
const HINTS: Record<string, string> = {
    "persist-on-exit": "; set the wait with --persist-timeout-ms",
};

/** fail-if-any -> fail-If-any: yargs reaches it through camelCase alone. */
const mixedCase = (option: string) =>
    option.replace(/-(\w)/, (_, letter: string) => `-${letter.toUpperCase()}`);

type Row = { args: string[]; keys: string[]; outcome: Outcome };

/** Each row's arguments and the outcome peerbit-fs gives them. */
const tableOf = (command: Command) => {
    const base = [command.name, ...command.placeholders];
    const rows: Row[] = [];
    for (const option of command.options.boolean) {
        const spellings = [option, ...(command.aliases[option] ?? [])];
        const hint = HINTS[option] ?? "";
        // The keys are read only where the command would run instead.
        const refused = (flag: string, value: string) =>
            rows.push({
                args: [...base, `${flag}=${value}`],
                keys: spellings,
                outcome: {
                    refused: `${flag}=${value}: ${flag} takes no value${hint}`,
                },
            });
        const accepted = (arg: string, value: boolean) =>
            rows.push({
                args: [...base, arg],
                keys: spellings,
                // yargs' own --help and --version print and exit 0.
                outcome:
                    value && (option === "help" || option === "version")
                        ? { exit: 0 }
                        : {
                              argv: Object.fromEntries(
                                  spellings.map((spelling) => [spelling, value])
                              ),
                          },
            });
        for (const spelling of spellings) {
            for (const value of REFUSED) {
                refused(`--${spelling}`, value);
            }
            accepted(`--${spelling}=true`, true);
            accepted(`--${spelling}=false`, false);
            accepted(`--${spelling}`, true);
            accepted(`--no-${spelling}`, false);
            for (const value of [...REFUSED, "true", "false"]) {
                refused(`--no-${spelling}`, value);
            }
        }
        if (option.includes("-")) {
            for (const value of [...REFUSED, "true", "false"]) {
                refused(`--${mixedCase(option)}`, value);
            }
        }
    }
    // Options that are not boolean keep their values.
    const positionals = new Set(command.positionals.map(({ name }) => name));
    const { array, number, string } = command.options;
    for (const option of new Set([...array, ...number, ...string])) {
        if (positionals.has(option)) continue;
        const value = array.includes(option)
            ? ["7"]
            : number.includes(option)
              ? 7
              : "7";
        rows.push({
            args: [...base, `--${option}=7`],
            keys: [option],
            outcome: { argv: { [option]: value } },
        });
    }
    // After --, an argument is not an option: yargs passes it on in argv._.
    for (const option of command.options.boolean) {
        rows.push({
            args: [...base, "--", `--${option}=1`],
            keys: ["_"],
            outcome: { argv: { _: [command.name, `--${option}=1`] } },
        });
    }
    return rows;
};

describe("a boolean flag given a value", () => {
    it("is refused for every boolean option of every command and each spelling, unless it is true or false; the rest parses as before", async () => {
        const commands = await listCommands();
        const owners = commands.flatMap(({ name, options }) =>
            options.boolean.map((option) => `${name} ${option}`)
        );
        // Among them the options that were misread, and a hidden one.
        expect(owners).toEqual(
            expect.arrayContaining([
                "conflicts fail-if-any",
                "mount persist-on-exit",
                "mount require-fresh",
                "create auth",
                "gc dry-run",
                "install-adapter if-needed",
            ])
        );
        // Only --<name>=<value> is read: -f=1 would pass a one-letter alias.
        expect(
            commands.flatMap(({ name, options, aliases }) =>
                options.boolean
                    .flatMap((option) => [option, ...(aliases[option] ?? [])])
                    .filter((spelling) => spelling.length === 1)
                    .map((spelling) => `${name} -${spelling}`)
            )
        ).toEqual([]);
        for (const command of commands) {
            const rows = tableOf(command);
            const actual: { args: string; outcome: Outcome }[] = [];
            for (const row of rows) {
                actual.push({
                    args: row.args.join(" "),
                    outcome: await parse(row.args, row.keys),
                });
            }
            expect(actual).toEqual(
                rows.map((row) => ({
                    args: row.args.join(" "),
                    outcome: row.outcome,
                }))
            );
        }
    });
});
