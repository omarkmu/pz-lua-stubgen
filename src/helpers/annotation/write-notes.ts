export const writeNotes = (
    notes: string | undefined,
    out: string[],
    tab: string = '',
) => {
    if (!notes) {
        return
    }

    const lines = notes.replaceAll('\r', '').trim().split('\n')
    for (const line of lines) {
        out.push(`\n${tab}---${line}`)
    }
}
