import path from 'path'
import { log } from '../logger'
import { BaseArgs } from './types'

export class Base {
    protected inDirectory: string
    protected subdirectories: string[]

    private static updatedLogLevel: boolean = false

    constructor(args: BaseArgs) {
        this.inDirectory = args.inputDirectory
            ? path.normalize(args.inputDirectory)
            : ''

        this.subdirectories = args.subdirectories ?? [
            'shared',
            'client',
            'server',
        ]

        if (args.allSubdirectories) {
            this.subdirectories = []
        } else {
            this.subdirectories = this.subdirectories.filter(
                (x) => x && x !== '',
            )
        }

        if (!Base.updatedLogLevel) {
            Base.updatedLogLevel = true
            if (args.verbose) {
                log.level = 'verbose'
            } else if (args.silent || args.level === 'silent') {
                log.silent = true
            } else {
                log.level = args.level ?? 'info'
            }
        }
    }

    /**
     * Gets the directories to scan for files.
     */
    protected getScanDirectories(): string[] {
        if (this.subdirectories.length === 0) {
            return [this.inDirectory]
        }

        const scanDirs = []
        for (const dirname of this.subdirectories) {
            scanDirs.push(path.join(this.inDirectory, dirname))
        }

        return scanDirs
    }
}
