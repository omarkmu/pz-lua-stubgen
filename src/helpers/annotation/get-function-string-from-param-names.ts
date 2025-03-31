export const getFunctionStringFromParamNames = (
    name: string | undefined,
    parameters: string[],
): string => {
    const params = parameters.join(', ')

    if (name) {
        return `function ${name}(${params}) end`
    }

    return `function(${params}) end`
}
