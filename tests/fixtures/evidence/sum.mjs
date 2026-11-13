import { readFileSync } from 'node:fs'

const [, , file, field] = process.argv
const rows = readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line) => line.split(','))
const column = rows[0].indexOf(field)
const total = rows.slice(1).reduce((sum, row) => sum + Number(row[column]), 0)
process.stdout.write(`${total}\n`)
