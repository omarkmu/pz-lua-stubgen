import { AnalyzedFunction } from '../../analysis'
import { RosettaOverload } from '../../rosetta'
import { convertRosettaParameters } from './convert-rosetta-parameters'
import { convertRosettaReturns } from './convert-rosetta-returns'

export const convertRosettaOverloads = (
    overloads: RosettaOverload[] | undefined,
): AnalyzedFunction[] => {
    if (!overloads) {
        return []
    }

    return overloads.map((x) => {
        return {
            name: 'overload',
            parameters: convertRosettaParameters(x.parameters),
            returnTypes: convertRosettaReturns(x.return),
        }
    })
}
