import { BaseReportArgs } from '../base/types'
import { LuaExpression, LuaRequire, TableField } from './types.helpers'
import { AnalysisContext } from './AnalysisContext'
import { LuaScope } from '../scopes'

interface BaseAnalysisItem {
    /**
     * The scope depth in which the item occurred.
     */
    depth?: number
}

/**
 * An assignment to the result of a require call.
 */
export interface RequireAssignmentItem extends BaseAnalysisItem {
    type: 'requireAssignment'

    /**
     * The path for the left-hand side.
     */
    lhs: LuaExpression

    /**
     * An expression representing the require.
     */
    rhs: LuaRequire

    /**
     * The return value index to associate with the item. 1-indexed.
     */
    index?: number
}

/**
 * Function declaration.
 */
export interface FunctionDefinitionItem extends BaseAnalysisItem {
    type: 'functionDefinition'

    /**
     * The expression for the function name.
     */
    expression?: LuaExpression

    /**
     * The function definition expression.
     */
    literal: LuaExpression

    /**
     * The identifier for the function.
     */
    id: string

    /**
     * `True` if the function is a local function.
     */
    isLocal?: boolean

    /**
     * Parameter names.
     */
    parameters: string[]
}

/**
 * Information about an assignment to a local or global variable.
 */
export interface AssignmentItem extends BaseAnalysisItem {
    type: 'assignment'

    /**
     * The path for the left-hand side.
     */
    lhs: LuaExpression

    /**
     * The expression for the right-hand side.
     */
    rhs: LuaExpression

    /**
     * The index to use for a call assignment.
     */
    index?: number
}

/**
 * Information about the return values of a function.
 */
export interface ReturnsItem extends BaseAnalysisItem {
    type: 'returns'

    /**
     * The function identifier.
     */
    id: string

    /**
     * Information about the values in the return statement.
     */
    returns: LuaExpression[]
}

/**
 * Information about the usage of an item.
 */
export interface UsageItem extends BaseAnalysisItem {
    type: 'usage'

    /**
     * The path for the usage item.
     */
    expression: LuaExpression

    /**
     * Arguments that the usage item was called with.
     * This can be used to narrow to `function | table`, and to narrow parameter types.
     */
    arguments?: LuaExpression[]

    /**
     * `True` if the item was used in a numeric for initializer.
     * This can be used to narrow to `number`.
     */
    inNumericFor?: boolean

    /**
     * `True` if the item was found in a concatenation expression.
     * This can be used to narrow to `string | number | table`.
     */
    supportsConcatenation?: boolean

    /**
     * `True` if the item was found as a base in a member or indexer expression.
     * This can be used to narrow to `table | string`.
     */
    supportsIndexing?: boolean

    /**
     * `True` if the item was found as a base in a member or indexer assignment expression.
     * This can be used to narrow to `table`.
     */
    supportsIndexAssignment?: boolean

    /**
     * `True` if the item was found as an operand to the `#` operator.
     * This can be used to narrow to `table | string`.
     */
    supportsLength?: boolean

    /**
     * `True` if the item was found in a mathematical expression.
     * This can be used to narrow to `number | table`.
     */
    supportsMath?: boolean
}

export interface ResolvedClassInfo {
    name: string
    tableId: string
    definingModule?: string
    base?: string
    deriveName?: string
    generated?: boolean
}

export interface ResolvedFunctionInfo {
    name: string

    functionId: string
}

export interface ResolvedRequireInfo {
    name: string

    module: string
}

export interface ResolvedScopeItem extends BaseAnalysisItem {
    type: 'resolved'

    id: string

    classes: ResolvedClassInfo[]

    functions: ResolvedFunctionInfo[]

    returns?: ResolvedReturnInfo[]

    requires: ResolvedRequireInfo[]

    seenClasses: Set<string>
}

export interface ResolvedModule extends Omit<ResolvedScopeItem, 'returns'> {
    scope: LuaScope
    returns: ResolvedReturnInfo[]
}

export interface PartialItem extends BaseAnalysisItem {
    type: 'partial'

    seenClassId?: string

    classInfo?: ResolvedClassInfo

    functionInfo?: ResolvedFunctionInfo

    requireInfo?: ResolvedRequireInfo
}

export interface LuaExpressionInfo {
    expression: LuaExpression

    index?: number

    instance?: boolean

    functionLevel?: boolean

    fromLiteral?: boolean

    definingModule?: string
}

export interface ResolvedReturnInfo {
    types: Set<string>

    expressions: Set<LuaExpression>
}

export interface FunctionInfo {
    id: string

    identifierExpression?: LuaExpression

    /**
     * List of parameter IDs.
     */
    parameters: string[]

    /**
     * List of parameter names.
     */
    parameterNames: string[]

    /**
     * Set of potential parameter types inferred by usage.
     */
    parameterTypes: Set<string>[]

    /**
     * Analyzed return types.
     */
    returnTypes: Set<string>[]

    /**
     * Expressions associated with each return statement.
     */
    returnExpressions: Set<LuaExpression>[]

    /**
     * The minimum number of returns found in the function scope.
     * This is used to make return values nullable.
     */
    minReturns?: number

    isConstructor?: boolean
}

export interface TableInfo {
    id: string

    /**
     * Fields defined in the table constructor.
     */
    literalFields: TableField[]

    /**
     * Maps Lua literal keys to expressions for their definitions.
     */
    definitions: Map<string, LuaExpressionInfo[]>

    /**
     * The module in which the initial definition of the class was found.
     */
    definingModule?: string

    /**
     * The class assigned to this table.
     */
    className?: string

    /**
     * The ID of the class containing this table as a field.
     */
    containerId?: string

    /**
     * The name for instances of the class assigned to this table.
     */
    instanceName?: string

    /**
     * The table ID for instances of the class assigned to this table.
     */
    instanceId?: string

    /**
     * Whether the table was created from a local `:derive` assignment.
     */
    fromHiddenClass?: boolean

    /**
     * The name of the base class, for hidden classes that are ultimately assigned to a global.
     */
    originalBase?: string

    /**
     * The name of the class type, for hidden classes that are ultimately assigned to a global.
     */
    originalDeriveName?: string

    /**
     * Flag for a table belonging to an overwritten class.
     */
    isEmptyClass?: boolean

    /**
     * Flag for a table belonging to a closure-based class.
     */
    isClosureClass?: boolean

    /**
     * Flag for a table belonging to an Atom UI class.
     */
    isAtomUI?: boolean

    /**
     * Flag for a table which is a base Atom UI class.
     */
    isAtomUIBase?: boolean

    /**
     * Flag for emitting the class as a simple table without a class annotation.
     */
    emitAsTable?: boolean
}

export {
    BasicLuaType,
    LuaType,
    LuaExpression,
    LuaLiteral,
    LuaReference,
    LuaOperation,
    LuaMember,
    LuaRequire,
    LuaIndex,
    TableKey,
    TableField,
    AnalyzedParameter,
    AnalyzedFunction,
    AnalyzedField,
    AnalyzedTable,
    AnalyzedClass,
    AnalyzedReturn,
    AnalyzedModule,
} from './types.helpers'

export type AnalysisItem =
    | AssignmentItem
    | RequireAssignmentItem
    | FunctionDefinitionItem
    | ReturnsItem
    | UsageItem
    | ResolvedScopeItem
    | PartialItem

/**
 * Arguments for type analysis.
 */
export interface AnalyzeArgs extends BaseReportArgs {
    heuristics?: boolean
    isRosettaInit?: boolean
}

export interface AnalysisContextArgs {
    heuristics?: boolean
    isRosettaInit?: boolean
}
