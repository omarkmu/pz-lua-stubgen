export const convertRosettaTypes = (
    type: string | undefined,
    nullable: boolean | undefined,
) => {
    const types = new Set<string>()
    if (type) {
        types.add(type)
    }

    if (nullable) {
        types.add('nil')
    }

    return types
}
