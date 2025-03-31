import fs from 'fs'
import path from 'path'
import { log } from '../logger'
import { RosettaGenerator } from './RosettaGenerator'
import { AnalyzedField, AnalyzedFunction, AnalyzedModule } from '../analysis'

import {
    convertAnalyzedParameter,
    expressionToDefaultValue,
    time,
} from '../helpers'

import {
    RosettaClass,
    RosettaConstructor,
    RosettaField,
    RosettaFile,
    RosettaFunction,
    RosettaParameter,
    RosettaUpdateArgs,
} from './types'

export class RosettaUpdater extends RosettaGenerator {
    protected rosettaDir: string
    protected deleteUnknown: boolean
    protected extraFiles: Set<string>

    constructor(args: RosettaUpdateArgs) {
        const rosettaDir = args.rosetta ?? args.outputDirectory
        delete args.rosetta

        super(args)

        this.rosettaDir = rosettaDir
        this.deleteUnknown = args.deleteUnknown ?? true
        this.extraFiles = new Set(args.extraFiles)
    }

    async run() {
        const modules = await this.getModules(true)

        let isUpdate = true
        if (await this.rosetta.load(this.rosettaDir)) {
            await time('updating Rosetta data', async () =>
                this.update(modules),
            )
        } else {
            isUpdate = false
            log.warn(`No Rosetta data to update; initializing data`)
        }

        await this.writeModules(modules, 'rewriting data', this.extraFiles)

        const resolvedOutDir = path.resolve(this.outDirectory)
        log.info(
            `${isUpdate ? 'Updated' : 'Generated'} Rosetta data at '${resolvedOutDir}'`,
        )

        return modules
    }

    protected async update(modules: AnalyzedModule[]) {
        for (const mod of modules) {
            if (this.extraFiles.has(mod.id)) {
                continue
            }

            const file = this.rosetta.files[mod.id]
            if (!file) {
                continue
            }

            this.updateClasses(mod, file)

            this.updateTables(mod, file)

            this.updateFunctions(
                mod.id,
                'function',
                mod.functions,
                file.functions,
            )

            this.updateFields(mod.id, mod.fields, file.fields)
        }

        const moduleIds = new Set(modules.map((x) => x.id))

        const toDelete = new Set<RosettaFile>()
        for (const file of Object.values(this.rosetta.files)) {
            if (moduleIds.has(file.id) || this.extraFiles.has(file.id)) {
                continue
            }

            if (file.tags.has('StubGen_Definitions')) {
                // don't rewrite definition files
                delete this.rosetta.files[file.id]
                continue
            }

            const filename = file.filename
            if (!filename || !this.deleteUnknown) {
                log.warn(`Found unknown file in Rosetta data: '${file.id}'`)
                continue
            }

            toDelete.add(file)
        }

        for (const file of toDelete) {
            delete this.rosetta.files[file.id]

            try {
                await fs.promises.unlink(file.filename!)
                log.verbose(`Deleted Rosetta data file '${file.id}'`)
            } catch (e) {
                log.error(
                    `Failed to delete Rosetta data file '${file.id}': ${e}`,
                )
            }
        }

        await this.transformModules(modules)
    }

    protected updateClasses(mod: AnalyzedModule, file: RosettaFile) {
        const clsMap = new Map(mod.classes.map((x) => [x.name, x]))

        const toDelete = new Set<string>()
        for (const rosettaCls of Object.values(file.classes)) {
            const cls = clsMap.get(rosettaCls.name)
            if (!cls) {
                if (this.deleteUnknown) {
                    toDelete.add(rosettaCls.name)
                    log.debug(
                        `Deleted unknown class '${rosettaCls.name}' from '${mod.id}'`,
                    )
                } else {
                    log.warn(
                        `Found unknown class '${rosettaCls.name}' in '${mod.id}'`,
                    )
                }

                continue
            }

            this.updateConstructors(mod.id, cls.constructors, rosettaCls)

            this.updateFunctions(
                mod.id,
                'method',
                cls.methods,
                rosettaCls.methods,
                rosettaCls.name,
            )

            this.updateFunctions(
                mod.id,
                'function',
                [...cls.functions, ...cls.functionConstructors],
                rosettaCls.staticMethods,
                rosettaCls.name,
            )

            this.updateFields(
                mod.id,
                cls.fields,
                rosettaCls.fields,
                rosettaCls.name,
                false,
            )

            this.updateFields(
                mod.id,
                [...cls.staticFields, ...cls.setterFields],
                rosettaCls.staticFields,
                rosettaCls.name,
            )
        }

        for (const name of toDelete) {
            delete file.classes[name]
        }
    }

    protected updateConstructors(
        moduleId: string,
        constructors: AnalyzedFunction[],
        rosettaCls: RosettaClass,
    ) {
        if (!rosettaCls.constructors) {
            return
        }

        const clsName = rosettaCls.name
        const count = rosettaCls.constructors.length
        if (count > 1) {
            if (this.deleteUnknown) {
                rosettaCls.constructors.splice(1)
                log.debug(
                    `Deleted extra constructors from class '${clsName}' in '${moduleId}'`,
                )
            } else {
                log.warn(
                    `Found extra constructors in class '${clsName}', in '${moduleId}'`,
                )
            }
        }

        const rosettaCons = rosettaCls.constructors[0]
        if (!rosettaCons) {
            return
        }

        const cons = constructors[0]
        if (!cons) {
            if (this.deleteUnknown) {
                delete rosettaCls.constructors
                log.debug(
                    `Deleted constructor from class '${clsName}' in '${moduleId}'`,
                )
            } else {
                log.warn(
                    `Found unknown constructor in class '${clsName}', in '${moduleId}'`,
                )
            }

            return
        }

        this.updateParameters(
            moduleId,
            `'${clsName}' constructor`,
            cons,
            rosettaCons,
        )
    }

    protected updateFields(
        moduleId: string,
        fields: AnalyzedField[],
        rosettaFields: Record<string, RosettaField> | undefined,
        parentName?: string,
        updateDefault = true,
    ) {
        if (!rosettaFields) {
            return
        }

        const toDelete = new Set<string>()
        const fieldMap = new Map(fields.map((x) => [x.name, x]))
        for (const [name, rosettaField] of Object.entries(rosettaFields)) {
            let fullName = name
            if (parentName) {
                fullName = `${parentName}.${name}`
            }

            const field = fieldMap.get(name)
            if (!field) {
                if (this.deleteUnknown) {
                    toDelete.add(name)
                    log.debug(
                        `Deleted unknown field '${fullName}' from '${moduleId}'`,
                    )
                } else {
                    log.warn(
                        `Found unknown field '${fullName}' in '${moduleId}'`,
                    )
                }

                continue
            }

            if (updateDefault && field.expression) {
                const expr = expressionToDefaultValue(field.expression)

                if (expr && expr !== rosettaField.defaultValue) {
                    rosettaField.defaultValue = expr

                    log.debug(
                        `Updated default value for field '${fullName}' in '${moduleId}'`,
                    )
                }
            }
        }

        for (const name of toDelete) {
            delete rosettaFields[name]
        }
    }

    protected updateFunctions(
        moduleId: string,
        type: 'method' | 'function',
        funcs: AnalyzedFunction[],
        rosettaFuncs: Record<string, RosettaFunction> | undefined,
        parentName?: string,
    ) {
        if (!rosettaFuncs) {
            return
        }

        const toDelete = new Set<string>()
        const funcMap = new Map(funcs.map((x) => [x.name, x]))
        for (const rosettaFunc of Object.values(rosettaFuncs)) {
            let fullName = rosettaFunc.name
            if (parentName) {
                const indexer = type === 'method' ? ':' : '.'
                fullName = `${parentName}${indexer}${rosettaFunc.name}`
            }

            const func = funcMap.get(rosettaFunc.name)
            if (!func) {
                if (this.deleteUnknown) {
                    toDelete.add(rosettaFunc.name)
                    log.debug(
                        `Deleted unknown ${type} '${fullName}' from '${moduleId}'`,
                    )
                } else {
                    log.warn(
                        `Found unknown ${type} '${fullName}' in '${moduleId}'`,
                    )
                }

                continue
            }

            this.updateParameters(moduleId, `'${fullName}'`, func, rosettaFunc)
        }

        for (const name of toDelete) {
            delete rosettaFuncs[name]
        }
    }

    protected updateParameters(
        moduleId: string,
        funcName: string,
        func: AnalyzedFunction,
        rosettaFunc: RosettaFunction | RosettaConstructor,
    ) {
        const params = rosettaFunc.parameters ?? []

        const unknown: RosettaParameter[] = []
        const paramSet = new Set(func.parameters.map((x) => x.name))
        for (const param of params) {
            if (paramSet.has(param.name)) {
                continue
            }

            if (this.deleteUnknown) {
                log.debug(
                    `Deleted unknown parameter '${param.name}' from ${funcName} in '${moduleId}'`,
                )

                continue
            }

            unknown.push(param)
            log.warn(
                `Found unknown parameter '${param.name}' in ${funcName}, in '${moduleId}'`,
            )
        }

        const updated: RosettaParameter[] = []
        const rosettaParamMap = new Map(params.map((x) => [x.name, x]))
        for (const param of func.parameters) {
            let rosettaParam = rosettaParamMap.get(param.name)
            if (!rosettaParam) {
                rosettaParam = convertAnalyzedParameter(param)
                log.debug(
                    `Added new parameter '${param.name}' to ${funcName} in '${moduleId}'`,
                )
            }

            updated.push(rosettaParam)
        }

        updated.push(...unknown)

        if (updated.length > 0) {
            rosettaFunc.parameters = updated
        } else {
            delete rosettaFunc.parameters
        }
    }

    protected updateTables(mod: AnalyzedModule, file: RosettaFile) {
        const tableMap = new Map(mod.tables.map((x) => [x.name, x]))

        const toDelete = new Set<string>()
        for (const rosettaTable of Object.values(file.tables)) {
            const table = tableMap.get(rosettaTable.name)
            if (!table) {
                if (this.deleteUnknown) {
                    toDelete.add(rosettaTable.name)
                    log.debug(
                        `Deleted unknown table '${rosettaTable.name}' from '${mod.id}'`,
                    )
                } else {
                    log.warn(
                        `Found unknown table '${rosettaTable.name}' in '${mod.id}'`,
                    )
                }

                continue
            }

            this.updateFunctions(
                mod.id,
                'method',
                table.methods,
                rosettaTable.methods,
                rosettaTable.name,
            )

            this.updateFunctions(
                mod.id,
                'function',
                table.functions,
                rosettaTable.staticMethods,
                rosettaTable.name,
            )

            this.updateFields(
                mod.id,
                table.staticFields,
                rosettaTable.staticFields,
                rosettaTable.name,
            )
        }

        for (const name of toDelete) {
            delete file.tables[name]
        }
    }
}
