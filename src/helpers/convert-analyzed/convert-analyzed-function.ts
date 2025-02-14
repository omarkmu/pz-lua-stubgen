import { AnalyzedFunction } from '../../analysis'
import { RosettaFunction } from '../../rosetta'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { convertAnalyzedParameters } from './convert-analyzed-parameters'
import { convertAnalyzedReturns } from './convert-analyzed-returns'

export const convertAnalyzedFunction = (
    func: AnalyzedFunction,
    mergeFunc?: RosettaFunction,
    keepTypes?: boolean,
    applyHeuristics?: boolean,
): RosettaFunction => {
    const rosettaFunc: RosettaFunction = {
        name: func.name,
        deprecated: mergeFunc?.deprecated,
        notes: mergeFunc?.notes,
        tags: mergeFunc?.tags,
        parameters: convertAnalyzedParameters(
            func.parameters,
            mergeFunc?.parameters,
            keepTypes,
            applyHeuristics,
        ),
        return: convertAnalyzedReturns(
            func.returnTypes,
            mergeFunc?.return,
            keepTypes,
        ),
        overloads: mergeFunc?.overloads,
    }

    return removeUndefinedOrEmpty(rosettaFunc)
}
