import { getAliases } from './get-aliases'

/**
 * Gets a mapping of files to potential aliases for requiring them.
 */
export const getAliasMap = (
    fileSet: Iterable<string>,
): Map<string, Set<string>> => {
    const aliasMap = new Map<string, Set<string>>()
    for (const identifier of fileSet) {
        for (const alias of getAliases(identifier)) {
            let aliasSet = aliasMap.get(alias)
            if (!aliasSet) {
                aliasSet = new Set()
                aliasMap.set(alias, aliasSet)
            }

            aliasSet.add(identifier)
        }
    }

    return aliasMap
}
