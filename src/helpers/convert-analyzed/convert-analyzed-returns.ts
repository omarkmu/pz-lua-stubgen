import { RosettaReturn } from '../../rosetta'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { convertAnalyzedTypes } from './convert-analyzed-types'

export const convertAnalyzedReturns = (
    returns: Set<string>[],
    mergeReturns?: RosettaReturn[],
    keepTypes?: boolean,
): RosettaReturn[] => {
    return returns.map((x, i): RosettaReturn => {
        const ret: RosettaReturn = {}
        const mergeRet = mergeReturns?.[i]
        const [type, nullable] = convertAnalyzedTypes(x)

        if (mergeRet && keepTypes) {
            ret.type = mergeRet.type ?? type ?? 'unknown'
            ret.nullable = mergeRet.nullable
        } else {
            ret.type = type ?? 'unknown'
            ret.nullable = nullable ? true : undefined
        }

        ret.notes = mergeRet?.notes

        return removeUndefinedOrEmpty(ret)
    })
}
