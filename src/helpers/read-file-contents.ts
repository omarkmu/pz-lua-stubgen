import fs from 'fs'

/**
 * Reads the contents of a file, assuming UTF-8 encoding.
 */
export const readFileContents = async (filePath: string): Promise<string> => {
    let file: fs.promises.FileHandle | undefined
    try {
        file = await fs.promises.open(filePath, 'r')
        return await file.readFile('utf-8')
    } finally {
        await file?.close()
    }
}
