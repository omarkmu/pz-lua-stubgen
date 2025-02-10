import path from 'path'
import { BaseReporter } from '../base'
import { AnnotateArgs } from './types'

import {
    AnalyzedClass,
    AnalyzedField,
    AnalyzedFunction,
    AnalyzedModule,
    AnalyzedParameter,
    Analyzer,
    LuaExpression,
    LuaLiteral,
    LuaOperation,
    TableField,
} from '../analysis'

import {
    Rosetta,
    RosettaClass,
    RosettaConstructor,
    RosettaField,
    RosettaFile,
    RosettaFunction,
    RosettaOperator,
    RosettaOverload,
} from '../rosetta'
import {
    convertRosettaClass,
    convertRosettaFields,
    convertRosettaFile,
    convertRosettaFunction,
    convertRosettaFunctions,
    convertRosettaTable,
} from '../helpers'
import { log } from '../logger'

const PREFIX = '---@meta'

/**
 * Handles annotation of Lua files.
 */
export class Annotator extends BaseReporter {
    protected outDirectory: string
    protected rosetta: Rosetta
    protected useRosetta: boolean
    protected alphabetize: boolean
    protected includeKahlua: boolean
    protected strictFields: boolean
    protected noInject: boolean
    protected exclude: Set<string>
    protected excludeFields: Set<string>

    constructor(args: AnnotateArgs) {
        super(args)

        this.outDirectory = path.normalize(args.outputDirectory)
        this.alphabetize = args.alphabetize
        this.includeKahlua = args.includeKahlua
        this.strictFields = args.strictFields
        this.noInject = !args.inject
        this.exclude = new Set(args.exclude)

        this.useRosetta = args.rosetta !== undefined
        this.rosetta = new Rosetta({
            inputDirectory: args.rosetta ?? '',
        })

        const excludeFields = args.excludeFields ?? []
        if (args.excludeKnownDefs) {
            excludeFields.push(
                ...[
                    'RecMedia',
                    'Distributions',
                    'ProceduralDistributions',
                    'VehicleDistributions',
                    'SuburbsDistributions',
                    'ClutterTables',
                    'BagsAndContainers',
                    'SpecialLootSpawns',
                ],
            )
        }

        this.excludeFields = new Set(excludeFields)
    }

    generateStub(mod: AnalyzedModule) {
        const out = [(mod.prefix ?? PREFIX) + '\n']

        const rosettaFile = this.rosetta.files[mod.id]

        if (this.writeRequires(mod, out, rosettaFile)) {
            out.push('\n')
        }

        if (this.writeLocals(mod, out)) {
            out.push('\n')
        }

        if (this.writeTables(mod, out, rosettaFile)) {
            out.push('\n')
        }

        if (this.writeClasses(mod, out, rosettaFile)) {
            out.push('\n')
        }

        if (this.writeGlobalFunctions(mod, out, rosettaFile)) {
            out.push('\n')
        }

        this.writeReturns(mod, out)

        return out.join('').trimEnd() + '\n'
    }

    /**
     * Runs typestub generation.
     */
    async run() {
        this.resetState()

        if (this.useRosetta) {
            const rosettaDir = this.rosetta.inputDirectory
            log.verbose(`Loading Rosetta from '${rosettaDir}'`)

            if (await this.rosetta.load()) {
                log.verbose('Loaded Rosetta')
            } else {
                log.warn(`Failed to load Rosetta from '${rosettaDir}'`)
            }
        }

        const modules = await this.getModules()

        const start = performance.now()
        const outDir = this.outDirectory
        for (const mod of modules) {
            const outFile = path.resolve(path.join(outDir, mod.id + '.lua'))

            let typestub: string
            try {
                typestub = this.generateStub(mod)
            } catch (e) {
                this.errors.push(
                    `Failed to generate typestub for file ${outFile}': ${e}`,
                )

                continue
            }

            try {
                await this.outputFile(outFile, typestub)
            } catch (e) {
                this.errors.push(`Failed to write file ${outFile}': ${e}`)
            }
        }

        const time = (performance.now() - start).toFixed(0)
        log.verbose(`Finished annotation in ${time}ms`)

        this.reportErrors()

        const resolvedOutDir = path.resolve(this.outDirectory)
        log.info(`Generated stubs at '${resolvedOutDir}'`)

        return modules
    }

    protected augmentClass(
        cls: AnalyzedClass,
        rosettaFile: RosettaFile,
    ): AnalyzedClass {
        const rosettaClass = rosettaFile.classes[cls.name]
        if (!rosettaClass) {
            return cls
        }

        const fieldSet = new Set<string>(cls.fields.map((x) => x.name))
        cls.fields.push(
            ...convertRosettaFields(rosettaClass.fields ?? {}).filter(
                (x) => !fieldSet.has(x.name),
            ),
        )

        const staticFieldSet = new Set<string>(cls.fields.map((x) => x.name))
        cls.staticFields.push(
            ...convertRosettaFields(rosettaClass.staticFields ?? {}).filter(
                (x) => !staticFieldSet.has(x.name),
            ),
        )

        const funcSet = new Set<string>(cls.functions.map((x) => x.name))
        cls.functions.push(
            ...convertRosettaFunctions(rosettaClass.staticMethods ?? {}).filter(
                (x) => !funcSet.has(x.name),
            ),
        )

        const methodSet = new Set<string>(cls.methods.map((x) => x.name))
        cls.methods.push(
            ...convertRosettaFunctions(rosettaClass.methods ?? {}, true).filter(
                (x) => !methodSet.has(x.name),
            ),
        )

        return cls
    }

    protected augmentModule(mod: AnalyzedModule): AnalyzedModule {
        const rosettaFile = this.rosetta.files[mod.id]
        if (!rosettaFile) {
            return mod
        }

        for (const cls of mod.classes) {
            this.augmentClass(cls, rosettaFile)
        }

        const clsSet = new Set<string>(mod.classes.map((x) => x.name))
        mod.classes.push(
            ...Object.values(rosettaFile.classes)
                .filter((x) => !clsSet.has(x.name))
                .map((x) => convertRosettaClass(x)),
        )

        const funcSet = new Set<string>(mod.functions.map((x) => x.name))
        mod.functions.push(
            ...Object.values(rosettaFile.functions)
                .filter((x) => !funcSet.has(x.name))
                .map((x) => convertRosettaFunction(x)),
        )

        const tableSet = new Set<string>(mod.tables.map((x) => x.name))
        mod.tables.push(
            ...Object.values(rosettaFile.tables)
                .filter((x) => !tableSet.has(x.name))
                .map(convertRosettaTable),
        )

        return mod
    }

    protected async getKahluaModule(): Promise<AnalyzedModule | undefined> {
        const kahluaDataPath = path.join(__dirname, '../../__kahlua.yml')
        const file = await this.rosetta.loadYamlFile(kahluaDataPath)
        if (!file) {
            this.errors.push(
                `Failed to load kahlua data from ${kahluaDataPath}`,
            )

            return
        }

        const mod = convertRosettaFile(file)
        mod.prefix = '---@meta _'

        // manually set `table.pairs = pairs`
        const tableCls = mod.tables.find((x) => x.name === 'table')
        if (tableCls) {
            tableCls.staticFields.push({
                name: 'pairs',
                types: new Set(['function']),
                expression: {
                    type: 'reference',
                    id: 'pairs',
                },
            })
        }

        return mod
    }

    protected async getModules(): Promise<AnalyzedModule[]> {
        const analyzer = new Analyzer({
            inputDirectory: this.inDirectory,
            subdirectories: this.subdirectories,
            errors: this.errors,
            suppressErrors: true, // report errors at the end
        })

        const modules = await analyzer.run()
        for (const mod of modules) {
            const rosettaFile = this.rosetta.files[mod.id]
            mod.classes = mod.classes.filter((x) => !this.exclude.has(x.name))

            for (const cls of mod.classes) {
                const rosettaClass = rosettaFile?.classes?.[cls.name]
                if (this.excludeFields.has(cls.name)) {
                    cls.fields = []
                    cls.literalFields = []
                    cls.setterFields = []
                    cls.staticFields = []
                    continue
                }

                // inject static `Type` field for derived classes
                // skip if rosetta `Type` field is defined
                if (cls.deriveName && !rosettaClass?.staticFields?.Type) {
                    cls.staticFields.unshift({
                        name: 'Type',
                        types: new Set(),
                        expression: {
                            type: 'literal',
                            luaType: 'string',
                            literal: `"${cls.deriveName}"`,
                        },
                    })
                }
            }
        }

        if (!this.noInject) {
            for (const mod of modules) {
                this.augmentModule(mod)
            }
        }

        if (!this.includeKahlua) {
            return modules
        }

        const mod = await this.getKahluaModule()
        if (mod) {
            modules.push(mod)
        }

        return modules
    }

    protected getExpressionString(
        expression: LuaExpression,
        depth: number = 1,
    ): string {
        switch (expression.type) {
            case 'reference':
                return expression.id

            case 'require':
                return `require("${expression.module}")`

            case 'literal':
                return this.getLiteralString(expression, depth)

            case 'index':
                const indexBase = this.getExpressionString(expression.base)
                const index = this.getExpressionString(expression.index)

                return `${indexBase}[${index}]`

            case 'member':
                const memberBase = this.getExpressionString(expression.base)

                return `${memberBase}${expression.indexer}${expression.member}`

            case 'operation':
                return this.getOperationString(expression, depth)
        }
    }

    protected getFunctionPrefix(
        parameters?: AnalyzedParameter[],
        returns?: Set<string>[],
        tabLevel: number = 0,
    ): string | undefined {
        const tabs = '    '.repeat(tabLevel)

        const out = []
        parameters ??= []
        for (const param of parameters) {
            let typeString = this.getTypeString(param.types)
            if (typeString === 'any') {
                continue
            }

            out.push('\n')
            out.push(tabs)
            out.push(`---@param ${param.name} ${typeString}`)
        }

        returns ??= []
        for (const ret of returns) {
            out.push('\n')
            out.push(tabs)
            out.push(`---@return ${this.getTypeString(ret)}`)
        }

        return out.join('')
    }

    protected getFunctionPrefixFromExpr(
        expression: LuaExpression,
        tabLevel: number = 0,
    ): string | undefined {
        if (expression.type !== 'literal') {
            return
        }

        if (expression.luaType !== 'function') {
            return
        }

        return this.getFunctionPrefix(
            expression.parameters,
            expression.returnTypes,
            tabLevel,
        )
    }

    protected getFunctionString(
        name: string | undefined,
        parameters: AnalyzedParameter[],
    ) {
        return this.getFunctionStringFromParamNames(
            name,
            parameters.map((x) => x.name),
        )
    }

    protected getFunctionStringFromParamNames(
        name: string | undefined,
        parameters: string[],
    ) {
        const params = parameters.join(', ')

        if (name) {
            return `function ${name}(${params}) end`
        }

        return `function(${params}) end`
    }

    protected getInlineNotes(notes: string) {
        return notes.trim().replaceAll('\r', '').replaceAll('\n', '<br>')
    }

    protected getLiteralString(
        expression: LuaLiteral,
        depth: number = 1,
    ): string {
        switch (expression.luaType) {
            case 'nil':
                return 'nil'

            case 'string':
                return expression.literal ?? '""'

            case 'number':
                return expression.literal ?? '0'

            case 'boolean':
                return expression.literal ?? 'false'

            case 'function':
                const params = [...(expression.parameters ?? [])]
                if (expression.isMethod) {
                    params.unshift({ name: 'self', types: new Set() })
                }

                return this.getFunctionString(undefined, params)

            case 'table':
                return this.getTableString(expression, depth) ?? '{}'
        }
    }

    protected getOperationString(
        expression: LuaOperation,
        depth?: number,
    ): string {
        let lhs = expression.arguments[0]
        let rhs = expression.arguments[1]

        switch (expression.operator) {
            case 'call':
                const callBase = this.getExpressionString(
                    expression.arguments[0],
                    depth,
                )

                const args: string[] = []
                for (let i = 1; i < expression.arguments.length; i++) {
                    args.push(
                        this.getExpressionString(
                            expression.arguments[i],
                            depth,
                        ),
                    )
                }

                return `${callBase}(${args.join(', ')})`

            default:
                let lhsString = this.getExpressionString(lhs, depth)
                let rhsString = rhs
                    ? this.getExpressionString(rhs, depth)
                    : undefined

                if (!this.includeAsIs(lhs)) {
                    lhsString = `(${lhsString})`
                }

                if (rhs && !this.includeAsIs(rhs)) {
                    rhsString = `(${rhsString})`
                }

                if (!rhsString) {
                    return `${expression.operator}${lhsString}`
                }

                return `${lhsString} ${expression.operator} ${rhsString}`
        }
    }

    protected getTableString(
        expression: LuaExpression,
        depth: number = 1,
    ): string | undefined {
        if (expression.type !== 'literal') {
            return
        }

        if (expression.luaType !== 'table') {
            return
        }

        const fields = expression.fields ?? []
        if (fields.length === 0) {
            return '{}'
        }

        const out: string[] = ['{']
        this.writeTableFields(fields, out, depth)

        out.push('\n')
        out.push('    '.repeat(Math.max(depth - 1, 0)))
        out.push('}')

        return out.join('')
    }

    protected getTypeString(types: Set<string>): string {
        types = new Set(types)
        if (types.size === 0) {
            return 'any'
        }

        const nullable = types.delete('nil')
        if (types.size === 0) {
            return 'any?'
        }

        const typeString = [...types].join(' | ')
        if (nullable) {
            return typeString.includes('|')
                ? `(${typeString})?`
                : `${typeString}?`
        }

        return typeString
    }

    protected includeAsIs(expr: LuaExpression): boolean {
        if (expr.type !== 'operation') {
            return true
        }

        switch (expr.operator) {
            case 'call':
            case '..':
            case '#':
                return true

            case '-':
                // unary minus as-is, binary minus with parentheses
                return expr.arguments.length === 1

            case 'or':
                // write ternary operators as-is
                const lhs = expr.arguments[0]
                return lhs?.type === 'operation' && lhs.operator === 'and'

            default:
                return false
        }
    }

    protected isLiteralTable(expr: LuaExpression): boolean {
        if (expr.type !== 'literal') {
            return false
        }

        return expr.luaType === 'table'
    }

    protected validateRosettaFunction(
        rosettaFunc: RosettaFunction | RosettaConstructor,
        func: AnalyzedFunction,
        isMethod: boolean,
    ) {
        const rosettaParamCount = rosettaFunc.parameters?.length ?? 0
        const luaParamCount = func.parameters.length
        const name = (rosettaFunc as RosettaFunction).name ?? func.name

        if (luaParamCount !== rosettaParamCount) {
            throw new Error(
                `Rosetta ${isMethod ? 'method' : 'function'}` +
                    ` '${name}' parameter count doesn't match.` +
                    ` (lua: ${luaParamCount}, rosetta: ${rosettaParamCount})`,
            )
        }
    }

    protected writeClasses(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        let writtenCount = 0
        for (const cls of mod.classes) {
            writtenCount++
            const rosettaClass = rosettaFile?.classes[cls.name]
            const tags = new Set(rosettaClass?.tags ?? [])

            const identName = cls.name.replaceAll('.', '_')
            const base = rosettaClass?.extends ?? cls.extends

            const writtenFields = new Set<string>()

            const noDeclaration =
                tags.has('NoAnnotation') && tags.has('NoInitializer')

            let wroteNewlines = false
            if (out.length > 1) {
                out.push('\n')
                out.push('\n')
                wroteNewlines = true
            }

            if (!tags.has('NoAnnotation')) {
                // class annotation
                if (rosettaClass?.deprecated) {
                    out.push('\n---@deprecated')
                }

                this.writeNotes(rosettaClass?.notes, out)

                out.push(`\n---@class ${cls.name}`)
                if (base) {
                    out.push(` : ${base}`)
                }

                this.writeRosettaOperators(rosettaClass?.operators, out)

                if (!this.writeRosettaOverloads(rosettaClass?.overloads, out)) {
                    for (const overload of cls.overloads) {
                        this.writeOverload(overload, out)
                    }
                }

                const sortedFields = this.alphabetize
                    ? [...cls.fields].sort((a, b) =>
                          a.name.localeCompare(b.name),
                      )
                    : cls.fields

                // fields
                for (const field of sortedFields) {
                    const rosettaField = rosettaClass?.fields?.[field.name]

                    writtenFields.add(field.name)

                    let typeString: string
                    let notes: string
                    if (rosettaField) {
                        typeString = rosettaField.type?.trim() ?? 'any'
                        notes = rosettaField.notes ?? ''
                    } else {
                        typeString = this.getTypeString(field.types)
                        notes = ''
                    }

                    if (notes) {
                        notes = ' ' + this.getInlineNotes(notes)
                    }

                    out.push(`\n---@field ${field.name} ${typeString}${notes}`)
                }

                if (rosettaClass?.mutable || !this.strictFields) {
                    out.push('\n---@field [any] any')
                }
            }

            if (!tags.has('NoInitializer')) {
                // definition
                out.push('\n')

                if (cls.local) {
                    out.push('local ')
                }

                out.push(`${identName} = `)

                if (cls.deriveName && base) {
                    out.push(`${base}:derive("${cls.deriveName}")`)
                } else if (cls.literalFields.length > 0) {
                    out.push('{')

                    this.writeTableFields(
                        cls.literalFields,
                        out,
                        undefined,
                        writtenFields,
                    )

                    out.push('\n}')
                } else {
                    out.push('{}')
                }
            }

            // static fields
            const statics = [...cls.staticFields, ...cls.setterFields]
            for (const field of statics) {
                this.writeStaticField(
                    identName,
                    field,
                    rosettaClass?.staticFields?.[field.name],
                    writtenFields,
                    out,
                )
            }

            // remove extra newline if there's no declaration or fields
            if (wroteNewlines && noDeclaration && writtenFields.size === 0) {
                out.pop()
            }

            // functions
            this.writeClassFunctions(
                identName,
                cls.functions,
                '.',
                out,
                rosettaClass,
            )

            // methods
            this.writeClassFunctions(
                identName,
                cls.methods,
                ':',
                out,
                rosettaClass,
            )

            // function constructors
            this.writeClassFunctions(
                identName,
                cls.functionConstructors,
                '.',
                out,
                rosettaClass,
            )

            // method constructors
            this.writeClassFunctions(
                identName,
                cls.constructors,
                ':',
                out,
                rosettaClass,
            )
        }

        return writtenCount > 0
    }

    protected writeClassFunctions(
        name: string,
        functions: AnalyzedFunction[],
        indexer: string,
        out: string[],
        rosettaClass: RosettaClass | undefined,
    ) {
        const sortedFunctions = this.alphabetize
            ? functions.sort((a, b) => a.name.localeCompare(b.name))
            : functions

        const isMethod = indexer === ':'
        for (const func of sortedFunctions) {
            let rosettaFunc: RosettaFunction | RosettaConstructor | undefined

            let funcName = func.name
            if (func.name === 'new') {
                rosettaFunc = rosettaClass?.constructor
            } else if (rosettaClass) {
                rosettaFunc = isMethod
                    ? rosettaClass.methods?.[func.name]
                    : rosettaClass.staticMethods?.[func.name]
            }

            const fullName = `${name}${indexer}${funcName}`
            this.writeFunction(func, fullName, isMethod, out, rosettaFunc)
        }
    }

    protected writeFunction(
        func: AnalyzedFunction,
        name: string,
        isMethod: boolean,
        out: string[],
        rosettaFunc: RosettaFunction | RosettaConstructor | undefined,
    ) {
        if (out.length > 1) {
            out.push('\n')
        }

        if (rosettaFunc) {
            this.validateRosettaFunction(rosettaFunc, func, isMethod)
            this.writeRosettaFunction(rosettaFunc, name, out, func)
            return
        }

        const prefix = this.getFunctionPrefix(func.parameters, func.returnTypes)
        if (prefix) {
            out.push(prefix)
        }

        out.push('\n')
        out.push(this.getFunctionString(name, func.parameters))
    }

    protected writeGlobalFunctions(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        for (const func of mod.functions) {
            const rosettaFunc = rosettaFile?.functions[func.name]
            this.writeFunction(func, func.name, false, out, rosettaFunc)
        }

        return mod.functions.length > 0
    }

    protected writeLocals(mod: AnalyzedModule, out: string[]): boolean {
        for (const local of mod.locals) {
            let typeString: string | undefined
            const prefix = this.getFunctionPrefixFromExpr(local.expression)

            if (out.length > 1) {
                out.push('\n')
            }

            if (prefix) {
                out.push(prefix)
            } else if (local.types) {
                typeString = this.getTypeString(local.types)
            }

            // write table type annotations on the line above
            if (typeString && this.isLiteralTable(local.expression)) {
                out.push(`\n---@type ${typeString}`)
                typeString = undefined
            }

            const rhs = this.getExpressionString(local.expression)
            if (rhs === 'nil') {
                out.push(`\nlocal ${local.name}`)
            } else {
                out.push(`\nlocal ${local.name} = ${rhs}`)
            }

            if (typeString) {
                out.push(` ---@type ${typeString}`)
            }
        }

        return mod.locals.length > 0
    }

    protected writeNotes(notes: string | undefined, out: string[]) {
        if (!notes) {
            return
        }

        const lines = notes.replaceAll('\r', '').trim().split('\n')
        for (const line of lines) {
            out.push(`\n---${line}`)
        }
    }

    protected writeOverload(overload: AnalyzedFunction, out: string[]) {
        out.push('\n---@overload fun(')

        const params: string[] = []
        for (const param of overload.parameters) {
            params.push(`${param.name}: ${this.getTypeString(param.types)}`)
        }

        out.push(params.join())
        out.push(')')

        const returns: string[] = []
        for (const ret of overload.returnTypes) {
            returns.push(this.getTypeString(ret))
        }

        if (returns.length > 0) {
            out.push(': ')
            out.push(returns.join())
        }
    }

    protected writeRosettaOperators(
        operators: RosettaOperator[] | undefined,
        out: string[],
    ): boolean {
        if (operators === undefined) {
            return false
        }

        for (const op of operators) {
            if (!op.operation || !op.return) {
                continue
            }

            out.push(`\n---@operator ${op.operation}`)
            if (op.parameter) {
                out.push(`(${op.parameter})`)
            }

            out.push(`: ${op.return}`)
        }

        return true
    }

    protected writeRosettaOverloads(
        overloads: RosettaOverload[] | undefined,
        out: string[],
    ): boolean {
        if (overloads === undefined) {
            return false
        }

        for (const overload of overloads) {
            out.push('\n---@overload fun(')

            const params: string[] = []
            for (const param of overload.parameters ?? []) {
                params.push(`${param.name}: ${param.type}`)
            }

            out.push(params.join())
            out.push(')')

            const returns: string[] = []
            for (const ret of overload.return ?? []) {
                if (!ret.type) {
                    continue
                }

                returns.push(ret.type)
            }

            if (returns.length > 0) {
                out.push(': ')
                out.push(returns.join())
            }
        }

        return true
    }

    protected writeReturns(mod: AnalyzedModule, out: string[]): boolean {
        if (mod.returns.length === 0) {
            return false
        }

        const locals: string[] = []
        const returns: string[] = []
        for (let i = 0; i < mod.returns.length; i++) {
            const ret = mod.returns[i]

            if (!ret.expression) {
                const typeString = this.getTypeString(ret.types)
                locals.push(`\nlocal __RETURN${i}__ ---@type ${typeString}`)
                returns.push(`__RETURN${i}__`)
            } else {
                returns.push(this.getExpressionString(ret.expression))
            }
        }

        locals.forEach((x) => out.push(x))

        out.push('\nreturn ')
        out.push(returns.join(', '))

        return true
    }

    protected writeRequires(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        if (mod.requires.length === 0) {
            return false
        }

        let count = 0
        for (const req of mod.requires) {
            const rosettaClass = rosettaFile?.classes[req.name]

            // skip global requires that have a rosetta class defined
            if (rosettaClass) {
                continue
            }

            if (out.length > 1) {
                out.push('\n')
            }

            out.push(`\n${req.name} = require("${req.module}")`)
            count++
        }

        return count > 0
    }

    protected writeRosettaFunction(
        rosettaFunc: RosettaFunction | RosettaConstructor,
        name: string,
        out: string[],
        func: AnalyzedFunction,
    ) {
        if ((rosettaFunc as RosettaFunction).deprecated) {
            out.push(`\n---@deprecated`)
        }

        this.writeNotes(rosettaFunc.notes, out)

        const params = rosettaFunc.parameters ?? []
        for (let i = 0; i < params.length; i++) {
            const param = params[i]
            out.push(`\n---@param ${param.name} ${param.type?.trim()}`)
            if (param.notes) {
                out.push(` ${this.getInlineNotes(param.notes)}`)
            }
        }

        const returns = (rosettaFunc as RosettaFunction).return
        if (returns) {
            for (const ret of returns) {
                if (!ret.type) {
                    continue
                }

                out.push(`\n---@return ${ret.type.trim()}`)

                if (ret.name) {
                    out.push(` ${ret.name}`)
                }

                if (ret.notes) {
                    const prefix = ret.name ? '' : '#'
                    out.push(` ${prefix}${this.getInlineNotes(ret.notes)}`)
                }
            }
        } else {
            for (const ret of func.returnTypes) {
                out.push(`\n---@return ${this.getTypeString(ret)}`)
            }
        }

        this.writeRosettaOverloads(
            (rosettaFunc as RosettaFunction).overloads,
            out,
        )

        out.push('\n')
        out.push(
            this.getFunctionStringFromParamNames(
                name,
                params.map((x) => x.name),
            ),
        )
    }

    protected writeStaticField(
        name: string,
        field: AnalyzedField,
        rosettaField: RosettaField | undefined,
        writtenFields: Set<string>,
        out: string[],
    ) {
        if (writtenFields.has(field.name)) {
            return
        }

        writtenFields.add(field.name)

        let canWriteExpression = true
        let typeString: string | undefined
        if (rosettaField) {
            typeString = rosettaField.type?.trim()
            canWriteExpression = false
            if (rosettaField.notes) {
                out.push('\n')
                this.writeNotes(rosettaField.notes, out)
            }
        } else if (field.expression) {
            const prefix = this.getFunctionPrefixFromExpr(field.expression)

            if (prefix) {
                out.push('\n')
                out.push(prefix)
            }
        } else {
            typeString = this.getTypeString(field.types)
        }

        out.push('\n')
        out.push(name)

        if (!field.name.startsWith('[')) {
            out.push('.')
        }

        const exprString =
            field.expression && canWriteExpression
                ? this.getExpressionString(field.expression)
                : 'nil'

        out.push(`${field.name} = ${exprString}`)

        if (typeString) {
            out.push(` ---@type ${typeString}`)
        }
    }

    protected writeTables(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        let writtenCount = 0
        for (const table of mod.tables) {
            writtenCount++
            const rosettaTable = rosettaFile?.tables?.[table.name]
            const tags = new Set(rosettaTable?.tags ?? [])

            if (!tags.has('NoInitializer')) {
                this.writeNotes(rosettaTable?.notes, out)
                this.writeRosettaOperators(rosettaTable?.operators, out)

                if (!this.writeRosettaOverloads(rosettaTable?.overloads, out)) {
                    for (const overload of table.overloads) {
                        this.writeOverload(overload, out)
                    }
                }

                if (out.length > 1) {
                    out.push('\n')
                }

                out.push('\n')
                if (table.local) {
                    out.push('local ')
                }

                out.push(table.name)
                out.push(' = {}')
            } else if (out.length > 1) {
                out.push('\n')
                out.push('\n')
            }

            const writtenFields = new Set<string>()
            for (const field of table.staticFields) {
                this.writeStaticField(
                    table.name,
                    field,
                    rosettaTable?.staticFields?.[field.name],
                    writtenFields,
                    out,
                )
            }

            for (const func of table.functions) {
                this.writeFunction(
                    func,
                    `${table.name}.${func.name}`,
                    false,
                    out,
                    rosettaTable?.staticMethods?.[func.name],
                )
            }
        }

        return writtenCount > 0
    }

    protected writeTableFields(
        fields: TableField[],
        out: string[],
        depth: number = 1,
        writtenFields?: Set<string>,
    ): Set<string> {
        writtenFields ??= new Set()
        const tab = '    '.repeat(depth)

        let nextAutoKey = 1
        for (const field of fields) {
            let skip = false
            const isRef = field.value.type === 'reference'

            let typeString: string | undefined
            if (field.types && field.types.size > 0 && !isRef) {
                typeString = this.getTypeString(field.types)
            }

            let funcString: string | undefined
            if (!typeString && field.value.type === 'literal') {
                funcString = this.getFunctionPrefixFromExpr(field.value, depth)
            }

            let keyString: string | undefined
            const key = field.key
            switch (key.type) {
                case 'string':
                    keyString = key.name
                    break

                case 'literal':
                    keyString = `[${key.literal}]`
                    if (key.name) {
                        skip = writtenFields.has(key.name)
                        writtenFields.add(key.name)
                    }

                    break

                case 'expression':
                    const exprString = this.getExpressionString(key.expression)
                    if (!exprString) {
                        skip = true
                        break
                    }

                    keyString = `[${exprString}]`
                    break
            }

            if (skip) {
                continue
            } else if (keyString) {
                if (writtenFields.has(keyString)) {
                    continue
                }

                writtenFields.add(keyString)
            } else {
                const autoKey = `[${nextAutoKey}]`
                nextAutoKey++

                if (writtenFields.has(autoKey)) {
                    continue
                }

                writtenFields.add(autoKey)
            }

            const valueString = this.getExpressionString(field.value, depth + 1)

            if (typeString && this.isLiteralTable(field.value)) {
                if (out.length > 1) {
                    out.push('\n')
                }

                out.push('\n')
                out.push(tab)
                out.push(`---@type ${typeString}`)
                typeString = undefined
            } else if (funcString) {
                if (out.length > 1) {
                    out.push('\n')
                }

                out.push(funcString)
                typeString = undefined
            }

            out.push('\n')
            out.push(tab)

            if (keyString) {
                out.push(keyString)
                out.push(' = ')
            }

            out.push(valueString)
            out.push(',')

            if (typeString) {
                out.push(` ---@type ${typeString}`)
            }
        }

        return writtenFields
    }
}
