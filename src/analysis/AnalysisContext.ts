import ast from 'luaparse'
import { LuaScope } from '../scopes'
import { getLuaFieldKey, readLuaStringLiteral } from '../helpers'
import {
    AssignmentItem,
    FunctionDefinitionItem,
    LuaExpression,
    LuaExpressionInfo,
    LuaLiteral,
    LuaOperation,
    LuaType,
    RequireAssignmentItem,
    ResolvedClassInfo,
    ResolvedFunctionInfo,
    ResolvedScopeItem,
    ResolvedReturnInfo,
    TableField,
    UsageItem,
    FunctionInfo,
    TableInfo,
    LuaReference,
    AnalyzedParameter,
    AnalyzedFunction,
    AnalyzedModule,
    AnalyzedClass,
    AnalyzedField,
    AnalyzedReturn,
    ResolvedModule,
    TableKey,
    ResolvedRequireInfo,
    LuaMember,
    AnalyzedTable,
    AnalysisContextArgs,
} from './types'

const RGBA_NAMES = new Set(['r', 'g', 'b', 'a'])
const POS_SIZE_NAMES = new Set(['x', 'y', 'z', 'w', 'h', 'width', 'height'])

/**
 * Shared context for analysis of multiple Lua files.
 */
export class AnalysisContext {
    protected nextTableIndex: number = 1
    protected nextFunctionIndex: number = 1

    protected aliasMap: Map<string, Set<string>>

    protected currentModule: string
    protected isRosettaInit: boolean
    protected applyHeuristics: boolean

    /**
     * Definitions for items.
     */
    protected definitions: Map<string, LuaExpressionInfo[]>

    /**
     * Expression types inferred by usage.
     */
    protected usageTypes: Map<LuaExpression, Set<string>>

    /**
     * Maps function IDs to info about the function they describe.
     */
    protected idToFunctionInfo: Map<string, FunctionInfo>

    /**
     * Maps table IDs to info about the table they describe.
     */
    protected idToTableInfo: Map<string, TableInfo>

    /**
     * Maps function declarations to function IDs.
     */
    protected functionToID: Map<ast.FunctionDeclaration, string>

    /**
     * Maps table constructor expressions to table IDs.
     */
    protected tableToID: Map<ast.TableConstructorExpression, string>

    /**
     * Maps parameter IDs to function IDs.
     */
    protected parameterToFunctionId: Map<string, string>

    /**
     * Maps file identifiers to resolved modules.
     */
    protected modules: Map<string, ResolvedModule>

    constructor(args: AnalysisContextArgs) {
        this.currentModule = ''
        this.aliasMap = new Map()
        this.tableToID = new Map()
        this.functionToID = new Map()
        this.idToTableInfo = new Map()
        this.idToFunctionInfo = new Map()
        this.parameterToFunctionId = new Map()
        this.definitions = new Map()
        this.usageTypes = new Map()
        this.modules = new Map()

        this.isRosettaInit = args.isRosettaInit ?? false
        this.applyHeuristics = args.heuristics ?? false
    }

    /**
     * Adds an assignment to the list of definitions or fields.
     */
    addAssignment(
        scope: LuaScope,
        item: AssignmentItem | FunctionDefinitionItem | RequireAssignmentItem,
    ) {
        scope.addItem(item)
        const lhs =
            item.type === 'functionDefinition' ? item.expression : item.lhs

        // anonymous functions have no assignment
        if (!lhs) {
            return
        }

        let rhs: LuaExpression
        switch (item.type) {
            case 'assignment':
            case 'requireAssignment':
                rhs = item.rhs
                break

            case 'functionDefinition':
                rhs = item.literal
                break
        }

        const index = item.type === 'assignment' ? item.index : undefined
        switch (lhs.type) {
            case 'reference':
                const tableId = this.tryAddPartialItem(scope, item, lhs, rhs)

                if (tableId) {
                    rhs = {
                        type: 'literal',
                        luaType: 'table',
                        tableId,
                    }
                }

                this.addDefinition(scope, lhs.id, rhs, index)
                break

            case 'index':
                const indexBase = [
                    ...this.resolveTypes({ expression: lhs.base }),
                ]

                if (indexBase.length !== 1) {
                    break
                }

                const resolved = this.resolveBasicLiteral(lhs.index)
                if (!resolved || !resolved.literal) {
                    break
                }

                const key = this.getLiteralKey(
                    resolved.literal,
                    resolved.luaType,
                )

                this.addField(scope, indexBase[0], key, rhs, lhs, index)
                break

            case 'member':
                let isInstance = false
                const memberBase = [
                    ...this.resolveTypes({ expression: lhs.base }),
                ].filter((x) => {
                    if (!x.startsWith('@self') && !x.startsWith('@instance')) {
                        return true
                    }

                    isInstance = true
                    return false
                })

                if (memberBase.length === 1) {
                    // ignore __index in instances
                    if (isInstance && lhs.member === '__index') {
                        break
                    }

                    const key = this.getLiteralKey(lhs.member)
                    this.addField(
                        scope,
                        memberBase[0],
                        key,
                        rhs,
                        lhs,
                        index,
                        isInstance,
                    )
                }

                break

            // operation or literal should not occur directly in lhs
        }
    }

    finalizeModules(): Map<string, AnalyzedModule> {
        const modules = new Map<string, AnalyzedModule>()

        const clsMap = new Map<string, AnalyzedClass[]>()
        for (const [id, mod] of this.modules) {
            this.currentModule = id
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
                    const defs = this.definitions.get(id) ?? []
                    ;[expression] = this.finalizeDefinitions(defs, refMap)
                }

                refMap.set(id, expression ?? null)
            }

            const classes: AnalyzedClass[] = []
            const tables: AnalyzedTable[] = []
            for (const cls of mod.classes) {
                const [finalized, isTable] = this.finalizeClass(cls, refMap)

                if (isTable) {
                    tables.push(finalized)
                } else {
                    classes.push(finalized as AnalyzedClass)

                    let list = clsMap.get(finalized.name)
                    if (!list) {
                        list = []
                        clsMap.set(finalized.name, list)
                    }

                    list.push(finalized as AnalyzedClass)
                }
            }

            const fields: AnalyzedField[] = []
            for (const req of mod.requires) {
                fields.push(this.finalizeRequire(req))
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

        this.currentModule = ''
        return modules
    }

    /**
     * Gets the ID to use for a function.
     */
    getFunctionID(expr: ast.FunctionDeclaration, name?: string): string {
        let id = this.functionToID.get(expr)
        if (!id) {
            const count = this.nextFunctionIndex++
            id = `@function(${count})` + (name ? `[${name}]` : '')

            this.functionToID.set(expr, id)
        }

        return id
    }

    /**
     * Gets the ID to use for a table.
     */
    getTableID(expr: ast.TableConstructorExpression, name?: string): string {
        let id = this.tableToID.get(expr)
        if (!id) {
            id = this.newTableID(name)
            this.tableToID.set(expr, id)
        }

        return id
    }

    /**
     * Resolves the types of the analysis items for a module.
     */
    resolveItems(scope: LuaScope): ResolvedScopeItem {
        // collect usage information
        for (const item of scope.items) {
            if (item.type !== 'usage') {
                continue
            }

            this.addUsage(item, scope)
        }

        // resolve classes, functions, and returns
        const classes: ResolvedClassInfo[] = []
        const functions: ResolvedFunctionInfo[] = []
        const requires: ResolvedRequireInfo[] = []
        const seenClasses = new Set<string>()

        for (const item of scope.items) {
            switch (item.type) {
                case 'partial':
                    if (item.classInfo) {
                        const info = this.getTableInfo(item.classInfo.tableId)
                        if (!info.isEmptyClass) {
                            classes.push(item.classInfo)
                        }
                    }

                    if (item.functionInfo) {
                        functions.push(item.functionInfo)
                    }

                    if (item.requireInfo) {
                        requires.push(item.requireInfo)
                    }

                    if (item.seenClassId) {
                        seenClasses.add(item.seenClassId)
                    }

                    break

                case 'resolved':
                    item.functions.forEach((x) => functions.push(x))
                    item.classes.forEach((x) => classes.push(x))
                    item.requires.forEach((x) => requires.push(x))
                case 'returns':
                    const funcInfo = this.getFunctionInfo(item.id)

                    funcInfo.minReturns = Math.min(
                        funcInfo.minReturns ?? Number.MAX_VALUE,
                        item.returns.length,
                    )

                    // don't add returns to a class constructor
                    if (funcInfo.isConstructor) {
                        break
                    }

                    for (let i = 0; i < item.returns.length; i++) {
                        funcInfo.returnTypes[i] ??= new Set()
                        funcInfo.returnExpressions[i] ??= new Set()

                        let types: Set<string>
                        if (item.type === 'returns') {
                            const ret = item.returns[i]

                            funcInfo.returnExpressions[i].add(ret)
                            types = this.remapBooleans(
                                this.resolveTypes({ expression: ret }),
                            )
                        } else {
                            types = item.returns[i].types
                        }

                        types.forEach((x) => funcInfo.returnTypes[i].add(x))
                    }

                    const min = funcInfo.minReturns
                    if (min === undefined) {
                        continue
                    }

                    if (funcInfo.returnTypes.length <= min) {
                        continue
                    }

                    // mark returns exceeding the minimum as nullable
                    for (let i = min; i < funcInfo.returnTypes.length; i++) {
                        funcInfo.returnTypes[i].add('nil')
                    }

                    break
            }
        }

        const funcInfo = this.getFunctionInfo(scope.id)
        const returns = funcInfo.returnTypes.map(
            (returnTypes, i): ResolvedReturnInfo => {
                return {
                    types: new Set(returnTypes),
                    expressions: funcInfo.returnExpressions[i] ?? new Set(),
                }
            },
        )

        if (scope.type === 'module') {
            const declaredClasses = new Set<string>()
            classes.forEach((x) => declaredClasses.add(x.tableId))

            for (const id of seenClasses) {
                if (declaredClasses.has(id)) {
                    continue
                }

                const info = this.getTableInfo(id)
                if (!info.className || info.isEmptyClass) {
                    continue
                }

                classes.push({
                    name: info.className,
                    tableId: info.id,
                })
            }
        }

        return {
            type: 'resolved',
            id: scope.id,
            classes,
            functions,
            returns,
            requires,
            seenClasses,
        }
    }

    setAliasMap(map: Map<string, Set<string>>) {
        this.aliasMap = map
    }

    setReadingModule(name?: string) {
        this.currentModule = name ?? ''
    }

    /**
     * Sets up basic info for a function.
     */
    setFunctionInfo(
        functionId: string,
        scope: LuaScope,
        node: ast.FunctionDeclaration,
        identExpr: LuaExpression | undefined,
    ): string[] {
        const info = this.getFunctionInfo(functionId)
        info.parameters = []
        info.parameterTypes = []
        info.returnTypes = []
        info.identifierExpression = identExpr

        if (identExpr?.type === 'member') {
            if (identExpr.indexer === ':') {
                const selfId =
                    scope.getLocalId('self') ?? scope.addSelfParameter()

                info.parameters.push(selfId)
            }

            const addedClosureClass = this.checkClosureClass(
                scope,
                node,
                info,
                identExpr,
            )

            if (!addedClosureClass && identExpr.indexer === ':') {
                this.checkClassMethod(scope, info, identExpr)
            }
        }

        for (const param of node.parameters) {
            const paramId = scope.getLocalId(
                param.type === 'Identifier' ? param.name : '...',
            )

            if (paramId) {
                info.parameters.push(paramId)
            }
        }

        info.parameterNames = info.parameters.map(
            (x) => scope.localIdToName(x) ?? x,
        )

        if (this.applyHeuristics) {
            // at least 2 of {x, y, z, w, h, width, height} → assume number
            const posSizeCount = info.parameterNames.reduce<number>(
                (x, name) => (POS_SIZE_NAMES.has(name) ? ++x : x),
                0,
            )

            // at least 3 of {r, g, b, a} → assume number
            const rgbaCount = info.parameterNames.reduce<number>(
                (x, name) => (RGBA_NAMES.has(name) ? ++x : x),
                0,
            )

            for (let i = 0; i < info.parameters.length; i++) {
                const name = info.parameterNames[i]
                const assumeNum =
                    (posSizeCount >= 2 && POS_SIZE_NAMES.has(name)) ||
                    (rgbaCount >= 3 && RGBA_NAMES.has(name))

                if (assumeNum) {
                    info.parameterTypes[i] ??= new Set()
                    info.parameterTypes[i].add('number')
                    continue
                }

                const third = name.slice(2, 3)
                if (name.startsWith('is') && third.toUpperCase() === third) {
                    info.parameterTypes[i] ??= new Set()
                    info.parameterTypes[i].add('boolean')
                    continue
                }

                const upper = name.toUpperCase()
                if (upper.startsWith('DO')) {
                    continue
                }

                if (upper.startsWith('NUM') || upper.endsWith('NUM')) {
                    // starts or ends with num → assume number
                    info.parameterTypes[i] ??= new Set()
                    info.parameterTypes[i].add('number')
                    continue
                }

                if (
                    upper.endsWith('STR') ||
                    upper.endsWith('NAME') ||
                    upper.endsWith('TITLE')
                ) {
                    // ends with name, title, or str → assume string
                    info.parameterTypes[i] ??= new Set()
                    info.parameterTypes[i].add('string')
                }
            }
        }

        for (const param of info.parameters) {
            this.parameterToFunctionId.set(param, functionId)
        }

        return info.parameters
    }

    /**
     * Modifies types based on a setmetatable call.
     */
    setMetatable(scope: LuaScope, lhs: LuaExpression, meta: LuaExpression) {
        if (lhs.type !== 'reference') {
            return
        }

        const name = scope.localIdToName(lhs.id)
        if (!name) {
            return
        }

        if (meta.type === 'literal') {
            const fields = meta.fields

            // { X = Y }
            if (fields?.length !== 1) {
                return
            }

            // { __index = X }
            const field = fields[0]
            if (field.key.type !== 'string' || field.key.name !== '__index') {
                return
            }

            meta = field.value
        }

        // get metatable type
        const metaTypes = [...this.resolveTypes({ expression: meta })].filter(
            (x) => !x.startsWith('@self'),
        )

        const resolvedMeta = metaTypes[0]
        if (metaTypes.length !== 1 || !resolvedMeta.startsWith('@table')) {
            return
        }

        // check that metatable is a class
        const metaInfo = this.getTableInfo(resolvedMeta)
        if (!metaInfo.className && !metaInfo.fromHiddenClass) {
            return
        }

        // get lhs types
        const lhsTypes = [...this.resolveTypes({ expression: lhs })].filter(
            (x) => x !== '@instance',
        )

        if (lhsTypes.find((x) => !x.startsWith('@table'))) {
            // non-table lhs → don't treat as instance
            return
        }

        for (const resolvedLhs of lhsTypes) {
            const lhsInfo = this.getTableInfo(resolvedLhs)
            // don't copy class fields
            if (lhsInfo.className) {
                continue
            }

            // copy table fields to class instance fields
            lhsInfo.definitions.forEach((list, key) => {
                let fieldDefs = metaInfo.definitions.get(key)
                if (!fieldDefs) {
                    fieldDefs = []
                    metaInfo.definitions.set(key, fieldDefs)
                }

                for (const info of list) {
                    fieldDefs.push({
                        expression: info.expression,
                        index: info.index,
                        instance: true,
                        definingModule: this.currentModule,
                        functionLevel: !scope.id.startsWith('@module'),
                    })
                }
            })
        }

        // mark lhs as class instance
        const newId = scope.addInstance(name)
        this.definitions.set(newId, [
            {
                expression: {
                    type: 'literal',
                    luaType: 'table',
                    tableId: resolvedMeta,
                },
            },
        ])
    }

    /**
     * Sets resolved information about a module.
     */
    setModule(id: string, scope: LuaScope, resolved: ResolvedScopeItem) {
        const mod = resolved as ResolvedModule
        mod.scope = scope

        this.modules.set(id, mod)
    }

    /**
     * Sets the fields used to define a table.
     */
    setTableLiteralFields(
        scope: LuaScope,
        tableId: string,
        fields: TableField[],
    ) {
        const info = this.getTableInfo(tableId)
        info.literalFields = fields

        for (const field of fields) {
            const key = field.key

            let literalKey: string | undefined
            switch (key.type) {
                case 'string':
                    literalKey = this.getLiteralKey(key.name)
                    break

                case 'literal':
                    literalKey = this.getLiteralKey(key.literal, key.luaType)
                    break

                case 'auto':
                    literalKey = key.index.toString()
                    break

                // can't resolve expressions
            }

            if (!literalKey) {
                continue
            }

            this.addField(
                scope,
                tableId,
                literalKey,
                field.value,
                undefined,
                1,
                false,
                true,
            )
        }
    }

    protected addAtomUIClass(
        scope: LuaScope,
        name: string,
        literalInfo: TableInfo,
        base?: string,
    ): TableInfo {
        const tableId = this.newTableID()
        const info = this.getTableInfo(tableId)
        info.className = name
        info.isAtomUI = true

        for (const [field, defs] of literalInfo.definitions) {
            info.definitions.set(field, defs)

            if (defs.length !== 1) {
                continue
            }

            // functions with self → methods
            const def = defs[0]
            const expr = def.expression
            if (expr.type !== 'literal' || !expr.functionId) {
                continue
            }

            const funcInfo = this.getFunctionInfo(expr.functionId)
            if (funcInfo.parameterNames[0] !== 'self') {
                continue
            }

            funcInfo.identifierExpression = {
                type: 'member',
                base: { type: 'reference', id: '@generated' },
                member: getLuaFieldKey(field),
                indexer: ':',
            }
        }

        scope.items.push({
            type: 'partial',
            classInfo: {
                name,
                tableId,
                base,
                generated: true,
                definingModule: this.currentModule,
            },
        })

        return info
    }

    protected addDefinition(
        scope: LuaScope,
        id: string,
        expression: LuaExpression,
        index?: number,
    ) {
        let defs = this.definitions.get(id)
        if (!defs) {
            defs = []
            this.definitions.set(id, defs)
        }

        defs.push({
            expression,
            index,
            definingModule: this.currentModule,
            functionLevel: !scope.id.startsWith('@module'),
        })
    }

    protected addField(
        scope: LuaScope,
        id: string,
        field: string,
        rhs: LuaExpression,
        lhs?: LuaExpression,
        index?: number,
        instance?: boolean,
        fromLiteral?: boolean,
    ) {
        if (!id.startsWith('@table')) {
            return
        }

        const info = this.getTableInfo(id)

        // treat closure-based classes' non-function fields as instance fields
        if (info.isClosureClass) {
            instance = rhs.type !== 'literal' || rhs.luaType !== 'function'
        }

        // check for `:derive` calls in field setters
        if (lhs && rhs.type === 'operation') {
            rhs = this.checkFieldCallAssign(scope, lhs, rhs)
        }

        const types = this.resolveTypes({ expression: rhs })
        const tableId = types.size === 1 ? [...types][0] : undefined
        const fieldInfo = tableId?.startsWith('@table')
            ? this.getTableInfo(tableId)
            : undefined

        if (info.className) {
            // include non-declared classes with fields set
            scope.items.push({
                type: 'partial',
                seenClassId: id,
            })

            // mark the table as contained by the class
            if (fieldInfo) {
                fieldInfo.containerId ??= id
            }
        } else if (fieldInfo?.containerId) {
            scope.items.push({
                type: 'partial',
                seenClassId: fieldInfo.containerId,
            })
        } else if (info.containerId) {
            if (fieldInfo) {
                // bubble up container IDs
                fieldInfo.containerId = info.containerId
            }

            scope.items.push({
                type: 'partial',
                seenClassId: info.containerId,
            })
        }

        if (lhs?.type === 'member' || lhs?.type === 'index') {
            this.addSeenClasses(scope, lhs.base)
        }

        let fieldDefs = info.definitions.get(field)
        if (!fieldDefs) {
            fieldDefs = []
            info.definitions.set(field, fieldDefs)
        }

        fieldDefs.push({
            expression: rhs,
            index,
            instance,
            fromLiteral,
            definingModule: this.currentModule,
            functionLevel: !scope.id.startsWith('@module'),
        })
    }

    protected addSeenClasses(scope: LuaScope, expression: LuaExpression) {
        switch (expression.type) {
            case 'literal':
            case 'operation':
            case 'require':
                return

            case 'index':
            case 'member':
                this.addSeenClasses(scope, expression.base)
                return
        }

        const types = this.resolveTypes({ expression })
        if (types.size !== 1) {
            return
        }

        const resolved = [...types][0]
        if (!resolved.startsWith('@table')) {
            return
        }

        const info = this.getTableInfo(resolved)
        if (info.className) {
            scope.items.push({
                type: 'partial',
                seenClassId: resolved,
            })
        }
    }

    /**
     * Adds information about the usage of an expression.
     */
    protected addUsage(item: UsageItem, scope: LuaScope) {
        let usageTypes = this.usageTypes.get(item.expression)
        if (!usageTypes) {
            usageTypes = new Set([
                'boolean',
                'function',
                'number',
                'string',
                'table',
            ])

            this.usageTypes.set(item.expression, usageTypes)
        }

        if (item.supportsConcatenation) {
            // string | number
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('table')
        }

        if (item.supportsIndexing || item.supportsLength) {
            // table | string
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('number')
        }

        if (item.supportsIndexAssignment) {
            // table
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('number')
            usageTypes.delete('string')
        }

        if (item.supportsMath || item.inNumericFor) {
            // number
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('string')
            usageTypes.delete('table')
        }

        // handle function argument analysis
        if (item.arguments === undefined) {
            return
        }

        // function
        usageTypes.delete('boolean')
        usageTypes.delete('number')
        usageTypes.delete('string')
        usageTypes.delete('table')

        const types = [...this.resolveTypes({ expression: item.expression })]

        const id = types[0]
        if (types.length !== 1 || !id.startsWith('@function')) {
            return
        }

        const funcInfo = this.getFunctionInfo(id)
        const parameterTypes = funcInfo.parameterTypes

        // add passed arguments to inferred parameter types
        for (let i = 0; i < item.arguments.length; i++) {
            parameterTypes[i] ??= new Set()
            this.resolveTypes({ expression: item.arguments[i] }).forEach((x) =>
                parameterTypes[i].add(x),
            )
        }

        // if arguments aren't passed for a parameter, add nil
        for (let i = item.arguments.length; i < parameterTypes.length; i++) {
            parameterTypes[i] ??= new Set()
            parameterTypes[i].add('nil')
        }
    }

    protected checkBaseUINode(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression | undefined {
        const name = this.getFieldClassName(scope, lhs)
        if (!name) {
            return
        }

        if (rhs.type !== 'operation' || rhs.operator !== 'call') {
            return
        }

        // A(X)
        if (rhs.arguments.length !== 2) {
            return
        }

        // A.B(X)
        const callBase = rhs.arguments[0]
        if (callBase.type !== 'member') {
            return
        }

        // A.__call(X)
        if (callBase.member !== '__call') {
            return
        }

        // A.__call({ ... })
        const callArg = rhs.arguments[1]
        if (callArg.type !== 'literal' || !callArg.tableId) {
            return
        }

        const argInfo = this.getTableInfo(callArg.tableId)
        const atomField = argInfo.literalFields.find(
            (x) => x.key.type === 'string' && x.key.name === '_ATOM_UI_CLASS',
        )

        // A.__call({ _ATOM_UI_CLASS = X, ... })
        if (!atomField || atomField.value.type !== 'reference') {
            return
        }

        const info = this.addAtomUIClass(scope, name, argInfo)
        info.isAtomUIBase = true

        return {
            type: 'literal',
            luaType: 'table',
            tableId: info.id,
        }
    }

    protected checkChildUINode(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression | undefined {
        const name = this.getFieldClassName(scope, lhs)
        if (!name) {
            return
        }

        if (rhs.type !== 'operation' || rhs.operator !== 'call') {
            return
        }

        // A(X)
        if (rhs.arguments.length !== 2) {
            return
        }

        // A({ ... })
        const callArg = rhs.arguments[1]
        if (callArg.type !== 'literal' || !callArg.tableId) {
            return
        }

        // TableRef({ ... })
        const callBase = rhs.arguments[0]
        const types = this.resolveTypes({ expression: callBase })
        const argId = [...types][0]
        if (types.size !== 1 || !argId.startsWith('@table')) {
            return
        }

        // Node({ ... })
        const baseInfo = this.getTableInfo(argId)
        if (!baseInfo.isAtomUI) {
            return
        }

        const argInfo = this.getTableInfo(callArg.tableId)
        const info = this.addAtomUIClass(
            scope,
            name,
            argInfo,
            baseInfo.className,
        )

        return {
            type: 'literal',
            luaType: 'table',
            tableId: info.id,
        }
    }

    protected checkClassMethod(
        scope: LuaScope,
        info: FunctionInfo,
        identExpr: LuaMember,
    ) {
        const base = identExpr.base
        const types = this.resolveTypes({ expression: base })
        if (types.size !== 1) {
            return
        }

        const tableId = [...types][0]
        const tableInfo = tableId.startsWith('@table')
            ? this.getTableInfo(tableId)
            : undefined

        info.parameterTypes.push(types)

        // assume Class:new(...) returns Class
        if (identExpr.member === 'new') {
            info.returnTypes.push(new Set(types))
            info.isConstructor = true

            if (!tableInfo) {
                return
            }

            // `:new` method without class → create class
            if (!tableInfo.className && !tableInfo.fromHiddenClass) {
                let name: string | undefined
                let generated = false
                switch (base.type) {
                    case 'reference':
                        const localName = scope.localIdToName(base.id)
                        name = localName ?? base.id
                        generated = localName !== undefined
                        break

                    case 'member':
                        name = this.getFieldClassName(scope, base)
                        generated = true
                        break
                }

                if (!name) {
                    return
                }

                tableInfo.className = name
                scope.items.push({
                    type: 'partial',
                    classInfo: {
                        name,
                        tableId,
                        generated,
                        definingModule: this.currentModule,
                    },
                })
            }
        }
    }

    protected checkClassTable(expr: LuaExpression): string | undefined {
        if (expr.type === 'operation' && expr.operator === 'call') {
            return
        }

        if (expr.type === 'operation' && expr.operator === 'or') {
            const orLhs = expr.arguments[0]
            const orRhs = expr.arguments[1]
            const orRhsFields = (orRhs.type === 'literal' && orRhs.fields) || []

            // X = X or {} → treat as X
            if (orLhs.type === 'reference' && orRhsFields.length === 0) {
                const result = this.checkClassTable(orLhs)
                if (result) {
                    return result
                }
            }
        }

        const typeSet = this.resolveTypes({ expression: expr })

        // expect unambiguous type
        if (typeSet.size !== 1) {
            return
        }

        // expect table
        const rhs = [...typeSet][0]
        if (!rhs.startsWith('@table')) {
            return
        }

        return rhs
    }

    protected checkClosureClass(
        scope: LuaScope,
        node: ast.FunctionDeclaration,
        info: FunctionInfo,
        identExpr: LuaMember,
    ): boolean {
        const base = identExpr.base
        if (base.type !== 'reference') {
            return false
        }

        // setmetatable instances should be handled elsewhere
        if (this.checkHasSetmetatableInstance(node)) {
            return false
        }

        // all closure-based classes set a local `self` or `publ`
        // this will be either a table or a call to the base class `.new`
        let classTable: ast.TableConstructorExpression | undefined
        let baseClass: string | undefined
        let selfName = 'self'
        for (const child of node.body) {
            // local self/publ = ...
            if (child.type !== 'LocalStatement') {
                continue
            }

            const name = child.variables[0]?.name
            if (name !== 'self' && name !== 'publ') {
                continue
            }

            // local self/publ = {}
            const init = child.init[0]
            if (init.type === 'TableConstructorExpression') {
                classTable = init
                selfName = name
                break
            }

            // no closure-based classes are defined as local publ = X.new(...)
            if (name === 'publ') {
                continue
            }

            // local self = X.new()
            const base = init.type === 'CallExpression' ? init.base : undefined

            if (base?.type !== 'MemberExpression') {
                continue
            }

            if (base.identifier.name !== 'new') {
                continue
            }

            const memberBase = base.base
            if (memberBase.type !== 'Identifier') {
                continue
            }

            selfName = name
            baseClass = memberBase.name
            break
        }

        if (!baseClass && !classTable) {
            return false
        }

        // require at least one `self.X` function to identify it as a closure-based class
        const foundFunction = node.body.find((child) => {
            if (child.type !== 'FunctionDeclaration') {
                return
            }

            if (child.identifier?.type !== 'MemberExpression') {
                return
            }

            const base = child.identifier.base
            if (base.type !== 'Identifier') {
                return
            }

            return base.name === selfName
        })

        if (!foundFunction) {
            return false
        }

        const tableId = classTable
            ? this.getTableID(classTable)
            : this.newTableID()

        const tableInfo = this.getTableInfo(tableId)
        if (tableInfo.className) {
            // already has a class
            return false
        }

        let name: string
        const memberName = identExpr.member
        if (memberName === 'new' || memberName === 'getInstance') {
            name = scope.localIdToName(base.id) ?? base.id

            // name collision → don't emit a class annotation for the container
            const types = this.resolveTypes({ expression: base })
            const resolved = [...types][0]
            if (types.size === 1 && resolved.startsWith('@table')) {
                const containerInfo = this.getTableInfo(resolved)
                if (containerInfo.className === name) {
                    containerInfo.emitAsTable = true
                }
            }
        } else {
            const lastSlash = this.currentModule.lastIndexOf('/')
            name = this.currentModule.slice(lastSlash + 1)
        }

        tableInfo.className = name
        tableInfo.isClosureClass = true
        scope.items.push({
            type: 'partial',
            classInfo: {
                name,
                tableId,
                definingModule: this.currentModule,
                base: baseClass,
                generated: true,
            },
        })

        scope.classSelfName = selfName
        if (!classTable) {
            // to identify the table when it's being defined
            scope.classTableId = tableId
        }

        // mark the instance in the base class
        const resolvedBaseTypes = [
            ...this.resolveTypes({
                expression: base,
            }),
        ]

        const resolvedBase =
            resolvedBaseTypes.length === 1 ? resolvedBaseTypes[0] : undefined

        if (resolvedBase?.startsWith('@table')) {
            const baseTableInfo = this.getTableInfo(resolvedBase)
            if (baseTableInfo.className) {
                baseTableInfo.instanceName = name
                baseTableInfo.instanceId = tableId
            }
        }

        if (identExpr.indexer === ':') {
            info.parameterTypes.push(this.resolveTypes({ expression: base }))
        }

        info.returnTypes.push(new Set([tableId]))
        info.isConstructor = true
        return true
    }

    protected checkDeriveCall(
        expr: LuaExpression,
    ): [string, string] | undefined {
        if (expr.type !== 'operation' || expr.operator !== 'call') {
            return
        }

        // expect single argument (base + arg count)
        if (expr.arguments.length !== 2) {
            return
        }

        // expect string
        const arg = expr.arguments[1]
        if (arg.type !== 'literal' || arg.luaType !== 'string') {
            return
        }

        const type = readLuaStringLiteral(arg.literal ?? '')
        if (!type) {
            return
        }

        // expect X:Y(...)
        const callBase = expr.arguments[0]
        if (callBase?.type !== 'member' || callBase.indexer !== ':') {
            return
        }

        // expect X:derive(...)
        if (callBase.member !== 'derive') {
            return
        }

        // expect base:derive(...)
        const base = callBase.base
        if (base.type !== 'reference' || base.id.startsWith('@')) {
            return
        }

        // found derive; return base class name
        return [base.id, type]
    }

    protected checkFieldCallAssign(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression {
        // check for `:derive` calls
        const [base, deriveName] = this.checkDeriveCall(rhs) ?? []
        const name = base && this.getFieldClassName(scope, lhs)
        if (base && name) {
            const newId = this.newTableID()
            const newInfo = this.getTableInfo(newId)
            newInfo.className = name

            scope.items.push({
                type: 'partial',
                classInfo: {
                    name,
                    tableId: newId,
                    base,
                    deriveName,
                    generated: true,
                    definingModule: this.currentModule,
                },
            })

            return {
                type: 'literal',
                luaType: 'table',
                tableId: newId,
            }
        }

        // check for base `UI.Node` initialization
        const baseUiRhs = this.checkBaseUINode(scope, lhs, rhs)
        if (baseUiRhs) {
            return baseUiRhs
        }

        // check for child UI node initialization
        const childUiRhs = this.checkChildUINode(scope, lhs, rhs)
        if (childUiRhs) {
            return childUiRhs
        }

        return rhs
    }

    protected checkHasSetmetatableInstance(node: ast.FunctionDeclaration) {
        for (const child of node.body) {
            // check for a setmetatable call
            if (child.type !== 'CallStatement') {
                continue
            }

            if (child.expression.type !== 'CallExpression') {
                continue
            }

            const base = child.expression.base
            if (base.type !== 'Identifier' || base.name !== 'setmetatable') {
                continue
            }

            // check for a metatable
            const meta = child.expression.arguments[1]
            if (!meta) {
                continue
            }

            // identifier → using table as index
            if (meta.type === 'Identifier') {
                return true
            }

            if (meta.type !== 'TableConstructorExpression') {
                continue
            }

            // table → check for an __index field
            for (const field of meta.fields) {
                if (field.type !== 'TableKeyString') {
                    continue
                }

                if (field.key.name === '__index') {
                    return true
                }
            }
        }

        return false
    }

    /**
     * Checks whether the given expression has already been seen.
     * This will attempt to use known types, and will otherwise add `unknown`.
     */
    protected checkTypeResolutionCycle(
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

    protected finalizeClass(
        cls: ResolvedClassInfo,
        refs: Map<string, LuaExpression | null>,
    ): [AnalyzedClass | AnalyzedTable, boolean] {
        const info = this.getTableInfo(cls.tableId)
        const isTable = info.emitAsTable ?? false
        const isClassDefiner = cls.definingModule === this.currentModule

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
            isClassDefiner && !this.isRosettaInit && !isTable

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

            let types: Set<string> | undefined
            if (keyName) {
                literalKeys.add(keyName)

                const literalKeyName = this.getLiteralKey(keyName)
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

                return x.definingModule === this.currentModule
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
                const funcInfo = this.getFunctionInfo(id)
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
                    this.resolveTypes(expr).forEach((x) => instanceTypes.add(x))
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

        // check for floating setters
        const seenIds = new Set<string>()
        while (checkSubfields.length > 0) {
            const [id, baseName] = checkSubfields.pop()!
            if (seenIds.has(id)) {
                continue
            }

            seenIds.add(id)
            const tableInfo = this.getTableInfo(id)

            for (let [field, expressions] of tableInfo.definitions) {
                let name = getLuaFieldKey(field)
                if (baseName) {
                    name = name.startsWith('[')
                        ? `${baseName}${name}`
                        : `${baseName}.${name}`
                }

                const definingExprs = expressions.filter((x) => {
                    return (
                        !x.instance && x.definingModule === this.currentModule
                    )
                })

                if (definingExprs.length > 0) {
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

        if (isTable) {
            const finalized: AnalyzedTable = {
                name: cls.name,
                local: cls.generated,
                staticFields,
                methods,
                functions,
                overloads,
            }

            return [finalized, true]
        }

        const finalized: AnalyzedClass = {
            name: cls.name,
            extends: cls.base,
            deriveName: cls.deriveName,
            local: cls.generated,
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

        return [finalized, false]
    }

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

    protected finalizeDefinitions(
        defs: LuaExpressionInfo[],
        refs: Map<string, LuaExpression | null>,
        seen?: Map<string, LuaExpression | null>,
    ): [LuaExpression | undefined, Set<string> | undefined] {
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
                this.resolveTypes(def).forEach((x) => types!.add(x))
            }

            // no defs at module level → assume optional
            if (!defs.find((x) => !x.functionLevel)) {
                types.add('nil')
            }

            types = this.finalizeTypes(types)
        }

        return [value, types]
    }

    protected finalizeExpression(
        expression: LuaExpression,
        refs: Map<string, LuaExpression | null>,
        seen?: Map<string, LuaExpression | null>,
    ): LuaExpression {
        seen ??= new Map()

        let base: LuaExpression
        switch (expression.type) {
            case 'reference':
                // remove internal ID information
                const id = expression.id
                const start = id.indexOf('[')
                const sanitizedExpression: LuaExpression = {
                    type: 'reference',
                    id:
                        start !== -1
                            ? id.slice(start + 1, -1)
                            : id.startsWith('@self')
                              ? 'self'
                              : id,
                }

                const replaceExpr = refs.get(expression.id)
                if (replaceExpr === undefined) {
                    return sanitizedExpression
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

    protected finalizeFunction(id: string, name: string): AnalyzedFunction {
        const info = this.getFunctionInfo(id)
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
                    this.resolveTypes({ expression: expr }).forEach((x) =>
                        types.add(x),
                    )
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
            this.resolveTypes({ expression: expr }).forEach((x) => types.add(x))
        }

        return {
            types: this.finalizeTypes(types),
            expression,
        }
    }

    protected finalizeStaticField(
        expressions: LuaExpressionInfo[],
        refs: Map<string, LuaExpression | null>,
    ): [LuaExpression | undefined, Set<string>] {
        const staticTypes = new Set<string>()
        for (const expr of expressions) {
            this.resolveTypes(expr).forEach((x) => staticTypes.add(x))
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
        const info = this.getTableInfo(id)

        const fields: TableField[] = []

        let nextAutoKey = 1
        for (let [defKey, defs] of info.definitions) {
            const filtered = defs.filter(
                (x) => x.definingModule === this.currentModule,
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

    protected finalizeTypes(types: Set<string>): Set<string> {
        const finalizedTypes = new Set(
            [...types]
                .map((type) => {
                    if (type === 'true' || type === 'false') {
                        return 'boolean'
                    }

                    if (type.startsWith('@table')) {
                        const tableInfo = this.getTableInfo(type)
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

    protected getFieldClassName(
        scope: LuaScope,
        expr: LuaExpression,
    ): string | undefined {
        if (expr.type !== 'member') {
            return
        }

        const names: string[] = [expr.member]

        while (expr.type === 'member') {
            const parent: LuaExpression = expr.base
            if (parent.type === 'reference') {
                names.push(scope.localIdToName(parent.id) ?? parent.id)
                break
            } else if (parent.type !== 'member') {
                return
            }

            names.push(parent.member)
            expr = parent
        }

        return names.reverse().join('.')
    }

    /**
     * Gets function info from a function ID, creating it if it doesn't exist.
     */
    protected getFunctionInfo(id: string): FunctionInfo {
        let info = this.idToFunctionInfo.get(id)
        if (info) {
            return info
        }

        info = {
            id,
            parameters: [],
            parameterNames: [],
            parameterTypes: [],
            returnTypes: [],
            returnExpressions: [],
        }

        this.idToFunctionInfo.set(id, info)
        return info
    }

    /**
     * Gets the literal key to use for a table field mapping.
     */
    protected getLiteralKey(key: string, type?: LuaType) {
        let internal: string | undefined
        if (!type) {
            internal = key
        } else if (type === 'string') {
            internal = readLuaStringLiteral(key)
        }

        if (!internal) {
            return key
        }

        return '"' + internal.replaceAll('"', '\\"') + '"'
    }

    protected getReferences(mod: ResolvedModule): Set<string> {
        const stack: [LuaExpression, number][] = []
        for (const cls of mod.classes) {
            const info = this.getTableInfo(cls.tableId)
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

                    const resolvedTypes = this.resolveTypes({ expression })

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

                    const info = this.getTableInfo(tableId)
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
     * Gets table info from a table ID, creating it if it doesn't exist.
     */
    protected getTableInfo(id: string): TableInfo {
        let info = this.idToTableInfo.get(id)
        if (info) {
            return info
        }

        info = {
            id,
            literalFields: [],
            definitions: new Map(),
        }

        this.idToTableInfo.set(id, info)
        return info
    }

    /**
     * Gets the truthiness of a set of types.
     * If the truth cannot be determined, returns `undefined`
     * @param types
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

    protected isLiteralClassTable(expr: LuaExpression) {
        if (expr.type !== 'literal' || expr.luaType !== 'table') {
            return
        }

        const id = expr.tableId
        if (!id) {
            return
        }

        const info = this.getTableInfo(id)
        return info.className !== undefined
    }

    /**
     * Narrows possible expression types based on usage.
     */
    protected narrowTypes(expr: LuaExpression, types: Set<string>) {
        // no narrowing necessary
        if (types.size <= 1) {
            return
        }

        // no narrowing is possible
        const usage = this.usageTypes.get(expr)
        if (!usage || usage.size === 0 || usage.size === 5) {
            return
        }

        // filter possible types to narrowed types
        const narrowed = [...types].filter((type) => {
            if (type.startsWith('@function') && usage.has('function')) {
                return true
            } else if (type.startsWith('@table') && usage.has('table')) {
                return true
            } else if (usage.has(type)) {
                return true
            }

            return false
        })

        // oops, too much narrowing
        if (narrowed.length === 0) {
            return
        }

        types.clear()
        narrowed.forEach((x) => types.add(x))
    }

    protected newTableID(name?: string): string {
        const count = this.nextTableIndex++
        return `@table(${count})` + (name ? `[${name}]` : '')
    }

    protected remapBooleans(types: Set<string>) {
        const remapped = [...types].map((x) =>
            x === 'true' || x === 'false' ? 'boolean' : x,
        )

        types.clear()
        remapped.forEach((x) => types.add(x))

        return types
    }

    protected removeEmptyDefinition(name: string) {
        const defs = this.definitions.get(name)

        // single def?
        if (!defs || defs.length !== 1) {
            return
        }

        // belongs to this module?
        const def = defs[0]
        if (def.definingModule !== this.currentModule) {
            return
        }

        // table?
        const expr = def.expression
        if (expr.type !== 'literal' || expr.luaType !== 'table') {
            return
        }

        if (!expr.tableId) {
            return
        }

        // empty?
        if (expr.fields && expr.fields.length > 0) {
            return
        }

        const info = this.getTableInfo(expr.tableId)
        if (info.definitions.size > 0) {
            return
        }

        // remove the empty table definition
        info.isEmptyClass = true
        defs.splice(0, defs.length)
    }

    /**
     * Resolves an expression into a basic literal, if it can be determined
     * to be resolvable to one.
     */
    protected resolveBasicLiteral(
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
                    fieldDefs = this.definitions.get(expr.id)
                    if (fieldDefs && fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'member':
                    const memberBase = [
                        ...this.resolveTypes({ expression: expr.base }),
                    ]

                    if (memberBase.length !== 1) {
                        break
                    }

                    tableInfo = this.getTableInfo(memberBase[0])
                    key = this.getLiteralKey(expr.member)
                    fieldDefs = tableInfo.definitions.get(key) ?? []

                    if (fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'index':
                    const indexBase = [
                        ...this.resolveTypes({ expression: expr.base }),
                    ]

                    if (indexBase.length !== 1) {
                        break
                    }

                    const index = this.resolveBasicLiteral(expr.index, seen)

                    if (!index || !index.literal) {
                        break
                    }

                    tableInfo = this.getTableInfo(indexBase[0])
                    key = this.getLiteralKey(index.literal, index.luaType)
                    fieldDefs = tableInfo.definitions.get(key) ?? []

                    if (fieldDefs.length === 1) {
                        stack.push(fieldDefs[0])
                    }

                    break

                case 'operation':
                    const types = [
                        ...this.resolveTypes({ expression: expr }, seen),
                    ]

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

        return
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

            const info = this.getTableInfo(type)
            const literalKey = isIndex ? field : this.getLiteralKey(field)
            const fieldDefs = info.definitions.get(literalKey) ?? []

            for (const def of fieldDefs) {
                this.resolveTypes(def, seen).forEach((x) => fieldTypes.add(x))
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
                const func = op.arguments[0]
                if (!func) {
                    break
                }

                if (func.type === 'reference') {
                    if (func.id === 'tonumber') {
                        types.add('number')
                        types.add('nil')
                        break
                    } else if (func.id === 'tostring') {
                        types.add('string')
                        break
                    }
                }

                const resolvedFuncTypes = this.resolveTypes(
                    { expression: func },
                    seen,
                )

                if (!resolvedFuncTypes || resolvedFuncTypes.size !== 1) {
                    break
                }

                const resolvedFunc = [...resolvedFuncTypes][0]
                if (!resolvedFunc.startsWith('@function')) {
                    break
                }

                // handle constructors
                const funcInfo = this.getFunctionInfo(resolvedFunc)
                if (funcInfo.isConstructor) {
                    types.add('@instance') // mark as an instance to correctly attribute fields
                    funcInfo.returnTypes[0]?.forEach((x) => types.add(x))
                    break
                }

                const returns = funcInfo.returnTypes[index - 1]
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
                const argTypes = this.resolveTypes(
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

                lhsTypes = this.resolveTypes({ expression: lhs }, seen)
                rhsTypes = this.resolveTypes({ expression: rhs }, seen)

                // X and Y or Z → use Y & Z (ternary special case)
                if (lhs.type === 'operation' && lhs.operator === 'and') {
                    lhsTypes = this.resolveTypes(
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

                lhsTypes = this.resolveTypes({ expression: lhs }, seen)
                rhsTypes = this.resolveTypes({ expression: rhs }, seen)

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

    /**
     * Resolves the potential types of an expression.
     */
    protected resolveTypes(
        info: LuaExpressionInfo,
        seen?: Map<LuaExpressionInfo, Set<string>>,
    ): Set<string> {
        seen ??= new Map()
        const types = new Set<string>()

        if (this.checkTypeResolutionCycle(info, types, seen)) {
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
                    const funcId = this.parameterToFunctionId.get(id)
                    if (!funcId) {
                        break
                    }

                    const funcInfo = this.getFunctionInfo(funcId)
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

                const defs = this.definitions.get(id)
                if (!defs) {
                    break
                }

                for (const def of defs) {
                    this.resolveTypes(def, seen).forEach((x) =>
                        typesToAdd.add(x),
                    )
                }

                break

            case 'member':
                const memberBaseTypes = this.resolveTypes(
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
                const indexBaseTypes = this.resolveTypes(
                    { expression: expression.base, index: info.index },
                    seen,
                )

                const index = this.resolveBasicLiteral(expression.index, seen)

                if (!index || !index.literal) {
                    typesToAdd = new Set()
                    break
                }

                const key = this.getLiteralKey(index.literal, index.luaType)
                typesToAdd = this.resolveFieldTypes(
                    indexBaseTypes,
                    key,
                    true,
                    seen,
                )

                break

            case 'require':
                const moduleName = expression.module

                // unknown → check for alias
                let mod = this.modules.get(moduleName)
                if (!mod) {
                    let alias = this.aliasMap.get(moduleName)
                    const firstAlias = alias ? [...alias][0] : undefined
                    if (firstAlias) {
                        mod = this.modules.get(firstAlias)
                    }
                }

                // still unknown
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

    protected tryAddPartialItem(
        scope: LuaScope,
        item: AssignmentItem | RequireAssignmentItem | FunctionDefinitionItem,
        lhs: LuaReference,
        rhs: LuaExpression,
    ): string | undefined {
        // edge case: closure-based classes
        if (scope.type === 'function') {
            if (scope.localIdToName(lhs.id) !== scope.classSelfName) {
                return
            }

            // self = {} | Base.new() → use the generated table
            return scope.classTableId
        }

        // module and module-level blocks, excluding functions
        if (!scope.id.startsWith('@module')) {
            return
        }

        if (item.type === 'requireAssignment') {
            scope.items.push({
                type: 'partial',
                requireInfo: {
                    name: lhs.id,
                    module: item.rhs.module,
                },
            })

            return
        }

        // global function definition
        if (item.type === 'functionDefinition') {
            // ignore local functions
            if (item.isLocal) {
                return
            }

            scope.items.push({
                type: 'partial',
                functionInfo: {
                    name: lhs.id,
                    functionId: item.id,
                },
            })

            return
        }

        const [base, deriveName] = this.checkDeriveCall(rhs) ?? []

        if (lhs.id.startsWith('@')) {
            if (base) {
                // if there's a derive call, return a table so fields aren't misattributed

                const newId = this.newTableID()
                const info = this.getTableInfo(newId)
                info.fromHiddenClass = true
                info.originalBase = base
                info.originalDeriveName = deriveName

                return newId
            }

            // ignore local classes otherwise
            return
        }

        const tableId = !base ? this.checkClassTable(rhs) : this.newTableID()

        // global table or derive call → class
        if (tableId) {
            const tableInfo = this.getTableInfo(tableId)
            tableInfo.className ??= lhs.id
            tableInfo.definingModule ??= this.currentModule

            this.removeEmptyDefinition(lhs.id) // ThermoDebug edge case

            scope.items.push({
                type: 'partial',
                classInfo: {
                    name: lhs.id,
                    tableId,
                    definingModule: tableInfo.definingModule,
                    base: base ?? tableInfo.originalBase,
                    deriveName: deriveName ?? tableInfo.originalDeriveName,
                },
            })

            return tableId
        }

        // global function assignment
        const rhsTypes = [...this.resolveTypes({ expression: item.rhs })]

        if (rhsTypes.length !== 1) {
            return
        }

        const rhsType = rhsTypes[0]
        if (rhsType.startsWith('@function')) {
            scope.items.push({
                type: 'partial',
                functionInfo: {
                    name: lhs.id,
                    functionId: rhsType,
                },
            })
        }
    }
}
