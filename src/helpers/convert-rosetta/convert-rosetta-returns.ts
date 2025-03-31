import { RosettaReturn } from '../../rosetta'
import { convertRosettaTypes } from './convert-rosetta-types'

export const convertRosettaReturns = (
    returns: RosettaReturn[] | undefined,
): Set<string>[] => {
    if (!returns) {
        return []
    }

    return returns.map((x): Set<string> => {
        return convertRosettaTypes(x.type, x.nullable)
    })
}
