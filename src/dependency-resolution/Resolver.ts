import fs from 'fs'
import path from 'path'
import { log } from '../logger'
import { Deque } from '@datastructures-js/deque'
import { BaseReporter } from '../base'
import { DependencyReader } from './DependencyReader'
import { LuaDependencies, LuaDependencyInfoMap, ResolveArgs } from './types'
import { getAliasMap, getFileIdentifier, time } from '../helpers'

/**
 * Handles determination of dependencies between files.
 */
export class Resolver extends BaseReporter {
    protected reader: DependencyReader
    protected infoMap: LuaDependencyInfoMap
    protected setters: Record<string, Set<string>>

    constructor(args: ResolveArgs) {
        super(args)

        this.setters = {}
        this.infoMap = {
            reads: {},
            writes: {},
            requires: {},
        }

        this.reader = new DependencyReader()
    }

    /**
     * Runs dependency resolution on the given directory.
     * @returns The order to read files for analysis.
     */
    async run() {
        this.resetState()

        const order = await time('dependency resolution', async () => {
            await this.readDirectories()
            return this.getAnalysisOrder()
        })

        return order
    }

    /**
     * Reports on the global reads, writes, and requires in the given directory.
     */
    async generateReport() {
        const order = await this.run()

        const globalReads = this.getAllGlobalReads()
        const report = this.infoMap as any
        report.analysisOrder = order
        report.uniqueReads = globalReads.size
        report.uniqueWrites = this.getAllGlobalWrites().size
        report.neverSetReads = this.getNeverSetGlobals(globalReads).size

        await this.outputReport(report)
    }

    /**
     * Gets the set of globals that were read by all files.
     */
    protected getAllGlobalReads(): Set<string> {
        return this.mergeSets(Object.values(this.infoMap.reads))
    }

    /**
     * Gets the set of globals that were written by all files.
     */
    protected getAllGlobalWrites(): Set<string> {
        return this.mergeSets(Object.values(this.infoMap.writes))
    }

    /**
     * Gets the order to read files for analysis based on their explicit and implicit dependencies.
     */
    protected getAnalysisOrder(): string[] {
        const subdirFileLists = this.groupFilesBySubdirectory()

        const order = new Set<string>()
        const seen = new Set<string>()
        const aliases = getAliasMap(this.fileSet)

        for (const [i, files] of subdirFileLists.entries()) {
            if (files.length === 0) {
                continue
            }

            // case-insensitive ASCII order; reverse sorting to treat as a stack
            files.sort((a, b) =>
                a.toLocaleUpperCase() < b.toLocaleUpperCase() ? 1 : -1,
            )

            const subdir = this.subdirectories[i] ?? ''
            const deque = new Deque<string>([files.pop()!])
            while (deque.size() > 0) {
                const file = deque.popFront()
                seen.add(file)

                if (order.has(file)) {
                    // already in analysis order; process next file
                    const nextFile = files.pop()
                    if (nextFile) {
                        deque.pushBack(nextFile)
                    }

                    continue
                }

                // file not in order; check dependencies
                const depsToAdd: string[] = []
                const deps = this.getFileDependencies(file, subdir, aliases)

                deps.explicit.push(...deps.implicit)
                for (const dep of deps.explicit) {
                    if (!order.has(dep) && !seen.has(dep)) {
                        depsToAdd.push(dep)
                    }
                }

                if (depsToAdd.length > 0) {
                    // add dependencies, followed by this element
                    // this will try to load this element again after dependencies

                    deque.pushFront(file)
                    for (const dep of depsToAdd) {
                        deque.pushFront(dep)
                    }
                } else {
                    order.add(file)

                    // process the next file
                    const nextFile = files.pop()
                    if (nextFile) {
                        deque.pushBack(nextFile)
                    }
                }
            }
        }

        return [...order]
    }

    /**
     * Gets dependencies for a file.
     */
    protected getFileDependencies(
        identifier: string,
        subdir: string,
        aliases: Map<string, Set<string>>,
    ): LuaDependencies {
        const explicit: string[] = []
        const implicit: string[] = []

        const requires = this.infoMap.requires[identifier]
        if (requires) {
            for (const requiredFile of requires) {
                if (this.fileSet.has(requiredFile)) {
                    explicit.push(requiredFile)
                    continue
                }

                // unknown; check for alias
                const aliasSet = aliases.get(requiredFile)
                if (!aliasSet) {
                    continue
                }

                if (aliasSet.size === 1) {
                    const [first] = aliasSet
                    explicit.push(first)
                    continue
                }

                // if multiple identifiers share an alias, match on the subdirectory
                const matches = []
                for (const alias of aliasSet) {
                    if (alias.startsWith(subdir)) {
                        matches.push(alias)
                    }
                }

                // if none match, add all aliases
                if (matches.length === 0) {
                    explicit.push(...aliasSet)
                    continue
                }

                // if multiple match, add all matches
                explicit.push(...matches)
            }
        }

        const reads = this.infoMap.reads[identifier]
        if (reads) {
            for (const value of reads) {
                const setters = this.setters[value]
                if (!setters || setters.size === 0) {
                    // unset or unknown; doesn't affect implicit deps
                    continue
                }

                implicit.push(...setters)
            }
        }

        const explicitSet = new Set(explicit)
        return {
            explicit: explicit.filter((x) => x !== identifier),
            implicit: implicit.filter(
                (x) => x !== identifier && !explicitSet.has(x),
            ),
        }
    }

    /**
     * Returns a set of globals that were never set.
     * @param reads The set of reads to use. If not given, this will use all global reads.
     */
    protected getNeverSetGlobals(reads?: Set<string>): Set<string> {
        if (!reads) {
            reads = this.getAllGlobalReads()
        }

        const neverSet = new Set<string>()
        for (const value of reads.values()) {
            if (!this.setters[value]) {
                neverSet.add(value)
            }
        }

        return neverSet
    }

    /**
     * Groups files into separate arrays based on the subdirectory they belong to.
     */
    protected groupFilesBySubdirectory(): string[][] {
        const subdirPrefixes: string[] = []
        const subdirFiles: string[][] = []
        for (const subdir of this.subdirectories) {
            subdirFiles.push([])
            subdirPrefixes.push(subdir + '/')
        }

        const otherFiles: string[] = []
        for (const identifier of this.fileSet) {
            let targetArray: string[] | undefined
            for (const [i, prefix] of subdirPrefixes.entries()) {
                if (identifier.startsWith(prefix)) {
                    targetArray = subdirFiles[i]
                    break
                }
            }

            if (targetArray === undefined) {
                targetArray = otherFiles
            }

            targetArray.push(identifier)
        }

        subdirFiles.push(otherFiles)
        return subdirFiles
    }

    /**
     * Merges an array of sets into a single set.
     */
    protected mergeSets<T>(sets: Set<T>[]): Set<T> {
        const merged = new Set<T>()

        for (const set of sets) {
            for (const value of set.values()) {
                merged.add(value)
            }
        }

        return merged
    }

    /**
     * Reads the Lua files in the given directories.
     */
    protected async readDirectories() {
        for (const dirPath of this.getScanDirectories()) {
            await this.readDirectory(dirPath)
        }
    }

    /**
     * Reads the files in a given directory, descending the directory tree.
     */
    protected async readDirectory(baseDirPath: string) {
        const stack = [baseDirPath]

        while (stack.length > 0) {
            const dirPath = stack.pop()!

            try {
                const dir = await fs.promises.opendir(dirPath)

                for await (const fileOrDir of dir) {
                    const childPath = path.join(dirPath, fileOrDir.name)

                    if (fileOrDir.isDirectory()) {
                        stack.push(childPath)
                    }

                    if (
                        !fileOrDir.isFile() ||
                        path.extname(childPath) !== '.lua'
                    ) {
                        continue
                    }

                    await this.readFile(childPath)
                }
            } catch (e) {
                log.error(`Failed to read directory '${dirPath}': ${e}`)
            }
        }
    }

    /**
     * Collects global reads and writes, and requires for a given file.
     * @param filePath
     */
    protected async readFile(filePath: string) {
        const identifier = getFileIdentifier(filePath, this.inDirectory)

        try {
            if (this.fileSet.has(identifier)) {
                throw new Error('Duplicate file identifier')
            }

            this.fileSet.add(identifier)

            const info = await this.reader.getDependencyInfo(filePath)
            if (!info) {
                return
            }

            if (info.reads.size > 0) {
                this.infoMap.reads[identifier] = info.reads
            }

            if (info.writes.size > 0) {
                this.infoMap.writes[identifier] = info.writes

                for (const global of info.writes) {
                    if (!this.setters[global]) {
                        this.setters[global] = new Set()
                    }

                    this.setters[global].add(identifier)
                }
            }

            if (info.requires.size > 0) {
                this.infoMap.requires[identifier] = info.requires
            }
        } catch (e) {
            log.error(`Failed to read file '${filePath}': ${e}`)
        }
    }

    /**
     * Resets the state of the resolver.
     */
    protected resetState() {
        super.resetState()
        this.setters = {}
        this.infoMap = {
            reads: {},
            writes: {},
            requires: {},
        }
    }
}
