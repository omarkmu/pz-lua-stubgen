import { AnalysisContext } from './AnalysisContext'
import {
    LuaExpression,
    LuaExpressionInfo,
    LuaLiteral,
    LuaOperation,
    TableInfo,
} from './types'

/**
 * Handles resolution of Lua types.
 */
export class TypeResolver {
    protected context: AnalysisContext

    constructor(context: AnalysisContext) {
        this.context = context
    }

    /**
     * Resolves the potential types of an expression.
     */
    resolve(
        info: LuaExpressionInfo,
        seen?: Map<LuaExpressionInfo, Set<string>>,
    ): Set<string> {
        seen ??= new Map()
        const types = new Set<string>()

        if (this.checkCycle(info, types, seen)) {
            return types
        }

        seen.set(info, new Set())

        const expression = info.expression
        let typesToAdd: Set<string>
        switch (expression.type) {
            case 'literal':
                typesToAdd = new Set()
                if (expression.literal === 'true') {
                    typesToAdd.add('true')
                } else if (expression.literal === 'false') {
                    typesToAdd.add('false')
                } else if (expression.tableId) {
                    typesToAdd.add(expression.tableId)
                } else if (expression.functionId) {
                    typesToAdd.add(expression.functionId)
                } else {
                    typesToAdd.add(expression.luaType)
                }

                break

            case 'operation':
                typesToAdd = this.resolveOperationTypes(
                    expression,
                    seen,
                    info.index,
                )

                break

            case 'reference':
                typesToAdd = new Set()
                const id = expression.id
                const isParam =
                    id.startsWith('@parameter') || id.startsWith('@self')

                // add IDs as types for later resolution
                if (
                    isParam ||
                    id.startsWith('@function') ||
                    id.startsWith('@instance')
                ) {
                    typesToAdd.add(id)
                }

                if (isParam) {
                    const funcId = this.context.getFunctionIdFromParamId(id)
                    if (!funcId) {
                        break
                    }

                    const funcInfo = this.context.getFunctionInfo(funcId)
                    for (let i = 0; i < funcInfo.parameters.length; i++) {
                        if (id !== funcInfo.parameters[i]) {
                            continue
                        }

                        funcInfo.parameterTypes[i]?.forEach((x) =>
                            typesToAdd.add(x),
                        )

                        break
                    }
                }

                for (const def of this.context.getDefinitions(id)) {
                    this.resolve(def, seen).forEach((x) => typesToAdd.add(x))
                }

                break

            case 'member':
                const memberBaseTypes = this.resolve(
                    { expression: expression.base, index: info.index },
                    seen,
                )

                typesToAdd = this.resolveFieldTypes(
                    memberBaseTypes,
                    expression.member,
                    false,
                    seen,
                )

                break

            case 'index':
                const indexBaseTypes = this.resolve(
                    { expression: expression.base, index: info.index },
                    seen,
                )

                const index = this.resolveToLiteral(expression.index, seen)

                if (!index || !index.literal) {
                    typesToAdd = new Set()
                    break
                }

                const key = this.context.getLiteralKey(
                    index.literal,
                    index.luaType,
                )

                typesToAdd = this.resolveFieldTypes(
                    indexBaseTypes,
                    key,
                    true,
                    seen,
                )

                break

            case 'require':
                const mod = this.context.getModule(expression.module, true)
                if (!mod) {
                    typesToAdd = new Set()
                    break
                }

                const targetIdx = info.index ?? 1
                typesToAdd = mod.returns[targetIdx - 1]?.types ?? new Set()

                break
        }

        this.narrowTypes(expression, typesToAdd)

        typesToAdd.forEach((x) => types.add(x))
        seen.set(info, types)

        if (types.has('true') && types.has('false')) {
            types.delete('true')
            types.delete('false')
            types.add('boolean')
        }

        return types
    }

    /**
     * Resolves the return types of a function operation.
     */
    resolveReturnTypes(
        op: LuaOperation,
        seen?: Map<LuaExpressionInfo, Set<string>>,
    ): Set<string>[] | undefined {
        const func = op.arguments[0]
        if (!func) {
            return
        }

        const types: Set<string>[] = []
        const knownTypes = new Set<string>()
        if (this.addKnownReturns(func, knownTypes)) {
            types.push(knownTypes)
            return types
        }

        const resolvedFuncTypes = this.resolve({ expression: func }, seen)
        if (!resolvedFuncTypes || resolvedFuncTypes.size !== 1) {
            return
        }

        const resolvedFunc = [...resolvedFuncTypes][0]
        if (!resolvedFunc.startsWith('@function')) {
            return
        }

        // handle constructors
        const funcInfo = this.context.getFunctionInfo(resolvedFunc)
        if (funcInfo.isConstructor) {
            types.push(new Set())
            types[0].add('@instance') // mark as an instance to correctly attribute fields
            funcInfo.returnTypes[0]?.forEach((x) => types[0].add(x))
            return types
        }

        for (let i = 0; i < funcInfo.returnTypes.length; i++) {
            types.push(new Set(funcInfo.returnTypes[i]))
        }

        return types
    }

    /**
     * Resolves an expression into a basic literal, if it can be determined
     * to be resolvable to one.
     */
    resolveToLiteral(
        expression: LuaExpression,
        seen?: Map<LuaExpressionInfo, Set<string>>,
    ): LuaLiteral | undefined {
        const stack: LuaExpressionInfo[] = []

        stack.push({ expression })

        while (stack.length > 0) {
            const info = stack.pop()!
            const expr = info.expression

            let key: string
            let tableInfo: TableInfo
            let fieldDefs: LuaExpressionInfo[] | undefined
            switch (expr.type) {
                case 'literal':
                    if (
                        expr.luaType !== 'table' &&
                        expr.luaType !== 'function'
                    ) {
                        return expr
                    }

                    return

                case 'reference':
                    fieldDefs = this.context.getDefinitions(expr.id)
                    if (fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'member':
                    const memberBase = [
                        ...this.resolve({ expression: expr.base }),
                    ]

                    if (memberBase.length !== 1) {
                        break
                    }

                    tableInfo = this.context.getTableInfo(memberBase[0])
                    key = this.context.getLiteralKey(expr.member)
                    fieldDefs = tableInfo.definitions.get(key) ?? []

                    if (fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'index':
                    const indexBase = [
                        ...this.resolve({ expression: expr.base }),
                    ]

                    if (indexBase.length !== 1) {
                        break
                    }

                    const index = this.resolveToLiteral(expr.index, seen)

                    if (!index || !index.literal) {
                        break
                    }

                    tableInfo = this.context.getTableInfo(indexBase[0])
                    key = this.context.getLiteralKey(
                        index.literal,
                        index.luaType,
                    )

                    fieldDefs = tableInfo.definitions.get(key) ?? []

                    if (fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'operation':
                    const types = [...this.resolve({ expression: expr }, seen)]

                    if (types.length !== 1) {
                        break
                    }

                    // only resolve known booleans
                    if (types[0] === 'true' || types[0] === 'false') {
                        return {
                            type: 'literal',
                            luaType: 'boolean',
                            literal: types[0],
                        }
                    }

                    break
            }
        }
    }

    /**
     * Adds known return types based on function names.
     */
    protected addKnownReturns(
        expr: LuaExpression,
        types: Set<string>,
    ): boolean {
        if (expr.type !== 'reference') {
            return false
        }

        const name = expr.id
        switch (name) {
            case 'tonumber':
                types.add('number')
                types.add('nil')
                return true

            case 'getTextOrNull':
                types.add('string')
                types.add('nil')
                return true

            case 'tostring':
            case 'getText':
                types.add('string')
                return true
        }

        return false
    }

    /**
     * Checks whether the given expression has already been seen.
     * This will attempt to use known types, and will otherwise add `unknown`.
     */
    protected checkCycle(
        info: LuaExpressionInfo,
        types: Set<string>,
        seen: Map<LuaExpressionInfo, Set<string>>,
    ): boolean {
        const existing = seen.get(info)
        if (!existing) {
            return false
        }

        existing.forEach((x) => types.add(x))
        return true
    }

    /**
     * Gets the truthiness of a set of types.
     * If the truth cannot be determined, returns `undefined`
     */
    protected getTruthiness(types: Set<string>): boolean | undefined {
        let hasTruthy = false
        let hasFalsy = false

        for (const type of types) {
            if (type === 'boolean') {
                // can't determine truthiness of `boolean`
                hasTruthy = true
                hasFalsy = true
                break
            }

            if (type === 'false' || type === 'nil') {
                hasFalsy = true
            } else {
                hasTruthy = true
            }
        }

        if (hasTruthy === hasFalsy) {
            return
        } else {
            return hasTruthy
        }
    }

    /**
     * Checks whether an expression is a literal or an
     * operation containing only literals.
     */
    protected isLiteralOperation(expr: LuaExpression) {
        if (expr.type === 'literal') {
            return true
        }

        const stack: LuaExpression[] = [expr]
        while (stack.length > 0) {
            const expression = stack.pop()!

            if (expression.type === 'operation') {
                if (expression.operator === 'call') {
                    return false
                }

                expression.arguments.forEach((x) => stack.push(x))
            } else if (expression.type !== 'literal') {
                return false
            }
        }

        return true
    }

    /**
     * Narrows possible expression types based on usage.
     */
    protected narrowTypes(expr: LuaExpression, types: Set<string>) {
        if (types.size <= 1) {
            // no narrowing necessary
            return
        }

        const usage = this.context.getUsageTypes(expr)
        if (!usage) {
            // no narrowing is possible
            return
        }

        // filter possible types to narrowed types
        const narrowed = [...types].filter((type) => {
            if (type.startsWith('@function') && usage.has('function')) {
                return true
            } else if (type.startsWith('@table') && usage.has('table')) {
                return true
            }

            return usage.has(type)
        })

        if (narrowed.length === 0) {
            // oops, too much narrowing
            return
        }

        types.clear()
        narrowed.forEach((x) => types.add(x))
    }

    /**
     * Resolves the possible types of a table field.
     * @param types The set of types for the base.
     * @param scope The relevant scope.
     * @param field A string representing the field.
     * @param isIndex Whether this is an index operation. If it is, `field` will be interpreted as a literal key.
     */
    protected resolveFieldTypes(
        types: Set<string>,
        field: string,
        isIndex: boolean = false,
        seen?: Map<LuaExpressionInfo, Set<string>>,
    ): Set<string> {
        const fieldTypes = new Set<string>()
        if (types.size === 0) {
            return fieldTypes
        }

        for (const type of types) {
            if (!type.startsWith('@table')) {
                continue
            }

            const info = this.context.getTableInfo(type)
            const literalKey = isIndex
                ? field
                : this.context.getLiteralKey(field)

            const fieldDefs = info.definitions.get(literalKey) ?? []

            for (const def of fieldDefs) {
                this.resolve(def, seen).forEach((x) => fieldTypes.add(x))
            }
        }

        return fieldTypes
    }

    /**
     * Resolves the possible types for the result of an operation.
     * @param op The operation expression.
     * @param scope The relevant scope.
     * @param index For call operations, this is used to determine which return type to use.
     */
    protected resolveOperationTypes(
        op: LuaOperation,
        seen?: Map<LuaExpressionInfo, Set<string>>,
        index: number = 1,
    ): Set<string> {
        const types = new Set<string>()

        let lhs: LuaExpression | undefined
        let rhs: LuaExpression | undefined
        let lhsTypes: Set<string> | undefined
        let rhsTypes: Set<string> | undefined
        let lhsTruthy: boolean | undefined

        switch (op.operator) {
            case 'call':
                const returnTypes = this.resolveReturnTypes(op, seen)
                if (returnTypes === undefined) {
                    break
                }

                const returns = returnTypes[index - 1]
                if (!returns) {
                    types.add('nil')
                    break
                }

                returns.forEach((x) => types.add(x))
                break

            case '..':
                types.add('string')
                break

            case '~=':
            case '==':
            case '<':
            case '<=':
            case '>':
            case '>=':
                types.add('boolean')
                break

            case '+':
            case '-':
            case '*':
            case '%':
            case '^':
            case '/':
            case '//':
            case '&':
            case '|':
            case '~':
            case '<<':
            case '>>':
            case '#':
                types.add('number')
                break

            case 'not':
                const argTypes = this.resolve(
                    { expression: op.arguments[0] },
                    seen,
                )

                const truthy = this.isLiteralOperation(op.arguments[0])
                    ? this.getTruthiness(argTypes)
                    : undefined

                if (truthy === undefined) {
                    // can't determine truthiness; use boolean
                    types.add('boolean')
                    break
                } else {
                    types.add(truthy ? 'false' : 'true')
                    break
                }

            case 'or':
                lhs = op.arguments[0]
                rhs = op.arguments[1]

                lhsTypes = this.resolve({ expression: lhs }, seen)
                rhsTypes = this.resolve({ expression: rhs }, seen)

                // X and Y or Z → use Y & Z (ternary special case)
                if (lhs.type === 'operation' && lhs.operator === 'and') {
                    lhsTypes = this.resolve(
                        { expression: lhs.arguments[1] },
                        seen,
                    )
                }

                lhsTruthy = this.isLiteralOperation(lhs)
                    ? this.getTruthiness(lhsTypes)
                    : undefined

                rhsTypes.forEach((x) => types.add(x))

                // lhs falsy → use only rhs types
                if (lhsTruthy === false) {
                    break
                }

                // lhs truthy or undetermined → use both
                lhsTypes.forEach((x) => types.add(x))
                break

            case 'and':
                lhs = op.arguments[0]
                rhs = op.arguments[1]

                lhsTypes = this.resolve({ expression: lhs }, seen)
                rhsTypes = this.resolve({ expression: rhs }, seen)

                lhsTruthy = this.isLiteralOperation(lhs)
                    ? this.getTruthiness(lhsTypes)
                    : undefined

                if (lhsTruthy === true) {
                    // lhs truthy → use rhs types
                    rhsTypes.forEach((x) => types.add(x))
                } else if (lhsTruthy === false) {
                    // lhs falsy → use lhs types
                    lhsTypes.forEach((x) => types.add(x))
                } else {
                    // undetermined → use both
                    lhsTypes.forEach((x) => types.add(x))
                    rhsTypes.forEach((x) => types.add(x))
                }

                break
        }

        return types
    }
}
