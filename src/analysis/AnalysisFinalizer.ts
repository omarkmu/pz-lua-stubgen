import { getLuaFieldKey, isEmptyClass } from '../helpers'
import { AnalysisContext } from './AnalysisContext'
import {
    AnalyzedClass,
    AnalyzedField,
    AnalyzedFunction,
    AnalyzedModule,
    AnalyzedParameter,
    AnalyzedReturn,
    AnalyzedTable,
    LuaExpression,
    LuaExpressionInfo,
    LuaType,
    ResolvedClassInfo,
    ResolvedModule,
    ResolvedRequireInfo,
    ResolvedReturnInfo,
    TableField,
    TableKey,
} from './types'

/**
 * Handles finalizing Lua modules and types.
 */
export class AnalysisFinalizer {
    protected context: AnalysisContext

    constructor(context: AnalysisContext) {
        this.context = context
    }

    /**
     * Finalizes the analyzed modules.
     * @returns Map of file identifiers to analyzed modules.
     */
    finalize(): Map<string, AnalyzedModule> {
        const modules = new Map<string, AnalyzedModule>()

        const clsMap = new Map<string, AnalyzedClass[]>()
        for (const [id, mod] of this.context.modules) {
            this.context.currentModule = id
            const refSet = this.getReferences(mod)
            const refMap: Map<string, LuaExpression | null> = new Map()

            for (const id of refSet) {
                let expression: LuaExpression | undefined
                if (id.startsWith('@function')) {
                    const info = this.finalizeFunction(id, '@local')
                    expression = {
                        type: 'literal',
                        luaType: 'function',
                        isMethod: info.isMethod,
                        parameters: info.parameters,
                        returnTypes: info.returnTypes,
                    }
                } else {
                    const defs = this.context.getDefinitions(id)
                    ;[expression] = this.finalizeDefinitions(defs, refMap)
                }

                refMap.set(id, expression ?? null)
            }

            const classes: AnalyzedClass[] = []
            const tables: AnalyzedTable[] = []

            let i = 0
            const seenClasses = new Set<string>()
            const readingClasses = [...mod.classes]
            while (i < readingClasses.length) {
                const cls = readingClasses[i]
                seenClasses.add(cls.name)
                const [finalized, isTable, extra] = this.finalizeClass(
                    cls,
                    refMap,
                )

                if (isTable) {
                    tables.push(finalized)
                } else {
                    readingClasses.push(
                        ...extra.filter((x) => !seenClasses.has(x.name)),
                    )

                    const finalizedCls = finalized as AnalyzedClass

                    // avoid writing unnecessary empty class annotations
                    if (
                        cls.definingModule &&
                        cls.definingModule !== this.context.currentModule &&
                        isEmptyClass(finalizedCls)
                    ) {
                        i++
                        continue
                    }

                    classes.push(finalizedCls)

                    let list = clsMap.get(finalized.name)
                    if (!list) {
                        list = []
                        clsMap.set(finalized.name, list)
                    }

                    list.push(finalizedCls)
                }

                i++
            }

            const fields: AnalyzedField[] = []
            for (const req of mod.requires) {
                fields.push(this.finalizeRequire(req))
            }

            for (const field of mod.fields) {
                fields.push(field)
            }

            const functions: AnalyzedFunction[] = []
            for (const func of mod.functions) {
                functions.push(
                    this.finalizeFunction(func.functionId, func.name),
                )
            }

            const returns: AnalyzedReturn[] = []
            for (const ret of mod.returns) {
                returns.push(this.finalizeReturn(ret, refMap))
            }

            modules.set(id, {
                id: id,
                classes,
                tables,
                functions,
                fields,
                returns,
            })
        }

        for (const clsDefs of clsMap.values()) {
            this.finalizeClassFields(clsDefs, clsMap)
        }

        this.context.currentModule = ''
        return modules
    }

    /**
     * Finalizes an analyzed class.
     * @param cls The resolved information about the class.
     * @param refs Map of IDs to expressions that represent them.
     */
    protected finalizeClass(
        cls: ResolvedClassInfo,
        refs: Map<string, LuaExpression | null>,
    ): [
        result: AnalyzedClass | AnalyzedTable,
        isTable: boolean,
        extraClasses: ResolvedClassInfo[],
    ] {
        const info = this.context.getTableInfo(cls.tableId)
        const isTable = info.emitAsTable ?? false
        const isClassDefiner = cls.definingModule === this.context.currentModule

        const fields: AnalyzedField[] = []
        const literalFields: TableField[] = []
        const staticFields: AnalyzedField[] = []
        const methods: AnalyzedFunction[] = []
        const functions: AnalyzedFunction[] = []
        const constructors: AnalyzedFunction[] = []
        const functionConstructors: AnalyzedFunction[] = []
        const setterFields: AnalyzedField[] = []
        const overloads: AnalyzedFunction[] = []

        const literalExpressions = new Map<string, LuaExpression>()
        const literalKeys = new Set<string>()

        const allowLiteralFields =
            isClassDefiner && !this.context.isRosettaInit && !isTable

        for (const field of info.literalFields) {
            let key: TableKey | undefined
            let keyName: string | undefined
            switch (field.key.type) {
                case 'auto':
                    key = field.key
                    keyName = `[${field.key.index}]`
                    break

                case 'string':
                    key = field.key
                    keyName = key.name
                    break

                case 'literal':
                    key = field.key
                    keyName = `[${field.key.literal}]`
                    break

                case 'expression':
                    if (!allowLiteralFields) {
                        break
                    }

                    const expr = this.finalizeExpression(
                        field.key.expression,
                        refs,
                    )

                    key = {
                        type: 'expression',
                        expression: expr,
                    }

                    break
            }

            if (!key) {
                continue
            }

            const value = this.finalizeExpression(field.value, refs)
            if (!allowLiteralFields) {
                if (keyName) {
                    literalExpressions.set(keyName, value)
                }

                continue
            }

            const valueTypes = this.finalizeTypes(
                this.context.typeResolver.resolve({ expression: value }),
            )

            if (valueTypes.size === 1 && valueTypes.has('function')) {
                continue
            }

            let types: Set<string> | undefined
            if (keyName) {
                literalKeys.add(keyName)

                const literalKeyName = this.context.getLiteralKey(keyName)
                const defs = info.definitions.get(literalKeyName) ?? []
                if (defs.length > 1) {
                    ;[, types] = this.finalizeDefinitions(defs, refs)
                }

                // don't write type if it can be determined from the literal
                const isNil =
                    value.type === 'literal' && value.luaType === 'nil'
                if (!isNil && types?.size === 1) {
                    types = undefined
                }
            }

            literalFields.push({
                key,
                value,
                types,
            })
        }

        const checkSubfields: [string, string][] = []
        for (let [field, expressions] of info.definitions) {
            const definingExprs = expressions.filter((x) => {
                if (!x.definingModule) {
                    return isClassDefiner
                }

                return x.definingModule === this.context.currentModule
            })

            if (definingExprs.length === 0) {
                if (expressions.length !== 1) {
                    continue
                }

                const expr = expressions[0].expression
                if (expr.type !== 'literal' || !expr.tableId) {
                    continue
                }

                checkSubfields.push([expr.tableId, getLuaFieldKey(field)])

                continue
            }

            const functionExpr = definingExprs.find((x) => {
                return (
                    (cls.generated || !x.functionLevel) &&
                    !x.instance &&
                    x.expression
                )
            })?.expression

            let addedFunction = false
            if (functionExpr?.type === 'literal' && functionExpr.functionId) {
                const id = functionExpr.functionId
                const funcInfo = this.context.getFunctionInfo(id)
                const identExpr = funcInfo.identifierExpression

                let name: string | undefined
                let indexer: string | undefined
                if (identExpr?.type === 'member') {
                    // function X.Y(...)
                    name = identExpr.member
                    indexer = identExpr.indexer
                } else {
                    // X.Y = function(...)
                    name = getLuaFieldKey(field)
                }

                const func = this.finalizeFunction(id, name)
                if (!isTable && func.isConstructor) {
                    const target =
                        indexer === ':' ? constructors : functionConstructors

                    target.push(func)
                } else {
                    const target = indexer === ':' ? methods : functions
                    target.push(func)
                }

                addedFunction = true
            }

            const name = getLuaFieldKey(field)
            const instanceExprs = definingExprs.filter((x) => x.instance)
            if (instanceExprs.length > 0) {
                const instanceTypes = new Set<string>()

                for (const expr of instanceExprs) {
                    this.context.typeResolver
                        .resolve(expr)
                        .forEach((x) => instanceTypes.add(x))
                }

                const types = this.finalizeTypes(instanceTypes)

                // function collision → add only if there are other types
                if (addedFunction) {
                    const checkTypes = new Set(types)
                    checkTypes.delete('function')
                    checkTypes.delete('nil')

                    if (checkTypes.size === 0) {
                        continue
                    }
                }

                fields.push({
                    name,
                    types,
                })

                continue
            }

            const staticExprs = definingExprs.filter((x) => !x.instance)
            if (staticExprs.length > 0) {
                if (addedFunction || literalKeys.has(name)) {
                    continue
                }

                // ignore static children field for Atom UI classes
                if (name === 'children' && info.isAtomUI) {
                    continue
                }

                let [expression, types] = this.finalizeStaticField(
                    staticExprs,
                    refs,
                )

                expression ??= literalExpressions.get(name)

                staticFields.push({
                    name,
                    types,
                    expression,
                })
            }
        }

        // inject base atom UI fields
        if (info.isAtomUIBase) {
            fields.push({
                name: 'javaObj',
                types: new Set(),
            })

            fields.push({
                name: 'children',
                types: new Set([`table<string, ${cls.name}>`, 'nil']),
            })
        }

        // inject atom UI overloads & fields
        if (info.isAtomUI) {
            overloads.push({
                name: 'overload',
                parameters: [
                    {
                        name: 'args',
                        types: new Set(['table']),
                    },
                ],
                returnTypes: [new Set([cls.name])],
            })

            fields.push({
                name: 'super',
                types: new Set([cls.base ?? 'table']),
            })
        }

        if (isTable) {
            const finalized: AnalyzedTable = {
                name: cls.name,
                local: cls.generated || info.isLocalClass,
                staticFields,
                methods,
                functions,
                overloads,
            }

            return [finalized, true, []]
        }

        // check for floating setters
        const seenIds = new Set<string>()
        const extraClasses: ResolvedClassInfo[] = []
        while (checkSubfields.length > 0) {
            const [id, baseName] = checkSubfields.pop()!
            if (seenIds.has(id)) {
                continue
            }

            seenIds.add(id)
            const tableInfo = this.context.getTableInfo(id)

            for (let [field, expressions] of tableInfo.definitions) {
                let name = getLuaFieldKey(field)
                if (baseName) {
                    name = name.startsWith('[')
                        ? `${baseName}${name}`
                        : `${baseName}.${name}`
                }

                const definingExprs = expressions.filter((x) => {
                    return (
                        !x.instance &&
                        x.definingModule === this.context.currentModule
                    )
                })

                if (definingExprs.length > 0) {
                    // don't add setter fields for nested classes, signal to include the right class
                    if (tableInfo.className) {
                        extraClasses.push({
                            name: tableInfo.className,
                            tableId: tableInfo.id,
                            definingModule: tableInfo.definingModule,
                            generated: tableInfo.isLocalClass,
                        })

                        continue
                    }

                    const [expression, types] = this.finalizeStaticField(
                        definingExprs,
                        refs,
                    )

                    setterFields.push({
                        name,
                        types,
                        expression,
                    })

                    continue
                }

                if (expressions.length !== 1) {
                    continue
                }

                const expr = expressions[0].expression
                if (expr.type !== 'literal' || !expr.tableId) {
                    continue
                }

                checkSubfields.push([expr.tableId, name])
                continue
            }
        }

        const finalized: AnalyzedClass = {
            name: cls.name,
            extends: cls.base,
            deriveName: cls.deriveName,
            local: cls.generated || info.isLocalClass,
            fields,
            literalFields,
            staticFields,
            setterFields,
            functions,
            methods,
            constructors,
            functionConstructors,
            overloads,
        }

        return [finalized, false, extraClasses]
    }

    /**
     * Removes class fields with an identical type in an ancestor class.
     * @param clsDefs List of class definitions.
     * @param clsMap Map of class names to matching class definitions.
     */
    protected finalizeClassFields(
        clsDefs: AnalyzedClass[],
        clsMap: Map<string, AnalyzedClass[]>,
    ) {
        // remove fields with identical type in ancestor
        for (const cls of clsDefs) {
            if (!cls.extends) {
                continue
            }

            const seen = new Set<string>()
            const toRemove = new Set<string>()
            for (const field of cls.fields) {
                if (seen.has(field.name)) {
                    continue
                }

                seen.add(field.name)

                const ancestor = this.findMatchingAncestorField(
                    field,
                    cls.extends,
                    clsMap,
                )

                if (ancestor) {
                    toRemove.add(field.name)
                }
            }

            if (toRemove.size === 0) {
                continue
            }

            cls.fields = cls.fields.filter((x) => !toRemove.has(x.name))
        }
    }

    /**
     * Finalizes assignment definitions.
     * @returns The expression and/or types to use in annotations.
     */
    protected finalizeDefinitions(
        defs: LuaExpressionInfo[],
        refs: Map<string, LuaExpression | null>,
        seen?: Map<string, LuaExpression | null>,
    ): [expression: LuaExpression | undefined, types: Set<string> | undefined] {
        let value: LuaExpression | undefined

        let includeTypes = true
        const firstExpr = defs[0]
        if (
            defs.length === 1 &&
            !firstExpr.functionLevel &&
            !this.isLiteralClassTable(firstExpr.expression)
        ) {
            // one def → rewrite unless it's a class reference or defined in a function
            value = this.finalizeExpression(firstExpr.expression, refs, seen)
            includeTypes = value.type === 'literal' && value.luaType === 'nil'
        } else {
            // defined in literal → rewrite, but include types
            const literalDef = defs.find((x) => x.fromLiteral)

            if (literalDef) {
                value = this.finalizeExpression(
                    literalDef.expression,
                    refs,
                    seen,
                )
            }
        }

        includeTypes ||= value?.type === 'reference' && !!refs.get(value.id)

        let types: Set<string> | undefined
        if (includeTypes) {
            // no defs, multiple defs, or failed reference resolution → resolve types
            types = new Set()
            for (const def of defs) {
                this.context.typeResolver
                    .resolve(def)
                    .forEach((x) => types!.add(x))
            }

            // no defs at module level → assume optional
            if (!defs.find((x) => !x.functionLevel)) {
                types.add('nil')
            }

            types = this.finalizeTypes(types)
        }

        return [value, types]
    }

    /**
     * Finalizes an expression for rewriting.
     * @param refs Map of local IDs to expressions that represent them.
     */
    protected finalizeExpression(
        expression: LuaExpression,
        refs: Map<string, LuaExpression | null>,
        seen?: Map<string, LuaExpression | null>,
    ): LuaExpression {
        seen ??= new Map()

        let base: LuaExpression
        switch (expression.type) {
            case 'reference':
                const id = expression.id

                const replaceExpr = refs.get(id)
                if (replaceExpr === undefined) {
                    // remove internal ID information
                    const start = id.indexOf('[')
                    return {
                        type: 'reference',
                        id:
                            start !== -1
                                ? id.slice(start + 1, -1)
                                : id.startsWith('@self')
                                  ? 'self'
                                  : id,
                    }
                }

                // null → multiple defs; write `nil`
                if (!replaceExpr) {
                    return {
                        type: 'literal',
                        luaType: 'nil',
                        literal: 'nil',
                    }
                }

                // failed to resolve → emit the value of the local
                return this.finalizeExpression(replaceExpr, refs, seen)

            case 'literal':
                const tableId = expression.tableId
                if (tableId) {
                    const tableLiteral = this.finalizeTable(tableId, refs, seen)
                    if (tableLiteral) {
                        return tableLiteral
                    }
                }

                const funcId = expression.functionId
                if (funcId) {
                    const info = this.finalizeFunction(funcId, '@field')
                    return {
                        type: 'literal',
                        luaType: 'function',
                        isMethod: info.isMethod,
                        parameters: info.parameters,
                        returnTypes: info.returnTypes,
                    }
                }

                return { ...expression }

            case 'operation':
                return {
                    type: 'operation',
                    operator: expression.operator,
                    arguments: expression.arguments.map((x) =>
                        this.finalizeExpression(x, refs, seen),
                    ),
                }

            case 'member':
                base = this.finalizeExpression(expression.base, refs, seen)

                if (base.type !== 'literal' || !base.fields) {
                    return { ...expression, base }
                }

                const memberKey = getLuaFieldKey(expression.member)
                for (const field of base.fields) {
                    let keyName: string | undefined
                    switch (field.key.type) {
                        case 'string':
                            keyName = field.key.name
                            break

                        case 'literal':
                            keyName = field.key.name ?? `[${field.key.literal}]`
                            break

                        case 'auto':
                            keyName = `[${field.key.index}]`
                            break
                    }

                    if (!keyName) {
                        continue
                    }

                    if (keyName === memberKey) {
                        return this.finalizeExpression(field.value, refs, seen)
                    }
                }

                return { ...expression, base }

            case 'index':
                return {
                    type: 'index',
                    base: this.finalizeExpression(expression.base, refs),
                    index: this.finalizeExpression(expression.index, refs),
                }

            default:
                return expression
        }
    }

    /**
     * Finalizes information about a function.
     * @param id The function identifier.
     * @param name The name of the function.
     */
    protected finalizeFunction(id: string, name: string): AnalyzedFunction {
        const info = this.context.getFunctionInfo(id)
        const expr = info.identifierExpression
        const isMethod = expr?.type === 'member' && expr.indexer === ':'

        const parameters: AnalyzedParameter[] = []
        for (let i = 0; i < info.parameters.length; i++) {
            if (isMethod && i === 0) {
                continue
            }

            const name = info.parameterNames[i]
            const paramTypes = info.parameterTypes[i] ?? new Set()
            const types = this.finalizeTypes(paramTypes)

            parameters.push({
                name,
                types,
            })
        }

        const returns: Set<string>[] = info.isConstructor
            ? info.returnTypes.map((x) => this.finalizeTypes(x))
            : []

        if (!info.isConstructor) {
            for (let i = 0; i < info.returnTypes.length; i++) {
                const expressions = info.returnExpressions[i] ?? []

                const types = new Set<string>()
                for (const expr of expressions) {
                    this.context.typeResolver
                        .resolve({ expression: expr })
                        .forEach((x) => types.add(x))
                }

                info.returnTypes[i].forEach((x) => types.add(x))
                returns.push(this.finalizeTypes(types))
            }
        }

        return {
            name,
            parameters,
            returnTypes: returns,
            isMethod,
            isConstructor: info.isConstructor || name === 'new',
        }
    }

    /**
     * Finalizes information about a require call.
     */
    protected finalizeRequire(req: ResolvedRequireInfo): AnalyzedField {
        return {
            name: req.name,
            types: new Set(),
            expression: {
                type: 'operation',
                operator: 'call',
                arguments: [
                    {
                        type: 'reference',
                        id: 'require',
                    },
                    {
                        type: 'literal',
                        luaType: 'string',
                        literal: `"${req.module.replaceAll('"', '\\"')}"`,
                    },
                ],
            },
        }
    }

    /**
     * Finalizes module-level returns.
     * @param ret Information about returns.
     * @param refs Map of local identifiers to expressions.
     */
    protected finalizeReturn(
        ret: ResolvedReturnInfo,
        refs: Map<string, LuaExpression | null>,
    ): AnalyzedReturn {
        let expression: LuaExpression | undefined
        const types = new Set<string>()

        if (ret.expressions.size === 1) {
            // one expression → include for rewrite
            expression = [...ret.expressions][0]
        } else if (ret.expressions.size === 0) {
            // no expressions → use computed types
            ret.types.forEach((x) => types.add(x))
        }

        // use value directly if possible
        if (expression) {
            expression = this.finalizeExpression(expression, refs)
        }

        for (const expr of ret.expressions) {
            this.context.typeResolver
                .resolve({ expression: expr })
                .forEach((x) => types.add(x))
        }

        return {
            types: this.finalizeTypes(types),
            expression,
        }
    }

    /**
     * Finalizes information about a class static field.
     * @param expressions Assignment expressions.
     * @param refs Map of local identifiers to expressions.
     */
    protected finalizeStaticField(
        expressions: LuaExpressionInfo[],
        refs: Map<string, LuaExpression | null>,
    ): [expression: LuaExpression | undefined, types: Set<string>] {
        const staticTypes = new Set<string>()
        for (const expr of expressions) {
            this.context.typeResolver
                .resolve(expr)
                .forEach((x) => staticTypes.add(x))
        }

        const moduleLevelDef = expressions.find((x) => !x.functionLevel)
        if (!moduleLevelDef) {
            // no module-level def → assume optional
            staticTypes.add('nil')
        }

        let expression: LuaExpression | undefined
        const types = this.finalizeTypes(staticTypes)

        // only rewrite module-level definitions
        if (moduleLevelDef) {
            if (expressions.length === 1) {
                expression = moduleLevelDef.expression
            } else if (types.size === 1) {
                switch ([...types][0]) {
                    case 'nil':
                    case 'boolean':
                    case 'string':
                    case 'number':
                        expression = moduleLevelDef.expression
                        break
                }
            }

            if (expression && this.isLiteralClassTable(expression)) {
                expression = undefined
            }

            if (expression) {
                expression = this.finalizeExpression(expression, refs)
            }
        }

        return [expression, types]
    }

    /**
     * Finalizes a global table definition for rewriting.
     * @param id The table identifier.
     * @param refs Map of local identifiers to expressions.
     * @param seen Map of already checked table IDs to expressions.
     */
    protected finalizeTable(
        id: string,
        refs: Map<string, LuaExpression | null>,
        seen?: Map<string, LuaExpression | null>,
    ): LuaExpression | undefined {
        seen ??= new Map()
        if (seen.has(id)) {
            return seen.get(id) ?? undefined
        }

        seen.set(id, null)
        const info = this.context.getTableInfo(id)

        const fields: TableField[] = []

        let nextAutoKey = 1
        for (let [defKey, defs] of info.definitions) {
            const filtered = defs.filter(
                (x) => x.definingModule === this.context.currentModule,
            )

            if (filtered.length === 0) {
                continue
            }

            const fieldKey = getLuaFieldKey(defKey)
            const [value, types] = this.finalizeDefinitions(defs, refs, seen)

            let key: TableKey
            if (fieldKey.startsWith('[')) {
                const innerKey = fieldKey.slice(1, -1)
                const numKey = Number.parseInt(innerKey)

                if (numKey === nextAutoKey) {
                    nextAutoKey++
                    key = {
                        type: 'auto',
                        index: numKey,
                    }
                } else {
                    let luaType: LuaType
                    if (!isNaN(numKey)) {
                        luaType = 'number'
                    } else if (innerKey === 'true' || innerKey === 'false') {
                        luaType = 'boolean'
                    } else if (innerKey.startsWith('"')) {
                        luaType = 'string'
                    } else {
                        luaType = 'nil'
                    }

                    key = {
                        type: 'literal',
                        luaType,
                        literal: innerKey,
                    }
                }
            } else {
                key = {
                    type: 'string',
                    name: fieldKey,
                }
            }

            const field: TableField = {
                key,
                value: value ?? {
                    type: 'literal',
                    luaType: 'nil',
                    literal: 'nil',
                },
            }

            if (types !== undefined) {
                field.types = types
            }

            fields.push(field)
        }

        const expression: LuaExpression = {
            type: 'literal',
            luaType: 'table',
            fields: fields,
        }

        seen.set(id, expression)

        return expression
    }

    /**
     * Finalizes Lua types for annotation.
     * This removes internal IDs and deals with narrowing failures.
     */
    protected finalizeTypes(types: Set<string>): Set<string> {
        // treat explicit unknowns as just unknown
        if (types.has('unknown')) {
            const noTypes = new Set<string>()
            if (types.has('nil')) {
                noTypes.add('nil')
            }

            return noTypes
        }

        const finalizedTypes = new Set(
            [...types]
                .map((type) => {
                    if (type === 'true' || type === 'false') {
                        return 'boolean'
                    }

                    if (type.startsWith('@table')) {
                        const tableInfo = this.context.getTableInfo(type)
                        if (tableInfo.emitAsTable) {
                            return 'table'
                        }

                        return tableInfo.className ?? 'table'
                    }

                    if (type.startsWith('@function')) {
                        return 'function'
                    }

                    // discard IDs
                    if (type.startsWith('@')) {
                        return
                    }

                    return type
                })
                .filter((x) => x !== undefined),
        )

        const classTypes = new Set<string>()
        for (const type of finalizedTypes) {
            switch (type) {
                case 'nil':
                case 'boolean':
                case 'string':
                case 'number':
                case 'table':
                case 'function':
                    break

                default:
                    classTypes.add(type)
            }
        }

        if (classTypes.size > 2) {
            // >2 classes → likely narrowing failure
            // remove and mark as table instead

            classTypes.forEach((x) => finalizedTypes.delete(x))
            finalizedTypes.add('table')
        }

        return finalizedTypes
    }

    /**
     * Finds a matching field in a class ancestor to determine whether
     * it can be removed from a class.
     */
    protected findMatchingAncestorField(
        field: AnalyzedField,
        baseCls: string,
        clsMap: Map<string, AnalyzedClass[]>,
    ): AnalyzedField | undefined {
        const types = field.types

        let ancestorDefs = clsMap.get(baseCls)
        while (ancestorDefs !== undefined) {
            let base: string | undefined
            for (const def of ancestorDefs) {
                base ??= def.extends
                for (const checkField of def.fields) {
                    if (checkField.name !== field.name) {
                        continue
                    }

                    const checkTypes = checkField.types
                    let equal = checkTypes.size === types.size
                    if (!equal) {
                        continue
                    }

                    for (const type of types) {
                        if (!checkTypes.has(type)) {
                            equal = false
                            break
                        }
                    }

                    if (!equal) {
                        continue
                    }

                    return checkField
                }
            }

            if (base) {
                ancestorDefs = clsMap.get(base)
            } else {
                break
            }
        }
    }

    /**
     * Gets a set of locals that are referenced by analyzed members.
     */
    protected getReferences(mod: ResolvedModule): Set<string> {
        const stack: [LuaExpression, number][] = []
        for (const cls of mod.classes) {
            const info = this.context.getTableInfo(cls.tableId)
            for (const def of info.definitions.values()) {
                stack.push(
                    ...def
                        .filter((x) => !x.functionLevel)
                        .map((x): [LuaExpression, number] => [x.expression, 0]),
                )
            }

            for (const field of info.literalFields) {
                if (field.key.type === 'expression') {
                    stack.push([field.key.expression, 0])
                }
            }
        }

        for (const ret of mod.returns) {
            if (ret.expressions.size === 1) {
                // expression will only be included directly if there's only one
                stack.push([[...ret.expressions][0], 0])
            }
        }

        const refCount = new Map<string, number>()
        const seen = new Set<LuaExpression>()
        while (stack.length > 0) {
            const [expression, defaultRefs] = stack.pop()!

            if (seen.has(expression)) {
                continue
            }

            seen.add(expression)

            switch (expression.type) {
                case 'reference':
                    const id = expression.id
                    if (!mod.scope.localIdToName(id)) {
                        break
                    }

                    const count = refCount.get(id) ?? defaultRefs
                    refCount.set(id, count + 1)

                    const resolvedTypes = this.context.typeResolver.resolve({
                        expression,
                    })

                    for (const resolved of resolvedTypes) {
                        if (!resolved.startsWith('@table')) {
                            continue
                        }

                        stack.push([
                            {
                                type: 'literal',
                                luaType: 'table',
                                tableId: resolved,
                            },
                            defaultRefs,
                        ])
                    }

                    break

                case 'index':
                    // indexed → count as multiple refs
                    stack.push([expression.base, 1])
                    stack.push([expression.index, defaultRefs])
                    break

                case 'member':
                    // indexed → count as multiple refs
                    stack.push([expression.base, 1])
                    break

                case 'operation':
                    for (let i = 0; i < expression.arguments.length; i++) {
                        // count call base as multiple refs
                        const newDefault =
                            expression.operator === 'call' && i === 0
                                ? 1
                                : defaultRefs

                        stack.push([expression.arguments[i], newDefault])
                    }

                    break

                case 'literal':
                    const tableId = expression.tableId
                    if (!tableId) {
                        break
                    }

                    const info = this.context.getTableInfo(tableId)
                    for (const expressions of info.definitions.values()) {
                        const moduleExprs = expressions.filter(
                            (x) => !x.functionLevel,
                        )

                        // if there are multiple module-level defs, count as multiple refs
                        const count = moduleExprs.length === 1 ? defaultRefs : 1

                        moduleExprs.forEach((x) =>
                            stack.push([x.expression, count]),
                        )
                    }

                    break
            }
        }

        return new Set([...refCount.entries()].map((x) => x[0]))
    }

    /**
     * Checks whether an expression is a literal table that is associated with a class definition.
     */
    protected isLiteralClassTable(expr: LuaExpression) {
        if (expr.type !== 'literal' || expr.luaType !== 'table') {
            return
        }

        const id = expr.tableId
        if (!id) {
            return
        }

        const info = this.context.getTableInfo(id)
        return info.className !== undefined
    }
}
