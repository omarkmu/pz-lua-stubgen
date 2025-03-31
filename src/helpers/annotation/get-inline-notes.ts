export const getInlineNotes = (notes: string): string => {
    return notes.trim().replaceAll('\r', '').replaceAll('\n', '<br>')
}
