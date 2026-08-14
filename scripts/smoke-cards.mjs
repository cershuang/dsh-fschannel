// Card module unit test.
import { buildModelCard, parseActionValue, effortOptions, MODEL_CARD_INTENT, isBareKeyword } from '../lib/cards.js'

const current = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
const groups = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' } },
  ],
}]

const card = buildModelCard({ sessionId: 'sess-1', current, groups })
if (card.header.template !== 'blue') throw new Error('header')
const [modelRow, effortRow] = card.elements.filter((e) => e.tag === 'action')
if (modelRow.actions.length !== 2) throw new Error('model buttons: ' + modelRow.actions.length)
if (modelRow.actions[0].type !== 'primary') throw new Error('active model not primary')
if (modelRow.actions[0].text.content !== 'Flash') throw new Error('label: ' + modelRow.actions[0].text.content)
if (effortRow.actions.length !== 3) throw new Error('effort buttons')
if (effortRow.actions[1].type !== 'primary') throw new Error('active effort not primary')
if (effortRow.actions[2].value.effort !== 'max') throw new Error('effort value')

const parsed = parseActionValue(modelRow.actions[1].value)
if (parsed.kind !== 'dsh-fschannel/model' || parsed.model !== 'deepseek-v4-pro' || parsed.sessionId !== 'sess-1') throw new Error('parse')
if (parseActionValue({ kind: 'other' }) !== undefined) throw new Error('foreign value accepted')
if (effortOptions(groups[0].models[0]).join(',') !== 'off,high,max') throw new Error('effortOptions')

// Intent matching.
const hits = ['调整模型', '切换模型', '换模型', '把effort调一下', '当前模型是什么', 'model', '推理等级', '思考强度调成max']
const misses = ['帮我写个模型评估报告', '今天天气怎么样', '模型训练完成了吗']
for (const t of hits) {
  if (!(MODEL_CARD_INTENT.test(t) || isBareKeyword(t))) throw new Error('should hit: ' + t)
}
for (const t of misses) {
  if (MODEL_CARD_INTENT.test(t) || isBareKeyword(t)) throw new Error('should miss: ' + t)
}
console.log('CARD TESTS OK')
