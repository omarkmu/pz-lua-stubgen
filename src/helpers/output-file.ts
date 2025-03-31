import fs from 'fs'
import path from 'path'

export const outputFile = async (outFile: string, content: string) => {
    await fs.promises.mkdir(path.dirname(outFile), {
        recursive: true,
    })

    await fs.promises.writeFile(outFile, content, { flag: 'w' })
}
