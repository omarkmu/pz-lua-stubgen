import path from 'path'
import { BaseReportArgs } from './types'
import { log } from '../logger'
import { Base } from './Base'
import { outputFile } from '../helpers'

/**
 * Base class for classes that report on information about Lua.
 */
export abstract class BaseReporter extends Base {
    protected outFile: string | undefined
    protected fileSet: Set<string>

    constructor(args: BaseReportArgs) {
        super(args)
        this.fileSet = new Set()

        this.outFile = args.outputFile
            ? path.normalize(args.outputFile)
            : undefined
    }

    /**
     * Outputs a report object to an output file or the console.
     */
    protected async outputReport(report: object) {
        const json = JSON.stringify(
            report,
            (_, value) => (value instanceof Set ? [...value] : value),
            this.outFile ? 2 : undefined,
        )

        if (this.outFile) {
            const outFile = this.outFile.endsWith('.json')
                ? this.outFile
                : path.join(this.outFile, 'report.json')

            try {
                await outputFile(outFile, json)
                log.info(`Report generated at ${path.resolve(outFile)}`)
            } catch (e) {
                log.error(`Failed to create file '${outFile}': ${e}`)
            }
        } else {
            console.log(json)
        }
    }

    /**
     * Resets the state of the reporter.
     */
    protected resetState() {
        this.fileSet.clear()
    }
}
