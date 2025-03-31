import { AnalyzedFunction } from '../../analysis'
import { RosettaFunction } from '../../rosetta'
import { convertRosettaParameters } from './convert-rosetta-parameters'
import { convertRosettaReturns } from './convert-rosetta-returns'

export const convertRosettaFunction = (
    func: RosettaFunction,
    isMethod?: boolean,
): AnalyzedFunction => {
    return {
        name: func.name,
        parameters: convertRosettaParameters(func.parameters),
        returnTypes: convertRosettaReturns(func.return),
        isMethod,
    }
}
