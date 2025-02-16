import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import {
    RosettaAlias,
    RosettaAliasType,
    RosettaArgs,
    RosettaClass,
    RosettaField,
    RosettaFile,
    RosettaFunction,
    RosettaTable,
} from './types'
import {
    arrayToRecord,
    expect,
    expectField,
    getFileIdentifier,
    readFileContents,
    time,
} from '../helpers'
import { log } from '../logger'

type DataReader = (text: string) => any

export class Rosetta {
    readonly files: Record<string, RosettaFile>

    protected inputDirectory: string
    protected loaded: boolean = false

    constructor(args: RosettaArgs) {
        this.inputDirectory = args.inputDirectory

        this.files = {}
    }

    async load(dir?: string): Promise<boolean> {
        const targetDir = dir ?? this.inputDirectory
        return time(
            'loading Rosetta',
            async () => {
                if (await this.loadJSON(dir)) {
                    log.verbose(`Using JSON Rosetta data from '${targetDir}'`)
                    return true
                }

                if (await this.loadYAML(dir)) {
                    log.verbose(`Using YAML Rosetta data from '${targetDir}'`)
                    return true
                }

                return false
            },
            (result) => {
                if (!result) {
                    return `Failed to find Rosetta definitions in '${targetDir}'`
                }
            },
        )
    }

    async loadJSON(dir?: string): Promise<boolean> {
        return await this.loadFiles('json', dir)
    }

    async loadJsonFile(
        filePath: string,
        basePath?: string,
    ): Promise<RosettaFile | undefined> {
        return await this.loadFile(
            filePath,
            basePath ?? path.dirname(filePath),
            JSON.parse,
            ['.json'],
        )
    }

    async loadYAML(dir?: string): Promise<boolean> {
        return await this.loadFiles('yml', dir)
    }

    async loadYamlFile(
        filePath: string,
        basePath?: string,
    ): Promise<RosettaFile | undefined> {
        return await this.loadFile(
            filePath,
            basePath ?? path.dirname(filePath),
            YAML.parse,
            ['.yml', '.yaml'],
        )
    }

    readData(data: any, id: string, filename: string): RosettaFile | undefined {
        expect(data, 'object')

        expectField(data, 'version', 'string', false)
        if (data.version !== '1.1') {
            throw new Error(`Unexpected version '${data.version}'`)
        }

        // no Lua data → ignore
        if (!expectField(data, 'languages.lua', 'object')) {
            return
        }

        const lua = data.languages.lua

        const aliases: RosettaAlias[] = []
        if (expectField(data, 'languages.lua.aliases', 'object')) {
            for (const name of Object.keys(lua.aliases)) {
                const arr = lua.aliases[name]
                expect(arr, 'array', `alias '${name}'`)

                const types: RosettaAliasType[] = []
                for (let i = 0; i < arr.length; i++) {
                    const alias = arr[i]
                    expect(
                        alias.type,
                        'string',
                        `'type' field of alias '${name}' at index ${i}`,
                    )

                    types.push(alias)
                }

                if (types.length === 0) {
                    continue
                }

                aliases.push({ name, types })
            }
        }

        const classes: Record<string, RosettaClass> = {}
        if (expectField(data, 'languages.lua.classes', 'object')) {
            for (const name of Object.keys(lua.classes)) {
                const obj = lua.classes[name]
                expect(obj, 'object', `class '${name}'`)

                const cls = obj as RosettaClass
                cls.name = name
                cls.methods = arrayToRecord(obj.methods)
                cls.staticMethods = arrayToRecord(obj.staticMethods)

                classes[name] = cls
            }
        }

        const tables: Record<string, RosettaTable> = {}
        if (expectField(data, 'languages.lua.tables', 'object')) {
            for (const name of Object.keys(lua.tables)) {
                const obj = lua.tables[name]
                expect(obj, 'object', `table '${name}'`)

                const tab = obj as RosettaTable
                tab.name = name
                tab.methods = arrayToRecord(obj.methods)
                tab.staticMethods = arrayToRecord(obj.staticMethods)

                tables[name] = tab
            }
        }

        const fields: Record<string, RosettaField> = {}
        if (expectField(data, 'languages.lua.fields', 'object')) {
            for (const name of Object.keys(lua.fields)) {
                const obj = lua.fields[name]
                expect(obj, 'object', `field '${name}'`)

                fields[name] = obj
            }
        }

        const functions: Record<string, RosettaFunction> = {}
        if (expectField(data, 'languages.lua.functions', 'array')) {
            for (let i = 0; i < lua.functions.length; i++) {
                const obj = lua.functions[i]
                expect(obj, 'object', `value at index ${i} of function list`)

                functions[obj.name] = obj
            }
        }

        const tags = new Set<string>()
        if (expectField(data, 'languages.lua.tags', 'array')) {
            for (let i = 0; i < lua.tags.length; i++) {
                const tag = lua.tags[i]
                expect(tag, 'string', `value at index ${i} of tags list`)

                tags.add(tag)
            }
        }

        if (tags.has('StubGen_Definitions')) {
            for (const cls of Object.values(classes)) {
                if (cls.local) {
                    continue
                }

                cls.tags ??= []
                cls.tags.push('StubGen_NoInitializer')
            }
        }

        const file: RosettaFile = {
            id,
            filename,
            aliases,
            classes,
            tables,
            functions,
            fields,
            tags,
        }

        this.files[id] = file
        return file
    }

    protected async loadFile(
        filePath: string,
        basePath: string,
        reader: DataReader,
        extensions: string[],
    ): Promise<RosettaFile | undefined> {
        try {
            const content = await readFileContents(filePath)
            const data = reader(content)
            const id = getFileIdentifier(filePath, basePath, extensions)
            return this.readData(data, id, path.resolve(filePath))
        } catch (e) {
            log.error(`Failed to read Rosetta file '${filePath}': ${e}`)
        }
    }

    protected async loadFiles(type: string, dir?: string): Promise<boolean> {
        const basePath = `${dir ?? this.inputDirectory}/${type}`
        if (!fs.existsSync(basePath) || !fs.statSync(basePath).isDirectory) {
            return false
        }

        let reader: DataReader
        let extensions: string[] = []
        switch (type) {
            case 'json':
                extensions = ['.json']
                reader = JSON.parse
                break

            case 'yml':
                extensions = ['.yml', '.yaml']
                reader = YAML.parse
                break

            default:
                return false
        }

        const stack = [basePath]
        while (stack.length > 0) {
            const dirPath = stack.pop()!

            try {
                const dir = await fs.promises.opendir(dirPath)

                for await (const fileOrDir of dir) {
                    const childPath = path.join(dirPath, fileOrDir.name)

                    if (fileOrDir.isDirectory()) {
                        stack.push(childPath)
                        continue
                    }

                    if (!fileOrDir.isFile()) {
                        continue
                    }

                    const extname = path.extname(childPath)
                    if (!extensions.includes(extname)) {
                        continue
                    }

                    await this.loadFile(childPath, basePath, reader, extensions)
                }
            } catch (e) {
                log.error(`Failed to read Rosetta directory '${dirPath}': ${e}`)
            }
        }

        return true
    }
}
