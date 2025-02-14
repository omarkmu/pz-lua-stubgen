import path from 'path'
import YAML from 'yaml'
import { log } from '../logger'
import { BaseAnnotator } from '../base'
import { AnalyzedModule } from '../analysis/types'
import { RosettaGenerateArgs } from './types'
import {
    convertAnalyzedClass,
    convertAnalyzedFields,
    convertAnalyzedFunctions,
    convertAnalyzedTable,
    outputFile,
    time,
} from '../helpers'

export class RosettaGenerator extends BaseAnnotator {
    protected rosettaFormat: 'json' | 'yml'
    protected keepTypes: boolean

    constructor(args: RosettaGenerateArgs) {
        super(args)

        this.keepTypes = args.keepTypes ?? false
        this.rosettaFormat = args.format ?? 'yml'
    }

    generateRosetta(mod: AnalyzedModule): string {
        const rosettaFile = this.rosetta.files[mod.id]

        const classes: Record<string, any> = {}
        for (const cls of mod.classes) {
            const converted: any = convertAnalyzedClass(
                cls,
                rosettaFile?.classes[cls.name],
                this.keepTypes,
            )

            delete converted.name
            classes[cls.name] = converted
        }

        const tables: Record<string, any> = {}
        for (const table of mod.tables) {
            const converted: any = convertAnalyzedTable(
                table,
                rosettaFile?.tables[table.name],
                this.keepTypes,
            )

            delete converted.name
            tables[table.name] = converted
        }

        const luaData: any = {}
        if (mod.tables.length > 0) {
            luaData.tables = tables
        }

        if (mod.classes.length > 0) {
            luaData.classes = classes
        }

        if (mod.functions.length > 0) {
            luaData.functions = convertAnalyzedFunctions(
                mod.functions,
                rosettaFile?.functions,
                this.keepTypes,
            )
        }

        if (mod.fields.length > 0) {
            luaData.fields = convertAnalyzedFields(
                mod.fields,
                rosettaFile?.fields,
                this.keepTypes,
            )
        }

        const data: any = {
            version: '1.1',
            languages: {
                lua: luaData,
            },
        }

        let out: string
        const format = this.rosettaFormat
        if (format === 'json') {
            out = JSON.stringify(data, undefined, 2)
        } else {
            out = YAML.stringify(data)
        }

        return out.replaceAll('\r', '').trimEnd() + '\n'
    }

    async run() {
        const modules = await this.getModules(true)
        await this.writeModules(modules)

        const resolvedOutDir = path.resolve(this.outDirectory)
        log.info(`Generated Rosetta data at '${resolvedOutDir}'`)

        return modules
    }

    protected async writeModules(
        modules: AnalyzedModule[],
        taskName = 'Rosetta initialization',
    ) {
        await time(taskName, async () => {
            const outDir = this.outDirectory
            const suffix = this.rosettaFormat === 'json' ? '.json' : '.yml'

            for (const mod of modules) {
                const outFile = path.resolve(
                    path.join(outDir, this.rosettaFormat, mod.id + suffix),
                )

                let data: string
                try {
                    data = this.generateRosetta(mod)
                } catch (e) {
                    log.error(
                        `Failed to generate Rosetta data for file '${outFile}': ${e}`,
                    )

                    continue
                }

                try {
                    await outputFile(outFile, data)
                } catch (e) {
                    log.error(`Failed to write file '${outFile}': ${e}`)
                }
            }
        })
    }
}
