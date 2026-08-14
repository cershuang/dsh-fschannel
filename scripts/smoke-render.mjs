// Smoke test: renderFinalCard splits prose/tables/code and builds structured cards.
import { renderFinalCard, renderPlainCard, splitSegments, parseTable } from '../lib/render.js'

const sample = [
  '分析结果如下：',
  '',
  '| 模型 | 速度 | 质量 |',
  '|---|---|---|',
  '| deepseek-v4-flash | 快 | 良好 |',
  '| deepseek-v4-pro | 中 | 优秀 |',
  '',
  '示例代码：',
  '```js',
  'console.log("hi")',
  '```',
  '',
  '**结论**：推荐 v4-pro。',
].join('\n')

const segs = splitSegments(sample)
const kinds = segs.map((s) => s.kind).join(',')
console.log('segments:', kinds)
if (kinds !== 'prose,table,prose,code,prose') throw new Error('segment split wrong: ' + kinds)

const table = parseTable(segs[1].text)
if (table.columns.length !== 3) throw new Error('columns: ' + table.columns.length)
if (table.columns[0].name !== 'c0' || table.columns[0].display_name !== '模型') throw new Error('column meta')
if (table.rows.length !== 2) throw new Error('rows: ' + table.rows.length)
if (table.rows[0].c2 !== '良好') throw new Error('cell value')

const card = renderFinalCard(sample)
if (card.schema !== '2.0') throw new Error('schema')
const tags = card.body.elements.map((e) => e.tag).join(',')
console.log('card elements:', tags)
if (!tags.includes('table')) throw new Error('no table element')
if (!tags.includes('markdown')) throw new Error('no markdown element')
if (card.body.elements.filter((e) => e.tag === 'table').length !== 1) throw new Error('table count')

// Escaped pipes in cells must survive.
const tricky = '| a | b |\n|---|---|\n| x\\|y | z |'
const t2 = parseTable(tricky)
if (t2.rows[0].c0 !== 'x|y') throw new Error('escaped pipe: ' + JSON.stringify(t2.rows[0]))

// Empty text -> undefined; plain fallback works.
if (renderFinalCard('   ') !== undefined) throw new Error('empty text')
const plain = renderPlainCard('**x**')
if (plain.body.elements.length !== 1 || plain.body.elements[0].tag !== 'markdown') throw new Error('plain card')
console.log('RENDER SMOKE OK')
