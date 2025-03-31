import { AnalyzedFunction } from '../../analysis'
import { RosettaFunction } from '../../rosetta'
import { convertRosettaFunction } from './convert-rosetta-function'

export const convertRosettaFunctions = (
    functions: Record<string, RosettaFunction> | undefined,
    isMethod?: boolean,
): AnalyzedFunction[] => {
    if (!functions) {
        return []
    }

    return Object.values(functions).map((x) =>
        convertRosettaFunction(x, isMethod),
    )
}
