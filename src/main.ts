import fs from 'fs'
import path from 'path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { ResolveArgs, Resolver } from './dependency-resolution'
import { AnalyzeArgs, Analyzer } from './analysis'
import { AnnotateArgs, Annotator } from './annotation'
import {
    RosettaGenerateArgs as GenerateArgs,
    RosettaGenerator as Generator,
    RosettaUpdater as Updater,
    RosettaUpdateArgs as UpdateArgs,
} from './rosetta'

/**
 * Adds shared yargs options to prefix for all commands.
 */
const addSharedPrefix = (yargs: yargs.Argv, requireInputDir = true) => {
    return yargs
        .option('level', {
            type: 'string',
            alias: 'l',
            choices: ['silent', 'error', 'warn', 'info', 'verbose', 'debug'],
            desc: 'Log level',
            conflicts: ['verbose'],
        })
        .option('verbose', {
            type: 'boolean',
            alias: 'v',
            desc: 'Shortcut for verbose log level',
            conflicts: ['level'],
        })
        .option('input-directory', {
            type: 'string',
            alias: 'i',
            required: requireInputDir,
            conflicts: ['rosetta-only'],
            desc: 'The directory for input Lua files',
        })
}

/**
 * Adds shared yargs options to suffix for all commands.
 */
const addSharedSuffix = (yargs: yargs.Argv) => {
    return yargs
        .option('subdirectories', {
            type: 'array',
            string: true,
            conflicts: ['all-subdirectories'],
            defaultDescription: '"shared client server"',
            desc: 'The subdirectories to read',
        })
        .option('all-subdirectories', {
            type: 'boolean',
            conflicts: ['subdirectories'],
            desc: 'If given, all subdirectories of the input directory will be read',
        })
        .check((args: any) => {
            if (!args.inputDirectory) {
                return true
            }

            if (!fs.existsSync(path.resolve(args.inputDirectory))) {
                throw 'Input directory does not exist.'
            }

            return true
        })
        .wrap(120)
}

const addExcludeOptions = (yargs: yargs.Argv) => {
    return yargs
        .option('exclude', {
            type: 'array',
            alias: 'e',
            string: true,
            desc: 'Classes to exclude from annotations',
        })
        .option('exclude-fields', {
            type: 'array',
            string: true,
            desc: 'Classes to include without fields',
        })
        .option('exclude-known-defs', {
            type: 'boolean',
            defaultDescription: 'true',
            desc: 'Whether known definition classes should be included without fields',
        })
}

const addHeuristicOption = (yargs: yargs.Argv) => {
    return yargs
        .option('heuristics', {
            type: 'boolean',
            default: true,
            hidden: true,
            desc: 'Whether to apply heuristics to guess types',
        })
        .option('no-heuristics', {
            type: 'boolean',
            desc: 'Disable assumption of types based on common patterns',
        })
}

const addRosettaOptions = (yargs: yargs.Argv) => {
    return yargs
        .option('output-directory', {
            type: 'string',
            alias: 'o',
            required: true,
            desc: 'The directory for output files',
        })
        .option('format', {
            type: 'string',
            alias: 'f',
            default: 'yml',
            choices: ['json', 'yml'],
            desc: 'The format to use for generated files',
        })
}

const addOutputFileOption = (yargs: yargs.Argv) => {
    return yargs.option('output-file', {
        type: 'string',
        alias: 'o',
        desc: 'The output file for report results',
    })
}

/**
 * Adds the CLI options for the annotate command.
 */
const annotateCommand = (yargs: yargs.Argv) => {
    addSharedPrefix(yargs, false)
        .option('output-directory', {
            type: 'string',
            alias: 'o',
            required: true,
            desc: 'The directory for output stubs',
        })
        .option('alphabetize', {
            type: 'boolean',
            default: true,
            desc: 'Whether fields and functions should be alphabetically sorted',
        })
        .option('include-kahlua', {
            type: 'boolean',
            alias: 'k',
            desc: 'Whether to generate the kahlua stub.',
        })
        .option('inject', {
            type: 'boolean',
            hidden: true,
        })
        .option('no-inject', {
            type: 'boolean',
            defaultDescription: 'false',
            desc: 'Disallow injecting additional data from Rosetta',
        })
        .option('strict-fields', {
            type: 'boolean',
            hidden: true,
            default: true,
        })
        .option('no-strict-fields', {
            type: 'boolean',
            defaultDescription: 'false',
            desc: 'Marks classes as accepting fields of any type',
        })
        .option('rosetta', {
            type: 'string',
            alias: 'r',
            desc: 'The directory to use for rosetta files',
        })
        .option('rosetta-only', {
            type: 'boolean',
            conflicts: ['input-directory', 'inject'],
            implies: ['rosetta'],
            desc: 'Generate typestubs using only Rosetta data',
        })
        .check((args: any) => {
            if (!args.inputDirectory && !args.rosettaOnly) {
                throw new Error(
                    'Missing required argument: input-directory or rosetta-only',
                )
            }

            return true
        })

    addHeuristicOption(yargs)
    addExcludeOptions(yargs)
    return addSharedSuffix(yargs)
}

/**
 * Adds the CLI options for the rosetta initialization command.
 */
const initRosettaCommand = (yargs: yargs.Argv) => {
    addSharedPrefix(yargs)

    addRosettaOptions(yargs)
    addHeuristicOption(yargs)
    addExcludeOptions(yargs)

    return addSharedSuffix(yargs)
}

/**
 * Adds the CLI options for the rosetta update command.
 */
const updateRosettaCommand = (yargs: yargs.Argv) => {
    addSharedPrefix(yargs)

    addRosettaOptions(yargs)
    addHeuristicOption(yargs)

    yargs
        .option('delete-unknown', {
            type: 'boolean',
            default: true,
            hidden: true,
        })
        .option('no-delete-unknown', {
            type: 'boolean',
            defaultDescription: 'false',
            desc: 'Display warnings for unknown items instead of deleting them',
        })
        .option('keep-types', {
            type: 'boolean',
            default: 'false',
            desc: 'If given, currently documented Rosetta types will not be updated',
        })
        .option('extra-files', {
            type: 'array',
            string: true,
            desc: 'List of file identifiers to treat as known files',
        })

    addExcludeOptions(yargs)

    return addSharedSuffix(yargs)
}

/**
 * Adds the CLI options for the report-analysis command.
 */
const reportAnalysisCommand = (yargs: yargs.Argv) => {
    addSharedPrefix(yargs)
    addOutputFileOption(yargs)
    addHeuristicOption(yargs)

    return addSharedSuffix(yargs)
}

/**
 * Adds the CLI options for the report-deps command.
 */
const reportDepsCommand = (yargs: yargs.Argv) => {
    addSharedPrefix(yargs)
    addOutputFileOption(yargs)

    return addSharedSuffix(yargs)
}

yargs(hideBin(process.argv))
    .scriptName('pz-lua-stubgen')
    .command(
        '$0',
        'Generates typestubs for Lua files',
        annotateCommand,
        (async (args: AnnotateArgs) => await new Annotator(args).run()) as any,
    )
    .command(
        'init-rosetta',
        'Generates default Rosetta data files',
        initRosettaCommand,
        (async (args: GenerateArgs) => await new Generator(args).run()) as any,
    )
    .command(
        'update-rosetta',
        'Updates Rosetta data files',
        updateRosettaCommand,
        (async (args: UpdateArgs) => await new Updater(args).run()) as any,
    )
    .command(
        'report-analysis',
        'Reports on analyzed and inferred Lua types',
        reportAnalysisCommand,
        (async (args: AnalyzeArgs) =>
            await new Analyzer(args).generateReport()) as any,
    )
    .command(
        'report-deps',
        'Reports on requires, global reads/writes, and the resolved analysis order',
        reportDepsCommand,
        (async (args: ResolveArgs) =>
            await new Resolver(args).generateReport()) as any,
    )
    .strict()
    .demandCommand()
    .parseAsync()
    .catch((e) => console.error(e))
