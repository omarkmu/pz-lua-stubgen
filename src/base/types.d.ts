import type ast from 'luaparse'

/**
 * Base arguments for a stub generation command.
 */
interface BaseArgs {
    /**
     * The directory to read Lua files from.
     */
    inputDirectory?: string

    /**
     * Subdirectories to read Lua files from, in order of priority.
     * Dependency analysis may reorder the analysis.
     *
     * Defaults to ['shared', 'client', 'server'].
     */
    subdirectories?: string[]

    /**
     * If given, all subdirectories will be read.
     * This will make it so that the `subdirectories` option is ignored.
     */
    allSubdirectories?: boolean

    /**
     * Log level.
     */
    level?: string

    /**
     * If `true`, use the `verbose` log level.
     */
    verbose?: boolean

    /**
     * If `true`, use the `silent` log level.
     */
    silent?: boolean
}

/**
 * Base arguments for a class that reports on Lua information.
 */
interface BaseReportArgs extends BaseArgs {
    /**
     * The output file for a report.
     * If the given string does not end with `.json`, this is interpreted as a directory
     * and the output is sent to `report.json` in that directory.
     */
    outputFile?: string
}

/**
 * Base arguments for a class that handles annotation.
 */
export interface BaseAnnotateArgs extends BaseArgs {
    /**
     * The directory to write files to.
     */
    outputDirectory: string

    /**
     * The directory to load rosetta files from.
     */
    rosetta?: string

    /**
     * Whether annotation should be performed using only rosetta data.
     */
    rosettaOnly?: boolean

    /**
     * Whether injection via Rosetta of data that wasn't detected in the source is enabled.
     */
    inject?: boolean

    /**
     * Classes which should be excluded from the generated stubs.
     */
    exclude?: string[]

    /**
     * Classes whose fields should be excluded from the generated stubs.
     */
    excludeFields?: string[]

    /**
     * Whether known large definition classes should have their fields excluded.
     */
    excludeKnownDefs?: boolean

    heuristics?: boolean
}

type AssignmentLHS = ast.Identifier | ast.MemberExpression | ast.IndexExpression

type AnyCallExpression =
    | ast.CallExpression
    | ast.StringCallExpression
    | ast.TableCallExpression

type BasicLiteral =
    | ast.StringLiteral
    | ast.BooleanLiteral
    | ast.NumericLiteral
    | ast.NilLiteral

type ResolvableOperation = ast.UnaryExpression | ast.BinaryExpression
