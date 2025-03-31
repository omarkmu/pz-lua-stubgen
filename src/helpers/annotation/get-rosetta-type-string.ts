export const getRosettaTypeString = (
    type: string | undefined,
    optional: boolean | undefined,
    nullable?: boolean,
): string => {
    type = (type ?? 'unknown').trim()

    if (optional || nullable) {
        return type.includes('|') ? `(${type})?` : `${type}?`
    }

    return type
}
