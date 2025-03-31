import { AnalyzedFunction } from '../../analysis'
import { RosettaConstructor } from '../../rosetta'
import { convertRosettaParameters } from './convert-rosetta-parameters'
import { convertRosettaTypes } from './convert-rosetta-types'

export const convertRosettaConstructors = (
    constructors: RosettaConstructor[] | undefined,
    clsName: string,
): AnalyzedFunction[] => {
    if (!constructors) {
        return []
    }

    return constructors.map((x): AnalyzedFunction => {
        return {
            name: 'new',
            parameters: convertRosettaParameters(x.parameters),
            returnTypes: [convertRosettaTypes(clsName, false)],
            isMethod: true,
            isConstructor: true,
        }
    })
}
