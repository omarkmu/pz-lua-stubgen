import path from 'path'
import { BaseAnnotator } from '../base'
import { AnnotateArgs, InitializerSettings } from './types'
import { log } from '../logger'

import {
    AnalyzedClass,
    AnalyzedField,
    AnalyzedFunction,
    AnalyzedModule,
    AnalyzedTable,
} from '../analysis'

import {
    RosettaClass,
    RosettaConstructor,
    RosettaField,
    RosettaFile,
    RosettaFunction,
    RosettaOperator,
    RosettaOverload,
    RosettaTable,
} from '../rosetta'

import {
    convertRosettaFile,
    getExpressionString,
    getFunctionPrefix,
    getFunctionPrefixFromExpression,
    getFunctionString,
    getFunctionStringFromParamNames,
    getInlineNotes,
    getRosettaTypeString,
    getTypeString,
    getValueString,
    outputFile,
    time,
    writeNotes,
    writeTableFields,
} from '../helpers'

const PREFIX = '---@meta'
const SCOPES = new Set(['public', 'private', 'protected', 'package'])

/**
 * Handles annotation of Lua files.
 */
export class Annotator extends BaseAnnotator {
    protected alphabetize: boolean
    protected includeKahlua: boolean
    protected strictFields: boolean
    protected allowAmbiguous: boolean
    protected helperPattern: RegExp | undefined

    constructor(args: AnnotateArgs) {
        super(args)

        this.alphabetize = args.alphabetize
        this.includeKahlua = args.includeKahlua
        this.strictFields = args.strictFields
        this.allowAmbiguous = args.ambiguity

        if (args.helperPattern) {
            this.helperPattern = new RegExp(args.helperPattern)
        }
    }

    generateStub(mod: AnalyzedModule) {
        const out = [(mod.prefix ?? PREFIX) + '\n']

        const rosettaFile = this.rosetta.files[mod.id]
        if (rosettaFile?.tags.has('StubGen_Hidden')) {
            return out[0]
        }

        this.writeAliases(out, rosettaFile)

        if (this.writeFields(mod, out, rosettaFile)) {
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
        await this.loadRosetta()

        const modules = await this.getModules()
        const outDir = this.outDirectory

        await time('annotation', async () => {
            for (const mod of modules) {
                const outFile = path.resolve(path.join(outDir, mod.id + '.lua'))

                let typestub: string
                try {
                    typestub = this.generateStub(mod)
                } catch (e) {
                    log.error(
                        `Failed to generate typestub for file '${outFile}': ${e}`,
                    )

                    continue
                }

                try {
                    await outputFile(outFile, typestub)
                } catch (e) {
                    log.error(`Failed to write file '${outFile}': ${e}`)
                }
            }
        })

        const resolvedOutDir = path.resolve(outDir)
        log.info(`Generated stubs at '${resolvedOutDir}'`)

        return modules
    }

    protected checkRosettaFunction(
        rosettaFunc: RosettaFunction | RosettaConstructor,
        name: string | undefined,
        func: AnalyzedFunction,
        isMethod: boolean,
    ) {
        const rosettaParams = rosettaFunc.parameters
        const rosettaCount = rosettaParams?.length ?? 0
        const luaCount = func.parameters.length

        if (luaCount === rosettaCount) {
            return
        }

        // `self` parameter annotation on a method is okay
        if (
            isMethod &&
            rosettaCount === luaCount + 1 &&
            rosettaParams &&
            rosettaParams.find((x) => x.name === 'self')
        ) {
            return
        }

        name ??= (rosettaFunc as RosettaFunction).name ?? func.name
        log.warn(
            `Rosetta ${isMethod ? 'method' : 'function'}` +
                ` '${name}' parameter count doesn't match` +
                ` (lua: ${luaCount}, rosetta: ${rosettaCount})`,
        )
    }

    protected async getKahluaModule(): Promise<AnalyzedModule | undefined> {
        const kahluaDataPath = path.join(__dirname, '../../__kahlua.yml')
        const file = await this.rosetta.loadYamlFile(kahluaDataPath)
        if (!file) {
            log.error(`Failed to load kahlua data from ${kahluaDataPath}`)

            return
        }

        const mod = convertRosettaFile(file)

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

    protected getSafeIdentifier(name: string, dunder = false) {
        name = name.replaceAll('.', '_')
        if (!dunder) {
            return name
        }

        const prefix = name.slice(0, 2)
        if (prefix.toUpperCase() !== prefix) {
            name = name.slice(0, 1).toLowerCase() + name.slice(1)
        }

        return '__' + name
    }

    protected getInitializerSettings(
        element: AnalyzedTable | AnalyzedClass,
        rosettaElement?: RosettaTable | RosettaClass,
        isTable: boolean = false,
    ): InitializerSettings {
        // tag → force skip
        const tags = new Set(rosettaElement?.tags ?? [])
        if (tags.has('StubGen_NoInitializer')) {
            return {
                skipInitializer: true,
                forceLocal: false,
            }
        }

        if (!this.helperPattern?.test(element.name)) {
            return {
                skipInitializer: false,
                forceLocal: false,
            }
        }

        // helper → skip unless forced by content
        // if forced by content, write as local
        const cls = element as AnalyzedClass
        const isForced =
            element.functions.length > 0 ||
            element.methods.length > 0 ||
            element.staticFields.length > 0 ||
            (!isTable &&
                (cls.constructors.length > 0 ||
                    cls.functionConstructors.length > 0 ||
                    cls.setterFields.length > 0))

        if (isForced) {
            return {
                skipInitializer: false,
                forceLocal: true,
            }
        }

        return {
            skipInitializer: true,
            forceLocal: false,
        }
    }

    protected async transformModules(modules: AnalyzedModule[]) {
        await super.transformModules(modules)

        if (!this.includeKahlua) {
            return
        }

        const mod = await this.getKahluaModule()
        if (mod) {
            modules.push(mod)
        }
    }

    protected writeAliases(
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        if (!rosettaFile) {
            return false
        }

        let writtenCount = 0
        for (const alias of rosettaFile.aliases) {
            writtenCount++

            if (out.length > 1) {
                out.push('\n')
            }

            out.push(`\n---@alias ${alias.name}`)

            // simple alias
            const types = alias.types
            if (types.length === 1 && !types[0].notes) {
                out.push(` ${types[0].type}`)
                continue
            }

            for (const aliasType of types) {
                out.push('\n---| ')
                out.push(aliasType.type)

                if (aliasType.notes) {
                    out.push(` ${aliasType.notes}`)
                }
            }
        }

        return writtenCount > 0
    }

    protected writeClasses(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        let writtenCount = 0
        for (const cls of mod.classes) {
            const rosettaClass = rosettaFile?.classes[cls.name]
            if (rosettaClass?.tags?.includes('StubGen_Hidden')) {
                continue
            }

            writtenCount++
            const { skipInitializer, forceLocal } = this.getInitializerSettings(
                cls,
                rosettaClass,
            )

            const identName = this.getSafeIdentifier(
                cls.name,
                cls.local || forceLocal,
            )

            const base = rosettaClass?.extends ?? cls.extends

            const writtenFields = new Set<string>()

            if (out.length > 1) {
                out.push('\n\n')
            }

            // class annotation
            if (rosettaClass?.deprecated) {
                out.push('\n---@deprecated')
            }

            writeNotes(rosettaClass?.notes, out)

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

            this.writeClassFields(cls, writtenFields, out, rosettaClass)

            if (!skipInitializer) {
                // definition
                out.push('\n')

                if (cls.local || forceLocal) {
                    out.push('local ')
                }

                out.push(`${identName} = `)

                if (cls.deriveName && base) {
                    // multiple base classes from Rosetta → just write a table
                    if (base.includes(',')) {
                        out.push('{}')
                    } else {
                        out.push(`${base}:derive("${cls.deriveName}")`)
                    }
                } else if (cls.literalFields.length > 0) {
                    out.push('{')

                    writeTableFields(
                        cls.literalFields,
                        out,
                        this.allowAmbiguous,
                        undefined,
                        writtenFields,
                        rosettaClass?.staticFields,
                    )

                    out.push('\n}')
                } else {
                    out.push('{}')
                }
            }

            // static fields
            const statics = [...cls.staticFields, ...cls.setterFields]
            for (const field of statics) {
                this.writeFieldAssignment(
                    field,
                    rosettaClass?.staticFields?.[field.name],
                    out,
                    identName,
                    writtenFields,
                )
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

    protected writeClassFields(
        cls: AnalyzedClass,
        writtenFields: Set<string>,
        out: string[],
        rosettaClass?: RosettaClass,
    ) {
        const sortedFields = this.alphabetize
            ? [...cls.fields].sort((a, b) => a.name.localeCompare(b.name))
            : cls.fields

        // fields
        for (const field of sortedFields) {
            const rosettaField = rosettaClass?.fields?.[field.name]

            if (rosettaField?.tags?.includes('StubGen_Hidden')) {
                continue
            }

            writtenFields.add(field.name)

            let typeString: string
            let notes: string
            if (rosettaField) {
                typeString = getRosettaTypeString(
                    rosettaField.type,
                    rosettaField.nullable,
                )

                notes = rosettaField.notes ?? ''
            } else {
                typeString = getTypeString(field.types, this.allowAmbiguous)
                notes = ''
            }

            if (notes) {
                notes = ' ' + getInlineNotes(notes)
            }

            let scope = ''
            if (SCOPES.has(field.name) && !/^[a-zA-Z_]/.test(typeString)) {
                scope = ' public'
            }

            out.push(`\n---@field${scope} ${field.name} ${typeString}${notes}`)
        }

        const mutable = rosettaClass?.mutable
        if (mutable || (!this.strictFields && mutable !== false)) {
            out.push('\n---@field [any] any')
        }
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
            if (isMethod && funcName === 'new') {
                rosettaFunc = rosettaClass?.constructors?.[0]
            } else if (rosettaClass) {
                rosettaFunc = isMethod
                    ? rosettaClass.methods?.[funcName]
                    : rosettaClass.staticMethods?.[funcName]
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
    ): boolean {
        const tags = (rosettaFunc as RosettaFunction)?.tags
        if (tags?.includes('StubGen_Hidden')) {
            return false
        }

        if (out.length > 1) {
            out.push('\n')
        }

        if (rosettaFunc) {
            this.checkRosettaFunction(rosettaFunc, name, func, isMethod)
            this.writeRosettaFunction(rosettaFunc, name, func, isMethod, out)
            return true
        }

        const prefix = getFunctionPrefix(
            func.parameters,
            func.returnTypes,
            this.allowAmbiguous,
        )

        if (prefix) {
            out.push(prefix)
        }

        out.push('\n')
        out.push(getFunctionString(name, func.parameters))
        return true
    }

    protected writeGlobalFunctions(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        const initialLen = out.length
        for (const func of mod.functions) {
            const rosettaFunc = rosettaFile?.functions[func.name]
            this.writeFunction(func, func.name, false, out, rosettaFunc)
        }

        return out.length !== initialLen
    }

    protected writeOverload(overload: AnalyzedFunction, out: string[]) {
        out.push('\n---@overload fun(')

        const params: string[] = []
        for (const param of overload.parameters) {
            params.push(`${param.name}: ${getTypeString(param.types)}`)
        }

        out.push(params.join(', '))
        out.push(')')

        const returns: string[] = []
        for (const ret of overload.returnTypes) {
            returns.push(getTypeString(ret))
        }

        if (returns.length > 0) {
            out.push(': ')
            out.push(returns.join(', '))
        }
    }

    protected writeRosettaOperators(
        operators: RosettaOperator[] | undefined,
        out: string[],
    ): boolean {
        if (operators === undefined) {
            return false
        }

        const initialLen = out.length
        for (const op of operators) {
            if (!op.operation || !op.return) {
                continue
            }

            if (op.tags?.includes('StubGen_Hidden')) {
                continue
            }

            out.push(`\n---@operator ${op.operation}`)
            if (op.parameter) {
                out.push(`(${op.parameter})`)
            }

            out.push(`: ${op.return}`)
        }

        return out.length !== initialLen
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

            out.push(params.join(', '))
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
                out.push(returns.join(', '))
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
                const typeString = getTypeString(ret.types, this.allowAmbiguous)

                locals.push(`\nlocal __RETURN${i}__ ---@type ${typeString}`)
                returns.push(`__RETURN${i}__`)
            } else {
                returns.push(
                    getExpressionString(ret.expression, this.allowAmbiguous),
                )
            }
        }

        if (returns.length === 0) {
            return false
        }

        locals.forEach((x) => out.push(x))

        out.push('\nreturn ')
        out.push(returns.join(', '))

        return true
    }

    protected writeFieldAssignment(
        field: AnalyzedField,
        rosettaField: RosettaField | undefined,
        out: string[],
        baseName?: string | undefined,
        writtenFields?: Set<string>,
    ) {
        if (rosettaField?.tags?.includes('StubGen_Hidden')) {
            return
        }

        if (writtenFields) {
            if (writtenFields.has(field.name)) {
                return
            }

            writtenFields.add(field.name)
        }

        if (rosettaField?.notes) {
            if (baseName) {
                out.push('\n')
            }

            writeNotes(rosettaField.notes, out)
        }

        let hasRosettaType = false
        let typeString: string | undefined
        if (rosettaField?.type || rosettaField?.nullable !== undefined) {
            typeString = getRosettaTypeString(
                rosettaField.type,
                rosettaField.nullable,
            )

            hasRosettaType = true
        } else if (field.expression) {
            const prefix = getFunctionPrefixFromExpression(
                field.expression,
                this.allowAmbiguous,
            )

            if (prefix) {
                out.push('\n')
                out.push(prefix)
            }
        } else {
            typeString = getTypeString(field.types, this.allowAmbiguous)
        }

        out.push('\n')
        if (baseName) {
            out.push(baseName)

            if (!field.name.startsWith('[')) {
                out.push('.')
            }
        }

        let valueString: string
        ;[valueString, typeString] = getValueString(
            field.expression,
            rosettaField,
            typeString,
            hasRosettaType,
            this.allowAmbiguous,
            false,
        )

        out.push(`${field.name} = ${valueString}`)

        if (typeString) {
            out.push(` ---@type ${typeString}`)
        }
    }

    protected writeFields(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        if (mod.fields.length === 0) {
            return false
        }

        let count = 0
        for (const field of mod.fields) {
            const clsOrTable =
                rosettaFile?.classes[field.name] ??
                rosettaFile?.tables[field.name]

            // classes & tables take precendence over fields
            if (clsOrTable) {
                continue
            }

            const rosettaField = rosettaFile?.fields[field.name]
            if (rosettaField?.tags?.includes('StubGen_Hidden')) {
                continue
            }

            if (out.length > 1 && !rosettaField?.notes) {
                out.push('\n')
            }

            this.writeFieldAssignment(field, rosettaField, out)

            count++
        }

        return count > 0
    }

    protected writeRosettaFunction(
        rosettaFunc: RosettaFunction | RosettaConstructor,
        name: string,
        func: AnalyzedFunction,
        isMethod: boolean,
        out: string[],
    ) {
        if ((rosettaFunc as RosettaFunction).deprecated) {
            out.push(`\n---@deprecated`)
        }

        writeNotes(rosettaFunc.notes, out)

        let params = rosettaFunc.parameters ?? []
        for (let i = 0; i < params.length; i++) {
            const param = params[i]
            if (
                !param.type &&
                !param.optional &&
                !param.nullable &&
                !param.notes
            ) {
                continue
            }

            const type = getRosettaTypeString(
                param.type,
                param.optional,
                param.nullable,
            )

            // skip `---@param x unknown` if there are no details
            if (param.name !== '...' && type === 'unknown' && !param.notes) {
                continue
            }

            out.push(`\n---@param ${param.name.trim()} ${type}`)
            if (param.notes) {
                out.push(` ${getInlineNotes(param.notes)}`)
            }
        }

        const returns = (rosettaFunc as RosettaFunction).return
        if (returns) {
            for (const ret of returns) {
                if (!ret.type && !ret.nullable && !ret.name && !ret.notes) {
                    continue
                }

                const type = getRosettaTypeString(ret.type, ret.nullable)
                out.push(`\n---@return ${type}`)

                if (ret.name) {
                    out.push(` ${ret.name.trim()}`)
                }

                if (ret.notes) {
                    const prefix = ret.name ? '' : '#'
                    out.push(` ${prefix}${getInlineNotes(ret.notes)}`)
                }
            }
        } else {
            for (const ret of func.returnTypes) {
                out.push(
                    `\n---@return ${getTypeString(ret, this.allowAmbiguous)}`,
                )
            }
        }

        this.writeRosettaOverloads(
            (rosettaFunc as RosettaFunction).overloads,
            out,
        )

        if (isMethod) {
            params = params.filter((x) => x.name !== 'self')
        }

        out.push('\n')
        out.push(
            getFunctionStringFromParamNames(
                name,
                params.map((x) => x.name),
            ),
        )
    }

    protected writeTables(
        mod: AnalyzedModule,
        out: string[],
        rosettaFile: RosettaFile | undefined,
    ): boolean {
        let writtenCount = 0
        for (const table of mod.tables) {
            const rosettaTable = rosettaFile?.tables?.[table.name]
            if (rosettaTable?.tags?.includes('StubGen_Hidden')) {
                continue
            }

            writtenCount++

            const { skipInitializer, forceLocal } = this.getInitializerSettings(
                table,
                rosettaTable,
                true,
            )

            const identName =
                table.local || forceLocal
                    ? this.getSafeIdentifier(table.name)
                    : table.name

            if (!skipInitializer) {
                writeNotes(rosettaTable?.notes, out)
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

                out.push(identName)
                out.push(' = {}')
            } else if (out.length > 1) {
                out.push('\n\n')
            }

            const writtenFields = new Set<string>()
            for (const field of table.staticFields) {
                this.writeFieldAssignment(
                    field,
                    rosettaTable?.staticFields?.[field.name],
                    out,
                    table.name,
                    writtenFields,
                )
            }

            for (const func of table.functions) {
                this.writeFunction(
                    func,
                    `${identName}.${func.name}`,
                    false,
                    out,
                    rosettaTable?.staticMethods?.[func.name],
                )
            }

            for (const func of table.methods) {
                this.writeFunction(
                    func,
                    `${identName}:${func.name}`,
                    false,
                    out,
                    rosettaTable?.methods?.[func.name],
                )
            }
        }

        return writtenCount > 0
    }
}
