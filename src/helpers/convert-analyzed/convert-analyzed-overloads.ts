import { AnalyzedFunction } from '../../analysis'
import { RosettaOverload } from '../../rosetta'
import { convertAnalyzedParameters } from './convert-analyzed-parameters'
import { convertAnalyzedReturns } from './convert-analyzed-returns'

export const convertAnalyzedOverloads = (
    overloads: AnalyzedFunction[],
    mergeOverloads?: RosettaOverload[],
): RosettaOverload[] => {
    if (mergeOverloads) {
        return mergeOverloads
    }

    return overloads.map((x) => {
        const overload: RosettaOverload = {}

        if (x.parameters.length > 0) {
            overload.parameters = convertAnalyzedParameters(x.parameters)
        }

        if (x.returnTypes.length > 0) {
            overload.return = convertAnalyzedReturns(x.returnTypes)
        }

        return overload
    })
}
