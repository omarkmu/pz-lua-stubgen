import { AnalyzedFunction } from '../../analysis'
import { RosettaFunction } from '../../rosetta'
import { convertAnalyzedFunction } from './convert-analyzed-function'

export const convertAnalyzedFunctions = (
    functions: AnalyzedFunction[],
    mergeFunctions?: Record<string, RosettaFunction>,
    keepTypes?: boolean,
): RosettaFunction[] => {
    const converted = functions.map((x) =>
        convertAnalyzedFunction(x, mergeFunctions?.[x.name], keepTypes),
    )

    if (!mergeFunctions) {
        return converted
    }

    const seen = new Set(converted.map((x) => x.name))
    for (const [name, func] of Object.entries(mergeFunctions)) {
        if (!seen.has(name)) {
            converted.push(func)
        }
    }

    return converted
}
