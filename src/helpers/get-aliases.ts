/**
 * Gets potential aliases for a file identifier for requiring.
 */
export const getAliases = (identifier: string): string[] => {
    const aliases: string[] = []

    let slash = identifier.indexOf('/')
    while (slash !== -1) {
        identifier = identifier.slice(slash + 1)
        slash = identifier.indexOf('/')
        aliases.push(identifier)
    }

    return aliases
}
