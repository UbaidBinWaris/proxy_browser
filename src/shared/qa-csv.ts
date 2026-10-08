import { QaDatasetSchema } from './qa'

/** Small bounded CSV reader for dataset imports, including quoted commas/newlines and escaped quotes. */
export function parseDatasetCsv(text: string) {
  if (text.length > 1024 * 1024) throw new Error('CSV imports are limited to 1 MB.')
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    endedQuote = false
  const input = text.replace(/^\uFEFF/, '')
  const finishField = (): void => {
    row.push(field)
    field = ''
    endedQuote = false
  }
  const finishRow = (): void => {
    finishField()
    if (row.some((value) => value !== '')) rows.push(row)
    row = []
    if (rows.length > 101) throw new Error('Use at most 100 dataset rows.')
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          endedQuote = true
        }
      } else field += char
    } else if (char === '"' && !field && !endedQuote) quoted = true
    else if (char === ',') finishField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++
      finishRow()
    } else {
      if (endedQuote || char === '"') throw new Error('Malformed CSV quoting.')
      field += char
    }
    if (field.length > 10000 || row.length > 51)
      throw new Error('CSV fields or column count exceed the dataset limits.')
  }
  if (quoted) throw new Error('Unclosed CSV quote.')
  if (field || endedQuote || row.length) finishRow()
  const headers = rows.shift()?.map((header) => header.trim())
  if (!headers?.length || !rows.length || new Set(headers).size !== headers.length)
    throw new Error('Provide unique column headers and at least one data row.')
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`)
    const variables = Object.fromEntries(headers.flatMap((key, i) => (key === '_name' ? [] : [[key, cells[i]!]])))
    return QaDatasetSchema.parse({
      id: `row-${index + 1}`,
      name: headers.includes('_name') ? cells[headers.indexOf('_name')] : `Row ${index + 1}`,
      variables,
    })
  })
}
