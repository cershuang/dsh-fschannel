// Smoke test: renderFinalCard splits prose/tables/code and builds structured cards.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractImageRefs, renderFinalCardWithImages, renderFinalCard, renderPlainCard, splitSegments, parseTable } from '../lib/render.js'

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

{
  // ── fence run length ──────────────────────────────────────────────────
  // CommonMark: a closing fence is the same character, AT LEAST as long as the
  // opener, and carries no info string. The close test used to hard-code length
  // three, which broke both directions.
  const BT = String.fromCharCode(96)
  const f3 = BT.repeat(3)
  const f4 = BT.repeat(4)

  const kindsOf = (text) => splitSegments(text).map((s) => s.kind).join(',')

  // T1 — a longer opener is not closed by a shorter inner fence.
  const t1 = ['Intro', f4 + 'md', f3 + 'js', 'code()', f3, f4, 'Tail'].join('\n')
  if (kindsOf(t1) !== 'prose,code,prose') throw new Error('T1 run-length close: ' + kindsOf(t1))

  // T2 — a longer closer DOES close a shorter opener; the tail stays prose.
  const t2 = ['Intro', f3 + 'js', 'code()', f4, 'Tail'].join('\n')
  const t2segs = splitSegments(t2)
  if (t2segs[t2segs.length - 1].text !== 'Tail') throw new Error('T2 tail swallowed: ' + JSON.stringify(t2segs))

  // T3 (guard) — an info string may NOT close a fence, so ```js inside ```md is
  // content. A rewrite that relaxed the closer to startsWith would break this.
  const t3 = ['Intro', f3 + 'md', 'text', f3 + 'js', 'code()', f3, f3, 'Tail'].join('\n')
  if (kindsOf(t3) !== 'prose,code,code') throw new Error('T3 info-string rule: ' + kindsOf(t3))
  if (!splitSegments(t3)[1].text.includes(f3 + 'js')) throw new Error('T3 inner fence was treated as a closer')

  // ── table detection must not run inside invisible code regions ────────────
  // These blocks are deliberately NOT segmented (Feishu renders them fine, and
  // splitting them would tear the list apart) — they only suppress tables.

  // T4 — a fence indented inside a list item.
  const t4 = ['- example:', '  ' + f3 + 'markdown', '  | a | b |', '  |---|---|', '  | 1 | 2 |', '  ' + f3, '- next'].join('\n')
  if (renderFinalCard(t4).body.elements.filter((e) => e.tag === 'table').length !== 0) {
    throw new Error('T4 table promoted inside an indented fence')
  }

  // T5 — a 4-space indented code block.
  const t5 = ['Code:', '', '    | a | b |', '    |---|---|', '    | 1 | 2 |', '', 'done'].join('\n')
  if (renderFinalCard(t5).body.elements.filter((e) => e.tag === 'table').length !== 0) {
    throw new Error('T5 table promoted inside a 4-space indented block')
  }

  // T6 (guard) — a flush-left fence still suppresses tables AND stays one block.
  const t6 = ['Example:', f3 + 'markdown', '| a | b |', '|---|---|', '| 1 | 2 |', f3, 'next'].join('\n')
  if (renderFinalCard(t6).body.elements.filter((e) => e.tag === 'table').length !== 0) {
    throw new Error('T6 table promoted inside a flush-left fence')
  }
  if (kindsOf(t6) !== 'prose,code,prose') throw new Error('T6 flush-left block was split: ' + kindsOf(t6))

  // T7 (guard) — a real table still becomes a table element.
  const t7 = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
  if (renderFinalCard(t7).body.elements.filter((e) => e.tag === 'table').length !== 1) {
    throw new Error('T7 a genuine table stopped being promoted')
  }

  // ── renderPlainCard must respect the limit this module declares ───────────
  const plain = renderPlainCard('z'.repeat(100000))
  if (plain.body.elements[0].content.length > 30000) {
    throw new Error('T11 renderPlainCard exceeds MARKDOWN_MAX_CHARS: ' + plain.body.elements[0].content.length)
  }

}

// ── oversized tables degrade to markdown, never truncate ──────────────────
{
  const header = ['| a | b |', '|---|---|']
  const bigRows = []
  for (let n = 0; n < 5000; n += 1) bigRows.push(`| r${n} | v${n} |`)
  const big = header.concat(bigRows).join(String.fromCharCode(10))
  const bigCard = renderFinalCard(big)
  if (bigCard.body.elements.some((e) => e.tag === 'table')) {
    throw new Error('a 5000-row table was still emitted as a card table')
  }
  // Degrade, do not truncate: every row must still be in the markdown.
  const text = bigCard.body.elements.map((e) => e.content).join('')
  if (!text.includes('r4999')) throw new Error('oversized table lost rows instead of degrading')
  if (!text.includes('r0')) throw new Error('oversized table lost its first row')

  // A normal table is untouched — the cap must not catch ordinary answers.
  const smallRows = []
  for (let n = 0; n < 199; n += 1) smallRows.push(`| r${n} | v${n} |`)
  const small = renderFinalCard(header.concat(smallRows).join(String.fromCharCode(10)))
  if (small.body.elements.filter((e) => e.tag === 'table').length !== 1) {
    throw new Error('a 199-row table was wrongly degraded')
  }
}

console.log('RENDER FENCE + SUPPRESSION OK')
console.log('RENDER TABLE CAP OK')

// ── image embedding in final cards ─────────────────────────────────────────
{
  const dir = fileURLToPath(new URL('../.tmp-render-img', import.meta.url))
  mkdirSync(dir, { recursive: true })
  const imgPath = join(dir, 'chart.png')
  writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))

  // extractImageRefs: finds alt + src, keeps raw span.
  const refs = extractImageRefs('看这张图：![趋势图](chart.png) 和 ![外链](https://x/y.png)')
  if (refs.length !== 2) throw new Error('refs: ' + refs.length)
  if (refs[0].alt !== '趋势图' || refs[0].src !== 'chart.png') throw new Error('ref[0] fields')
  if (refs[1].src !== 'https://x/y.png') throw new Error('ref[1] src')

  let uploaded = 0
  const io = {
    uploadImage: async (buffer) => { uploaded += 1; return 'img_key_' + uploaded },
    resolveSrc: (src) => (src === 'chart.png' ? imgPath : undefined),
  }

  // Local file -> embedded img element, syntax removed from prose.
  const text = '结论：\n\n![趋势图](chart.png)\n\n完毕。'
  const { card, embedded } = await renderFinalCardWithImages(text, io)
  if (embedded !== 1) throw new Error('embedded: ' + embedded)
  const tags = card.body.elements.map((e) => e.tag)
  if (!tags.includes('img')) throw new Error('no img element')
  const imgEl = card.body.elements.find((e) => e.tag === 'img')
  if (imgEl.img_key !== 'img_key_1') throw new Error('img_key')
  if (imgEl.alt.content !== '趋势图') throw new Error('alt: ' + JSON.stringify(imgEl.alt))
  const mdContent = card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n')
  if (mdContent.includes('![')) throw new Error('markdown image syntax left in prose: ' + mdContent)
  if (!mdContent.includes('结论')) throw new Error('prose lost: ' + mdContent)
  // Images come after the text elements.
  if (card.body.elements[card.body.elements.length - 1].tag !== 'img') throw new Error('img not last')

  // Remote URL -> not embedded, alt kept as plain text.
  const remote = await renderFinalCardWithImages('![外链](https://x/y.png) 说明', io)
  if (remote.embedded !== 0) throw new Error('remote embedded')
  const remoteText = remote.card.body.elements.map((e) => e.content ?? '').join('')
  if (!remoteText.includes('外链')) throw new Error('remote alt lost: ' + remoteText)
  if (remoteText.includes('https://x/y.png')) throw new Error('remote URL leaked into card: ' + remoteText)

  // Missing file -> reference dropped, prose survives.
  const missing = await renderFinalCardWithImages('![没了](gone.png) 剩下', io)
  if (missing.embedded !== 0) throw new Error('missing embedded')
  const missingText = missing.card.body.elements.map((e) => e.content ?? '').join('')
  if (!missingText.includes('剩下')) throw new Error('missing prose lost')

  // Text that is ONLY images -> bare image card.
  const bare = await renderFinalCardWithImages('![图](chart.png)', io)
  if (bare.embedded !== 1 || bare.card.body.elements.some((e) => e.tag !== 'img')) {
    throw new Error('bare image card wrong: ' + JSON.stringify(bare.card.body.elements.map((e) => e.tag)))
  }

  rmSync(dir, { recursive: true, force: true })
  console.log('RENDER IMAGE EMBED OK')
}
