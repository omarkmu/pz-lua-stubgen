import { log } from '../logger'

export const time = async <T>(
    taskName: string,
    task: () => Promise<T>,
    getMessage?: (result: T, time: number) => string | undefined,
): Promise<T> => {
    const start = performance.now()
    const result = await task()
    const time = performance.now() - start

    let message = getMessage ? getMessage(result, time) : undefined
    message ??= `Finished ${taskName} in ${time.toFixed(0)}ms`

    log.verbose(message)

    return result
}
