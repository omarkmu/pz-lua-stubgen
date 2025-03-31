import { AnalyzedParameter } from '../../analysis'
import { getTypeString } from './get-type-string'

export const getFunctionPrefix = (
    parameters?: AnalyzedParameter[],
    returns?: Set<string>[],
    allowAmbiguous: boolean = true,
    tabLevel: number = 0,
): string | undefined => {
    const tabs = '    '.repeat(tabLevel)

    const out = []

    parameters ??= []
    for (const param of parameters) {
        const typeString = getTypeString(param.types, allowAmbiguous)
        if (typeString === 'unknown') {
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

        out.push(`---@return ${getTypeString(ret, allowAmbiguous)}`)
    }

    return out.join('')
}
